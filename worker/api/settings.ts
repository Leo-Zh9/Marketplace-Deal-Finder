/**
 * The two settings handlers. They return a RESULT, never a Response: worker/index.ts owns
 * securityHeaders, the CORS header and the error body, so a handler cannot ship a reply that
 * forgot one. That is structural, not a convention.
 */

import { validateSettings } from "../evaluation/dealRules";
import type { DealMode, EvaluationSettings } from "../evaluation/types";
import {
  loadCurrentSettings,
  updateSearchSettings,
  type SearchSettingsInput,
} from "../search/settings";

export interface SettingsReadBody {
  settings: EvaluationSettings | null;
}
export interface SettingsWriteBody extends SettingsReadBody {
  changed: boolean;
}

export type SettingsResult =
  | { ok: true; status: 200; body: SettingsReadBody | SettingsWriteBody }
  | { ok: false; status: number; code: string; details?: Record<string, unknown> };

/**
 * The legitimate payload is ~100 bytes.
 *
 * WHAT THIS BOUNDS: the parser and the echo -- JSON.parse never sees more than this, and the
 * `fields` list in a SETTINGS_FIELD_UNSUPPORTED body cannot exceed it.
 *
 * WHAT IT DOES NOT BOUND: what reaches the isolate. MEASURED: a body sent as a ReadableStream
 * carries NO Content-Length, so the declared check below is skipped and `request.text()`
 * buffers the whole thing before the byte check can fire. Refusing that earlier means reading
 * the body as a stream and counting as it arrives; it is not done here because the only caller
 * who can reach this line is an already-authenticated, already-approved operator spending
 * their own isolate. Do not read the comment as a memory guarantee, because it is not one.
 */
export const MAX_SETTINGS_BODY_BYTES = 4096;

/** EXACTLY the three columns search_revisions has. Anything else is refused, never dropped. */
const ACCEPTED_FIELDS = new Set(["mode", "minimumDiscountPercent", "maximumPriceCents"]);

const MODES: readonly DealMode[] = ["DISCOUNT", "MAXIMUM_PRICE", "BOTH"];

const fail = (status: number, code: string): SettingsResult => ({ ok: false, status, code });

/** Absent and explicit null are the same thing; anything that is not a number is a shape error. */
const readOptionalNumber = (
  value: unknown,
): { ok: true; value: number | null } | { ok: false } => {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "number") return { ok: true, value };
  return { ok: false };
};

export const handleGetSettings = async (db: D1Database): Promise<SettingsResult> => {
  try {
    const current = await loadCurrentSettings(db);
    return { ok: true, status: 200, body: { settings: current.settings } };
  } catch {
    return fail(503, "SETTINGS_STORAGE_FAILED");
  }
};

export const handlePutSettings = async (
  request: Request,
  db: D1Database,
  now: number,
): Promise<SettingsResult> => {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return fail(415, "UNSUPPORTED_MEDIA_TYPE");

  // The DECLARED size, refused before the body is pulled into the isolate.
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_SETTINGS_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE");
  }

  // The MEASURED size. Content-Length is a claim: absent on a chunked body, and a lie is free.
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SETTINGS_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(400, "INVALID_JSON");
  }
  const body = parsed as Record<string, unknown>;

  // REFUSED, NOT DROPPED. Phase 5's documented payload also carries components, models,
  // location, radiusKm and dealRule; search_revisions has nowhere to put them. A 200 that
  // silently stored three of eight fields is a false "saved".
  const unsupported = Object.keys(body).filter((key) => !ACCEPTED_FIELDS.has(key)).sort();
  if (unsupported.length > 0) {
    return {
      ok: false,
      status: 400,
      code: "SETTINGS_FIELD_UNSUPPORTED",
      details: { fields: unsupported },
    };
  }

  // SHAPE here, MEANING in validateSettings. No range, no per-mode requirement, no integer
  // check in this file -- those belong to the merged validator and duplicating them here
  // would be a second authority that can drift.
  // `find` rather than a typeof guard plus an includes: the membership test already refuses
  // every non-string, and it narrows to DealMode without a cast. Two checks here would mean
  // one of them was never the reason anything was rejected.
  const mode = MODES.find((candidate) => candidate === body.mode);
  if (mode === undefined) return fail(400, "INVALID_SETTINGS");
  const percent = readOptionalNumber(body.minimumDiscountPercent);
  const cents = readOptionalNumber(body.maximumPriceCents);
  if (!percent.ok || !cents.ok) return fail(400, "INVALID_SETTINGS");

  const input: SearchSettingsInput = {
    mode,
    minimumDiscountPercent: percent.value,
    maximumPriceCents: cents.value,
  };

  // The merged validator, run here ONLY to classify: past this point a throw out of
  // updateSearchSettings is an infrastructure failure, not bad input, so the two cannot be
  // reported alike. revision 0 is a placeholder -- every other check is revision-independent,
  // and updateSearchSettings still runs its own validation before any write.
  try {
    validateSettings({ ...input, searchRevision: 0 });
  } catch {
    return fail(400, "INVALID_SETTINGS");
  }

  // SETTINGS_STORAGE_FAILED BELOW HAS THREE OCCUPANTS. Only the first is what the message says.
  //
  // (1) A real storage outage -- D1 unreachable, the batch rejected. Transient, retry helps.
  //
  // (2) A CORRUPT LIVE ROW, which is PERMANENT and which this API can never repair. MEASURED:
  //     `INSERT INTO search_revisions VALUES (0,'MAXIMUM_PRICE',NULL,60000.5,1)` -- the
  //     runbook's own hand-written bootstrap -- passes `CHECK (maximum_price_cents >= 0)`,
  //     because SQLite INTEGER is AFFINITY, not a type. updateSearchSettings validates the LIVE
  //     ROW before comparing, so the jam fires exactly when the stored value fails
  //     `Number.isSafeInteger` -- not merely when it is fractional. MEASURED, both halves:
  //     60000.5 stores as typeof 'real' and jams; 9007199254740993.0 stores as typeof
  //     'integer', is SILENTLY ROUNDED to 9007199254740992, and jams too; 60000.0 stores as
  //     typeof 'integer' and does NOT jam. Once jammed, every subsequent PUT lands here, in
  //     EVERY mode -- a mode change does not escape it -- while GET happily returns 200 with
  //     the corrupt value. No new error code for it: the state is unreachable through this API
  //     and a status 5D must handle for it would be a contract for a case 5D cannot cause. The
  //     repair is one statement and is in docs/phase-5a-settings-api.md.
  //
  // (3) A CONCURRENT PUT, which is transient and cured by a retry. MEASURED: two parallel PUTs
  //     answer one 200 and one 503, with exactly one row written, the pointer on it and no
  //     corruption; the same PUT twice -- a double-clicked save button -- does the same. The
  //     race is inside merged updateSearchSettings (read revision -> compute next -> INSERT on
  //     that PK) and its batch rolls back cleanly, so nothing here can fix it and nothing here
  //     needs to. 5D: debounce the save, and treat a 503 on PUT as safe to retry.
  try {
    const applied = await updateSearchSettings(db, { ...input, now });
    // Re-read rather than echo the input: the response then reports what IS STORED, including
    // the fields the mode made inert and dropped. The cost is named: if this re-read throws
    // after the write committed, the caller gets 503 while the row IS written. The retry is
    // idempotent and answers changed:false, so it self-heals -- but that one response lies.
    const current = await loadCurrentSettings(db);
    return { ok: true, status: 200, body: { settings: current.settings, changed: applied.changed } };
  } catch {
    return fail(503, "SETTINGS_STORAGE_FAILED");
  }
};
