/**
 * THE COLLECTOR'S HEALTH, WRITTEN BY THE COLLECTOR AND READ BY THE PAGE.
 *
 * `POST /api/collector-health` is on the collector credential, exactly as `/api/listings` and
 * `/api/watch-targets` are and for the same reason: a headless `node collector/main.ts` on the
 * operator's Mac is neither the loopback development identity nor a Firebase ID token on
 * APPROVED_EMAILS. `readCollectorHealth` is called from `GET /api/status`, which is behind
 * `authenticateRequest` like every other browser route.
 *
 * WHAT THIS REPLACES, AND IT IS THE REASON THE SLICE TOUCHES THIS FILE AT ALL. `/api/status` was
 * `{status: "ok", phase: 2, authentication}` -- a hardcoded literal that answered "ok" when
 * collection had been dead for a week, with a `phase` that had been stale for two phases. An
 * alerting slice that left it alone would have shipped a second, louder lie than the one it
 * exists to kill.
 *
 * IT RETURNS A RESULT, NEVER A Response: worker/index.ts owns securityHeaders, `Vary` and the
 * error envelope, exactly as worker/api/settings.ts, worker/api/listings.ts and
 * worker/api/watchTargets.ts do, so a handler cannot ship a reply that forgot one.
 *
 * THERE IS DELIBERATELY NO worker/storage/collectorHealth.ts. The worker/search/ <-> worker/api/
 * split exists because `loadCurrentSettings` has a SECOND caller; this has one writer and one
 * reader, both in this file, and two statements between them. THE TRIGGER FOR SPLITTING IT IS A
 * SECOND CALLER -- a scheduled path that reads collector health, say -- not file size.
 */

/**
 * 45 MINUTES, AND IT IS INHERITED RATHER THAN INVENTED. `docs/collector-ingest.md`'s shipped
 * terminal check already uses `if age > 45`, and two staleness bounds in one product (45 in the
 * terminal, 90 on the page) is precisely the "second authority that can drift" this codebase
 * names repeatedly. The cadence is 30 minutes, so 45 admits one skipped window and refuses two.
 *
 * AGAINST THE REAL HISTORY: ZERO `stale` REPORTS ACROSS 51 INTERVALS -- min gap 9.7 min, max
 * 30.1, none above 35, over 24.7 h.
 *
 * WHAT THAT RESULT DOES AND DOES NOT MEASURE, STATED AT THE WIDTH IT WAS ACTUALLY MEASURED AT.
 * `caffeinate -dimsu` has held this Mac awake continuously since Mon 14 Sep 09:07:31 with no
 * `-t`, against `pmset` idle sleep of 1 minute on BOTH AC and battery. It is tempting to
 * conclude from that alone that the bound only ever measured a machine that could not sleep --
 * AND THE FULL `pmset -g log` REFUTES THAT. The long lid-closed periods on this machine are
 * `Entering DarkWake ... 'Clamshell Sleep' ... Using AC`: 858 min on 09-28, 768 on 09-30, 643 on
 * 10-01 and 766 on 10-03 (02:28:54 to 15:14:54 local). THE LAST ONE IS INSIDE THE LOG WINDOW,
 * and across it 26 of 26 expected runs fired, max gap 30.1 min, min 29.9. The three real
 * `Entering Sleep state` transitions in the 8-day history are ALL ON BATTERY and all short.
 *
 * SO THE BOUND SURVIVED A 12 h 46 m CLOSED LID ON AC -- which is the overnight case -- and the
 * UNTESTED case is narrower than "every morning": lid closed ON BATTERY, where
 * `StartCalendarInterval` coalesces the missed windows into one run on wake.
 *
 * THAT NARROWING IS NOT PEDANTRY, AND THE WIDER CLAIM WAS A REAL HAZARD. "Expect stale every
 * morning" is an argument for softening the stale badge -- and that badge is the one signal that
 * must catch the job genuinely not being loaded, which is how this project already shipped
 * "evaluation is running" over 498 dead cron runs. An overstated benign-case frequency erodes
 * the signal that matters.
 *
 * THE MITIGATIONS ARE KEPT EITHER WAY, because they are right either way and cost nothing: the
 * badge's HEADLINE is the timestamp, `ageMinutes` and `reportedAt` are always present, and every
 * `degraded` clause OUTRANKS `stale` so a latched alarm behind a closed lid never reads as the
 * benign cause. H-9 (constructed clock -- the gate cannot wait 46 minutes) and H-10 are the
 * guards.
 */
