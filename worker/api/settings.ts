/**
 * The two settings handlers: ONE USER'S DEAL RULE (migrations/0009). They return a RESULT, never a
 * Response: worker/index.ts owns securityHeaders, the CORS header and the error body, so a handler
 * cannot ship a reply that forgot one. That is structural, not a convention.
 *
 * THIS FILE NO LONGER WRITES search_settings OR search_revisions. Those are the frozen internal
 * DISCOUNT evidence rule the drain evaluates under; a user's rule lives on their `users` row and is
 * applied at read and notify time (worker/evaluation/rulePredicate.ts). A rule change therefore
 * re-opens no task -- it stamps `users.alerts_reopened_at`, which is what lets the deals the new rule
 * qualifies alert (worker/notify/enqueue.ts).
 */

import { validateSettings } from "../evaluation/dealRules";
import type { DealMode } from "../evaluation/types";
import type { User, UserRule } from "../users/users";

/** The wire shape is unchanged from the single-user API, minus the evidence rule's revision. */
export interface WireRule {
  mode: DealMode;
  minimumDiscountPercent: number | null;
  maximumPriceCents: number | null;
}

export interface SettingsReadBody {
  settings: WireRule | null;
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

/** EXACTLY the three fields a rule has. Anything else is refused, never dropped. */
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

/**
 * basis points / 100 is EXACT for all 10,001 legal values (search/settings.ts measured it through a
 * REAL column), so the percent on the wire is the one that was applied.
 */
export const wireRule = (rule: UserRule | null): WireRule | null =>
  rule === null
    ? null
    : {
        mode: rule.mode,
        minimumDiscountPercent: rule.minimumDiscountBp === null ? null : rule.minimumDiscountBp / 100,
        maximumPriceCents: rule.maximumPriceCents,
      };

/** The caller's row was read by provisioning in this request, so GET costs no further read. */
export const handleGetSettings = (user: User): SettingsResult => ({
  ok: true,
  status: 200,
  body: { settings: wireRule(user.rule) },
});

/**
 * One statement, scoped to the caller, returning what IS STORED. `alerts_reopened_at` moves only on
 * a REAL change -- the single-user API bumped the revision (and so re-judged every task) only then.
 * ?1 mode, ?2 bp, ?3 max, ?4 now, ?5 user_id, ?6 1 when the rule changed.
 */
const UPDATE_RULE = `UPDATE users
   SET mode = ?1, minimum_discount_bp = ?2, maximum_price_cents = ?3,
       alerts_reopened_at = CASE WHEN ?6 = 1 THEN ?4 ELSE alerts_reopened_at END
 WHERE user_id = ?5
RETURNING mode, minimum_discount_bp, maximum_price_cents`;

interface RuleRow {
  mode: DealMode;
  minimum_discount_bp: number | null;
  maximum_price_cents: number | null;
}

export const handlePutSettings = async (
  request: Request,
  db: D1Database,
  user: User,
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
  //
  // THE TRY/CATCH IS WHAT KEEPS THE HEADER COMMENT TRUE. This is the only REJECTABLE await on
  // the request path in this Worker: a client that disconnects mid-PUT, or any body-stream
  // error, rejects here. Unwrapped, it throws out of handleRequest and the runtime answers a
  // bare 500 carrying none of securityHeaders, no Vary, no Access-Control-Allow-Origin and no
  // error envelope -- the one reply that could escape the guarantee this module claims to
  // enforce structurally. A truncated body is not a JSON object, so it is reported as one.
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(400, "INVALID_JSON");
  }
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

  // The merged validator, and the PROJECTION it applies is what is stored: 4.35 and
  // 4.350000000000001 are the same 435 basis points, and the field a mode ignores is dropped.
  // revision 0 is a placeholder -- every check is revision-independent.
  let next;
  try {
    next = validateSettings({
      mode,
      minimumDiscountPercent: percent.value,
      maximumPriceCents: cents.value,
      searchRevision: 0,
    });
  } catch {
    return fail(400, "INVALID_SETTINGS");
  }
  const live = user.rule;
  const changed =
    live === null ||
    live.mode !== next.mode ||
    live.minimumDiscountBp !== next.basisPoints ||
    live.maximumPriceCents !== next.maximumPriceCents;

  // SETTINGS_STORAGE_FAILED is a storage outage. The 0009 CHECKs mirror validateSettings, so a
  // validated projection cannot fail them; the single-user API's "corrupt live row jams every PUT"
  // occupant (docs/phase-5a-settings-api.md) is gone with the read-before-write it came from.
  try {
    const written = await db
      .prepare(UPDATE_RULE)
      .bind(next.mode, next.basisPoints, next.maximumPriceCents, now, user.userId, changed ? 1 : 0)
      .all<RuleRow>();
    const row = written.results[0];
    if (row === undefined) return fail(503, "SETTINGS_STORAGE_FAILED");
    return {
      ok: true,
      status: 200,
      body: {
        settings: wireRule({
          mode: row.mode,
          minimumDiscountBp: row.minimum_discount_bp,
          maximumPriceCents: row.maximum_price_cents,
        }),
        changed,
      },
    };
  } catch {
    return fail(503, "SETTINGS_STORAGE_FAILED");
  }
};