export const COLLECTOR_STALE_MINUTES = 45;

/** The 4 KiB the settings route uses; the legitimate payload is ~120 bytes. */
export const MAX_HEALTH_BODY_BYTES = 4096;

/**
 * EXACTLY the seven fields the collector sends, which are exactly the columns `collector_health`
 * stores minus `reported_at`. Anything else is REFUSED, never dropped -- the idiom
 * `worker/api/settings.ts` and `worker/api/listings.ts` both use, and here it is what keeps a
 * `reportedAt` from the collector out of the one value the whole page hangs on.
 */
const ACCEPTED_FIELDS = new Set([
  "exitCode",
  "complete",
  "canary",
  "dryRun",
  "fixture",
  "targets",
  "alarms",
]);

/** The run line's `alarms` can hold a cause per target plus three reports; 64 is ~4x that. */
const MAX_ALARMS = 64;
const MAX_ALARM_LENGTH = 200;

export type CollectorHealthResult =
  | { ok: true; status: 200; body: { stored: true } }
  | { ok: false; status: number; code: string; details?: Record<string, unknown> };

/** What `GET /api/status` reports about collection, beside the authentication method. */
export interface CollectorStatusBody {
  status: "ok" | "stale" | "degraded" | "unknown";
  /**
   * WHICHEVER `degraded` CLAUSES FIRED, as a set rather than a sequence. The five clauses are
   * not ordered against each other, so the badge is a badge and no detail depends on which one
   * the implementation happened to test first.
   */
  causes: string[];
  /** ALWAYS PRESENT, including on `unknown`, so the page's headline never has to be absent. */
  reportedAt: number;
  ageMinutes: number;
  collector: {
    exitCode: number;
    complete: boolean;
    canary: boolean;
    dryRun: boolean;
    fixture: boolean;
    targets: number;
    alarms: string[];
  } | null;
}

const fail = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
): CollectorHealthResult =>
  details === undefined ? { ok: false, status, code } : { ok: false, status, code, details };

/**
 * ONE UPSERT ON A SINGLETON ROW. `ON CONFLICT(id) DO UPDATE`, never a plain INSERT: the second
 * run of the day would answer 503 on a UNIQUE violation and the page would keep showing the
 * first run forever. H-1 is the guard.
 */
const UPSERT = `INSERT INTO collector_health
    (id, reported_at, exit_code, complete, canary, dry_run, fixture, targets, alarms)
  VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT(id) DO UPDATE SET
    reported_at = ?1, exit_code = ?2, complete = ?3, canary = ?4,
    dry_run = ?5, fixture = ?6, targets = ?7, alarms = ?8`;

const SELECT = `SELECT reported_at, exit_code, complete, canary, dry_run, fixture, targets, alarms
  FROM collector_health WHERE id = 1`;

interface HealthRow {
  reported_at: number;
  exit_code: number;
  complete: number;
  canary: number;
  dry_run: number;
  fixture: number;
  targets: number;
  alarms: string;
}

const isBoundedInteger = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

export const handlePostCollectorHealth = async (
  request: Request,
  db: D1Database,
  now: number,
): Promise<CollectorHealthResult> => {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return fail(415, "UNSUPPORTED_MEDIA_TYPE");

  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_HEALTH_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE");
  }

  // A client that disconnects mid-POST rejects here. Unwrapped it throws out of handleRequest as
  // a bare 500 carrying none of securityHeaders, no Vary and no error envelope -- the one reply
  // that could escape the guarantee this module's header claims to enforce structurally.
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_HEALTH_BODY_BYTES) {
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

  // REFUSED, NOT DROPPED. `JSON.parse` makes "__proto__" an OWN key, so this loop refuses it; a
  // caller cannot smuggle a field past the whitelist by naming it after something on
  // Object.prototype. The field this matters most for is `reportedAt`, which is the server's.
  for (const key of Object.keys(body)) {
    if (!ACCEPTED_FIELDS.has(key)) {
      return fail(400, "INVALID_COLLECTOR_HEALTH", { field: key });
    }
  }

  if (!isBoundedInteger(body.exitCode, 255)) {
    return fail(400, "INVALID_COLLECTOR_HEALTH", { field: "exitCode" });
  }
  if (!isBoundedInteger(body.targets, 1000)) {
    return fail(400, "INVALID_COLLECTOR_HEALTH", { field: "targets" });
  }
  for (const field of ["complete", "canary", "dryRun", "fixture"] as const) {
    if (typeof body[field] !== "boolean") {
      return fail(400, "INVALID_COLLECTOR_HEALTH", { field });
    }
  }

  /**
   * THE ARRAY IS VALIDATED HERE AND NOT LEFT TO THE COLUMN'S `LIKE '[%]'` CHECK, AND THE
   * DIFFERENCE IS WHICH ERROR CODE THE OPERATOR GETS. `JSON.stringify("boom")` is `"boom"`,
   * which fails the CHECK and surfaces as 503 COLLECTOR_HEALTH_STORAGE_FAILED -- i.e. "D1 is
   * broken, wait" for a defect whose fix is a collector deploy. Two fixes behind one code sends
   * an operator to the wrong one, which is the rule the three *_STORAGE_FAILED codes already
   * record. H-4 is the guard.
   */
  const alarms = body.alarms;
  if (!Array.isArray(alarms) || alarms.length > MAX_ALARMS) {
    return fail(400, "INVALID_COLLECTOR_HEALTH", { field: "alarms" });
  }
  for (const alarm of alarms) {
    if (typeof alarm !== "string" || alarm.length === 0 || alarm.length > MAX_ALARM_LENGTH) {
      return fail(400, "INVALID_COLLECTOR_HEALTH", { field: "alarms" });
    }
  }

  try {
    await db
      .prepare(UPSERT)
      .bind(
        // THE SERVER'S CLOCK. See `RunHealthReport` in collector/postRunHealth.ts for why the
        // wire has no field for this at all.
        now,
        body.exitCode,
        body.complete ? 1 : 0,
        body.canary ? 1 : 0,
        body.dryRun ? 1 : 0,
        body.fixture ? 1 : 0,
        body.targets,
        JSON.stringify(alarms),
      )
      .run();
  } catch {
    // A DISTINCT CODE, not INGEST_STORAGE_FAILED or SETTINGS_STORAGE_FAILED: three different
    // fixes behind one code sends an operator to the wrong one. H-5 pins the string.
    return fail(503, "COLLECTOR_HEALTH_STORAGE_FAILED");
  }

  return { ok: true, status: 200, body: { stored: true } };
};

/**
 * `alarms` IS READ BACK DEFENSIVELY, AND AN UNREADABLE COLUMN FAILS TOWARD `degraded`.
 *
 * MEASURED DEFECT THIS FIXES: returning `[]` on a parse failure made the page read
 * `status: "ok", causes: []` over a row that was REPORTING A REFUSAL. The column's own
 * `alarms LIKE '[%]'` CHECK accepts `[refused:gpu-rtx]` -- unquoted, so not JSON -- which is
 * precisely the shape a hand-written `wrangler d1 execute` produces, and this repository
 * documents such a writer corrupting `search_revisions` once already. Silence was then
 * indistinguishable from health, in the one function whose job is to tell those two apart.
 *
 * `readable` IS FALSE IF ANYTHING WAS DROPPED, not only if the parse threw: an array with a
 * number in it has LOST an alarm, and a lost alarm must not read as no alarm.
 */
const readAlarms = (raw: string): { alarms: string[]; readable: boolean } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { alarms: [], readable: false };
  }
  if (!Array.isArray(parsed)) return { alarms: [], readable: false };
  const alarms = parsed.filter((entry): entry is string => typeof entry === "string");
  return { alarms, readable: alarms.length === parsed.length };
};

/**
 * THE STATUS WORD IS THE FIRST OF THESE THAT APPLIES, AND THE PRECEDENCE IS ONE RULING:
 *
 *   unknown   the DB is unbound, or the read threw, or there is no row, or reported_at === 0
 *   degraded  dry_run | fixture | exit_code !== 0 | complete === false | alarms.length > 0
 *   stale     reported_at older than COLLECTOR_STALE_MINUTES
 *   ok
 *
 * `unknown > degraded > stale > ok`, AND THE TWO ORDERINGS INSIDE IT ARE BOTH LOAD-BEARING.
 *
 * `degraded` ABOVE `stale` (H-10): a latched alarm on a ten-day-old row must not read as the
 * benign "the Mac was asleep" cause. The alarm is the thing the operator has to act on.
 *
 * DRY-RUN ABOVE `stale` (H-6, invariant 3): a punctual dry-run collector can never read `ok`,
 * and a dry-run collector that then stopped must not read `stale` either -- "stale" reads as a
 * broken cron, whereas `dry_run:1` says WHY nothing is being collected.
 *
 * THE FOUR-CONJUNCT DEFINITION IS PARITY WITH THE SHIPPED RUNBOOK, NOT A FRESH DERIVATION.
 * `docs/collector-ingest.md` already ships it in bold: "Healthy is recent AND `complete:true`
 * AND `exitCode:0` AND `dryRun:false`." Keeping only recency and dry-run -- the obvious subset
 * -- would let a persistent exit 6 after a contract-breaking deploy store NOTHING indefinitely
 * while this endpoint said `"ok"`. That is the exact `{status:"ok", phase:2}` shape this slice
 * exists to kill, and the log already holds a real instance of a 6. H-11 and H-12 are the
 * guards.
 *
 * A MISSING `DB` IS 200 `unknown`, NEVER 503. The one endpoint that reports health must not go
 * dark exactly when something is wrong, and both pre-existing `/api/status` tests build
 * environments with no `DB` at all. REJECTED: `DATABASE_UNAVAILABLE` 503, as `/api/settings`
 * uses -- that route's caller can retry a save; this one's caller is asking whether anything is
 * collecting. H-8.
 */
export const readCollectorHealth = async (
  db: D1Database | undefined,
  now: number,
): Promise<CollectorStatusBody> => {
  const unknown: CollectorStatusBody = {
    status: "unknown",
    causes: [],
    reportedAt: 0,
    ageMinutes: 0,
    collector: null,
  };

  // UNREADABLE IS NOT "NEVER REPORTED". A missing binding or a throwing read means this endpoint
  // cannot see the row, so it says so; the panel must not tell the user no run has reported when
  // it simply could not look. H-8.
  const unreadable: CollectorStatusBody = { ...unknown, causes: ["status-unreadable"] };

  if (db === undefined) return unreadable;

  let row: HealthRow | undefined;
  try {
    const read = await db.prepare(SELECT).all<HealthRow>();
    row = read.results[0];
  } catch {
    return unreadable;
  }

  // THE SEEDED ROW IS `unknown`, NEVER `stale`. Without this branch a freshly migrated database
  // reports an age of roughly 29,000,000 minutes and the page claims the collector died in 1970.
  if (row === undefined || row.reported_at === 0) return unknown;

  const { alarms, readable } = readAlarms(row.alarms);
  const collector = {
    exitCode: row.exit_code,
    complete: row.complete === 1,
    canary: row.canary === 1,
    dryRun: row.dry_run === 1,
    fixture: row.fixture === 1,
    targets: row.targets,
    alarms,
  };

  // A SET, NOT A SEQUENCE. Every clause that fired contributes, so the page can name all of them.
  const causes: string[] = [];
  if (collector.dryRun) causes.push("dry-run");
  if (collector.fixture) causes.push("fixture");

  if (collector.exitCode !== 0) causes.push(`exit-code:${collector.exitCode}`);
  // `canary` WHEN THE CUT IS ENGAGED, `incomplete` OTHERWISE. The canary is a FEATURE of the
  // guard -- a probe reports `complete:false` by design -- and telling the operator that seven of
  // their searches silently vanished is precisely the confusion the two-clause run-line invariant
  // exists to make unrepresentable. H-12 pins both halves.
  if (!collector.complete) causes.push(collector.canary ? "canary" : "incomplete");
  causes.push(...alarms);
  // A SYNTHETIC CAUSE, so an unreadable column reads as `degraded` rather than as `ok`. It is
  // pushed LAST because the alarms that WERE readable are the actionable ones; this says the
  // list may be short. The panel names it in words.
  if (!readable) causes.push("alarms-unreadable");

  // FLOORED SECONDS, so the boundary is reproducible: `docs/collector-ingest.md`'s check is
  // `age > 45`, so exactly 45 minutes is still `ok` and 46 is `stale`.
  const ageMinutes = Math.floor((now - row.reported_at) / 60);

  return {
    status:
      causes.length > 0 ? "degraded" : ageMinutes > COLLECTOR_STALE_MINUTES ? "stale" : "ok",
    causes,
    reportedAt: row.reported_at,
    ageMinutes,
    collector,
  };
};
