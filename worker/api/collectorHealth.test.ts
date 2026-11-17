// @vitest-environment node

import {
  COLLECTOR_STALE_MINUTES,
  handlePostCollectorHealth,
  MAX_HEALTH_BODY_BYTES,
  readCollectorHealth,
} from "./collectorHealth";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";

const now = 1_800_000_000;

/** The body the collector actually sends, so each test states only what it is about. */
const body = (over: Record<string, unknown> = {}) => ({
  exitCode: 0,
  complete: true,
  canary: false,
  dryRun: false,
  fixture: false,
  targets: 9,
  alarms: [],
  ...over,
});

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request("https://worker.example/api/collector-health", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(database.db);
});

/** The stored row, as D1 holds it. */
const stored = async () => {
  const read = await database.db
    .prepare("SELECT * FROM collector_health")
    .all<Record<string, unknown>>();
  return read.results;
};

/** Insert a health row directly, which is how the read side is driven at a chosen clock. */
const seed = async (over: Record<string, unknown> = {}) => {
  const row = {
    reported_at: now,
    exit_code: 0,
    complete: 1,
    canary: 0,
    dry_run: 0,
    fixture: 0,
    targets: 9,
    alarms: "[]",
    ...over,
  };
  await database.db
    .prepare(
      `INSERT INTO collector_health
         (id, reported_at, exit_code, complete, canary, dry_run, fixture, targets, alarms)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET
         reported_at = ?1, exit_code = ?2, complete = ?3, canary = ?4,
         dry_run = ?5, fixture = ?6, targets = ?7, alarms = ?8`,
    )
    .bind(
      row.reported_at,
      row.exit_code,
      row.complete,
      row.canary,
      row.dry_run,
      row.fixture,
      row.targets,
      row.alarms,
    )
    .run();
};

/** A D1 that rejects on contact, for the two storage-failure rows. */
const brokenDb = () =>
  ({
    prepare: () => ({
      bind: () => ({ run: async () => Promise.reject(new Error("no such table: collector_health")) }),
      all: async () => Promise.reject(new Error("no such table: collector_health")),
    }),
  }) as unknown as D1Database;

describe("the collector health row", () => {
  /**
   * H-1: THE WRITE IS AN UPSERT -- TWO POSTS LEAVE ONE ROW.
   *
   * THE MUTATION IS A PLAIN `INSERT`, which answers 503 on the SECOND run of the day (UNIQUE
   * constraint on the primary key) and leaves the page showing the first run of the day forever.
   * The second row's values are asserted, not just the count: an `INSERT OR IGNORE` would also
   * leave one row, and it would be the STALE one.
   */
  it("H-1: two posts leave exactly one row, carrying the SECOND report", async () => {
    const first = await handlePostCollectorHealth(post(body()), database.db, now);
    expect(first).toEqual({ ok: true, status: 200, body: { stored: true } });

    const second = await handlePostCollectorHealth(
      post(body({ exitCode: 3, complete: false, targets: 7 })),
      database.db,
      now + 1800,
    );
    expect(second.ok).toBe(true);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      reported_at: now + 1800,
      exit_code: 3,
      complete: 0,
      targets: 7,
    });
  });

  /**
   * H-2: `reported_at` IS THE SERVER'S CLOCK.
   *
   * THE MUTATION IS READING IT FROM THE BODY. Freshness is the single most load-bearing value on
   * the page -- it is what catches the job genuinely not being loaded, which is how this project
   * shipped "evaluation is running" over 498 dead cron runs -- and a laptop whose clock is wrong
   * would report itself permanently fresh. The body has no field for it AT ALL, so the mutation
   * also has to add one, which H-3 then refuses.
   */
  it("H-2: reported_at is the server's now, and a body that tries to set it is refused", async () => {
    await handlePostCollectorHealth(post(body()), database.db, now);
    expect((await stored())[0].reported_at).toBe(now);

    const smuggled = await handlePostCollectorHealth(
      post(body({ reportedAt: 1 })),
      database.db,
      now,
    );
    expect(smuggled).toEqual({
      ok: false,
      status: 400,
      code: "INVALID_COLLECTOR_HEALTH",
      details: { field: "reportedAt" },
    });
    // ...and the refusal wrote nothing.
    expect((await stored())[0].reported_at).toBe(now);
  });

  /**
   * H-3: UNKNOWN BODY FIELDS ARE REFUSED, NOT DROPPED -- the `ACCEPTED_FIELDS` idiom
   * `worker/api/settings.ts` and `worker/api/listings.ts` both use.
   *
   * THE MUTATION IS DROPPING THE CHECK, which answers 200 where 400 is expected: a collector
   * sending a field this route has nowhere to put would be told "stored" about data that went
   * nowhere. `__proto__` is included because `JSON.parse` makes it an OWN key, so a caller
   * cannot smuggle a field past the whitelist by naming it after something on Object.prototype.
   */
  it.each<[string, Record<string, unknown>]>([
    ["reportedAt", { reportedAt: 1 }],
    ["a typo'd field", { dry_run: true }],
    ["something invented", { lastError: "boom" }],
    ["__proto__", JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>],
  ])("H-3: a body carrying %s is 400, not 200", async (_label, extra) => {
    const result = await handlePostCollectorHealth(post(body(extra)), database.db, now);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400, code: "INVALID_COLLECTOR_HEALTH" });
    expect(await stored()).toHaveLength(0);
  });

  /**
   * H-4: `alarms` MUST BE AN ARRAY OF NON-EMPTY STRINGS, AND A BAD ONE IS 400 -- NEVER 503.
   *
   * THE MUTATION IS `JSON.stringify` ON AN UNVALIDATED VALUE. `JSON.stringify("boom")` is
   * `"boom"`, which fails the column's `alarms LIKE '[%]'` CHECK and surfaces as 503
   * COLLECTOR_HEALTH_STORAGE_FAILED -- i.e. "D1 is broken, wait" for a defect whose fix is a
   * collector deploy. TWO FIXES BEHIND ONE CODE sends an operator to the wrong one, which is the
   * rule the three *_STORAGE_FAILED codes already record.
   *
   * The numeric-array row is the sharper one: `JSON.stringify([1,2])` is `[1,2]`, which PASSES
   * the CHECK -- so the column alone cannot refuse it and the page would render `1` as a cause
   * name. MEASURED: `[oops` is refused by the CHECK but `[oops]` is not, which is the exact
   * width of what that CHECK buys.
   */
  it.each<[string, unknown]>([
    ["a bare string", "boom"],
    ["an object", {}],
    ["null", null],
    ["an array of numbers", [1, 2]],
    ["an array with an empty string", [""]],
    ["an array with a nested array", [["a"]]],
  ])("H-4: alarms as %s is 400 naming the field", async (_label, alarms) => {
    const result = await handlePostCollectorHealth(post(body({ alarms })), database.db, now);

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: "INVALID_COLLECTOR_HEALTH",
      details: { field: "alarms" },
    });
    expect(await stored()).toHaveLength(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["exitCode as a string", { exitCode: "0" }],
    ["exitCode fractional", { exitCode: 0.5 }],
    ["exitCode negative", { exitCode: -1 }],
    ["targets as a string", { targets: "9" }],
    ["complete as a number", { complete: 1 }],
    ["canary as a string", { canary: "false" }],
    ["dryRun missing", { dryRun: undefined }],
  ])("H-4b: %s is 400, not a stored row", async (_label, over) => {
    const payload = body(over);
    if (over.dryRun === undefined && "dryRun" in over) delete (payload as Record<string, unknown>).dryRun;

    const result = await handlePostCollectorHealth(post(payload), database.db, now);

    expect(result).toMatchObject({ status: 400, code: "INVALID_COLLECTOR_HEALTH" });
    expect(await stored()).toHaveLength(0);
  });

  it.each<[string, Request]>([
    ["a non-JSON content type", new Request("https://worker.example/api/collector-health", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })],
  ])("H-4c: %s is 415", async (_label, request) => {
    await expect(handlePostCollectorHealth(request, database.db, now)).resolves.toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it.each<[string, string, number, string]>([
    ["a body that is not JSON", "{not json", 400, "INVALID_JSON"],
    ["a JSON array", "[]", 400, "INVALID_JSON"],
    ["a JSON string", '"hello"', 400, "INVALID_JSON"],
  ])("H-4d: %s is %i %s", async (_label, raw, status, code) => {
    await expect(handlePostCollectorHealth(post(raw), database.db, now)).resolves.toMatchObject({
      status,
      code,
    });
  });

  /**
   * H-4e: THE BODY CAP, AND THE SIZE IS A LITERAL RATHER THAN DERIVED FROM THE CONSTANT.
   *
   * MEASURED: the first version built the payload as `"x".repeat(MAX_HEALTH_BODY_BYTES)`, which
   * made the test SELF-FULFILLING -- raising the constant to 4,000,000 also grew the payload to
   * 4,000,000 and the 413 still fired, so the mutation SURVIVED. A test whose expectation is
   * derived from the input the code reads is not a test of that input.
   *
   * 5,000 is a literal above the shipped 4,096 and below any plausible raise. The row below it
   * is the other side of the same boundary, so a cap moved in either direction goes red.
   */
  it("H-4e: a 5,000-byte body is 413 and stores nothing", async () => {
    const payload = JSON.stringify({ ...body(), alarms: ["x".repeat(4_900)] });
    expect(payload.length).toBeGreaterThan(4_096);

    await expect(handlePostCollectorHealth(post(payload), database.db, now)).resolves.toMatchObject(
      { status: 413, code: "PAYLOAD_TOO_LARGE" },
    );
    expect(await stored()).toHaveLength(0);
  });

  it("H-4f: the shipped cap is 4 KiB and a legitimate ~130-byte report is nowhere near it", () => {
    expect(MAX_HEALTH_BODY_BYTES).toBe(4096);
    expect(JSON.stringify(body()).length).toBeLessThan(200);
  });

  /**
   * H-4g: THE THREE REMAINING BOUNDS, each of which SURVIVED a mutation until this row existed.
   * None of them is reachable from a correct collector, which is exactly why nothing else
   * exercised them -- and the caller here is a bearer secret with no human behind it, which is
   * the reason `worker/api/listings.ts` gives for bounding this route's input at all.
   */
  it.each<[string, Record<string, unknown>]>([
    ["65 alarms, one over MAX_ALARMS", { alarms: Array.from({ length: 65 }, (_v, i) => `c:${i}`) }],
    ["an alarm of 201 characters", { alarms: ["x".repeat(201)] }],
    ["an exit code of 256", { exitCode: 256 }],
    ["a target count of 1001", { targets: 1001 }],
  ])("H-4g: %s is 400, not a stored row", async (_label, over) => {
    const result = await handlePostCollectorHealth(post(body(over)), database.db, now);

    expect(result).toMatchObject({ status: 400, code: "INVALID_COLLECTOR_HEALTH" });
    expect(await stored()).toHaveLength(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["64 alarms, exactly MAX_ALARMS", { alarms: Array.from({ length: 64 }, (_v, i) => `c:${i}`) }],
    ["an alarm of 200 characters", { alarms: ["x".repeat(200)] }],
    ["an exit code of 255", { exitCode: 255 }],
    ["a target count of 1000", { targets: 1000 }],
  ])("H-4g: %s is accepted, so the bound is not off by one", async (_label, over) => {
    const result = await handlePostCollectorHealth(post(body(over)), database.db, now);

    expect(result.ok).toBe(true);
  });

  /**
   * H-5: A D1 FAILURE IS 503 WITH ITS OWN CODE.
   *
   * THE MUTATION IS REUSING `INGEST_STORAGE_FAILED`, and the failure shape is the code string
   * itself: an operator reading "the listings could not be stored" on a health POST goes looking
   * at the ingest route and the listings table. Three different fixes behind one code sends an
   * operator to the wrong one.
   */
  it("H-5: a storage failure is 503 COLLECTOR_HEALTH_STORAGE_FAILED", async () => {
    await expect(handlePostCollectorHealth(post(body()), brokenDb(), now)).resolves.toEqual({
      ok: false,
      status: 503,
      code: "COLLECTOR_HEALTH_STORAGE_FAILED",
    });
  });

  /* ---------- the read side, which is what /api/status serves ---------- */

  it("the happy path is ok, with the timestamp and the age", async () => {
    await seed({ reported_at: now - 10 * 60 });

    await expect(readCollectorHealth(database.db, now)).resolves.toEqual({
      status: "ok",
      causes: [],
      reportedAt: now - 600,
      ageMinutes: 10,
      collector: {
        exitCode: 0,
        complete: true,
        canary: false,
        dryRun: false,
        fixture: false,
        targets: 9,
        alarms: [],
      },
    });
  });

  /**
   * H-11: A PERSISTENT EXIT 6 AT A FRESH TIMESTAMP IS `degraded`, AND THE CAUSE NAMES THE CODE.
   *
   * THE MUTATION IS DROPPING THE `exit_code` CLAUSE, and its failure shape is `status: "ok"` --
   * which is the EXACT `{status:"ok", phase:2}` lie this slice exists to kill, rebuilt in the
   * slice that kills it. It is not hypothetical: the real log holds an exit 6, and a
   * contract-breaking Worker deploy stores NOTHING indefinitely while every run is punctual.
   *
   * `complete` IS TRUE IN THIS ROW ON PURPOSE. With `complete:false` the `complete` clause would
   * also fire and the row could not tell the two clauses apart -- which is the whole point of
   * carrying both columns.
   */
  it("H-11: exit_code 6 at a fresh timestamp is degraded, naming the code", async () => {
    await seed({ exit_code: 6, complete: 1, reported_at: now - 60 });

    const result = await readCollectorHealth(database.db, now);

    expect(result.status).toBe("degraded");
    expect(result.causes).toEqual(["exit-code:6"]);
    expect(result.ageMinutes).toBe(1);
  });

  /**
   * H-12: `complete:false` IS `degraded`, AND THE CAUSE DISTINGUISHES A CANARY FROM A GAP.
   *
   * THE MUTATION IS DROPPING THE `complete` CLAUSE (the `canary:0` row then reads `ok` on a run
   * that silently dropped searches), OR COLLAPSING THE TWO CAUSES INTO ONE ("incomplete" where
   * "canary" belongs). The second half matters because a probe reports `complete:false` BY
   * DESIGN: telling the operator that seven of their searches vanished is precisely the
   * confusion the two-clause run-line invariant exists to make unrepresentable.
   */
  it.each<[string, number, string]>([
    ["a run that dropped targets", 0, "incomplete"],
    ["a probe run", 1, "canary"],
  ])("H-12: complete:false on %s is degraded naming %s", async (_label, canary, cause) => {
    await seed({ complete: 0, canary, exit_code: 0, reported_at: now - 60 });

    const result = await readCollectorHealth(database.db, now);

    expect(result.status).toBe("degraded");
    expect(result.causes).toEqual([cause]);
  });

  /**
   * H-6: DRY-RUN AND FIXTURE OUTRANK STALENESS. INVARIANT 3.
   *
   * THE MUTATION IS MOVING STALENESS ABOVE THEM, and the ten-day row is the one that goes red:
   * it reads `stale`, which reads as "the Mac was asleep" or "the cron is broken" -- so the page
   * would blame the laptop for a collector that is deliberately collecting nothing. `dry_run:1`
   * says WHY.
   */
  it.each<[string, number, Record<string, unknown>, string]>([
    ["dry-run, punctual", 60, { dry_run: 1 }, "dry-run"],
    ["dry-run, ten days old", 10 * 24 * 3600, { dry_run: 1 }, "dry-run"],
    ["fixture, punctual", 60, { fixture: 1 }, "fixture"],
    ["fixture, ten days old", 10 * 24 * 3600, { fixture: 1 }, "fixture"],
  ])("H-6: %s is degraded naming %s, never stale", async (_label, age, over, cause) => {
    await seed({ reported_at: now - age, ...over });

    const result = await readCollectorHealth(database.db, now);

    expect(result.status).toBe("degraded");
    expect(result.status).not.toBe("stale");
    expect(result.causes).toContain(cause);
    // THE AGE IS STILL REPORTED, which is what keeps the badge's headline the timestamp.
    expect(result.ageMinutes).toBe(Math.floor(age / 60));
  });

  /**
   * H-10: AN ALARM OUTRANKS STALENESS.
   *
   * THE MUTATION IS MOVING STALENESS ABOVE ALARMS, which reports `stale` on a collector that is
   * pinned at 2 of 9 searches by a latched feed guard -- the benign every-closed-lid reading for
   * the one state the operator has to act on. The alarm strings are carried through verbatim so
   * the page can name the pair.
   */
  it("H-10: a latched feed alarm on a ten-day-old row is degraded, never stale", async () => {
    await seed({
      reported_at: now - 10 * 24 * 3600,
      complete: 0,
      canary: 1,
      alarms: JSON.stringify(["feed-overlap:gpu-radeon+gpu-rtx"]),
    });

    const result = await readCollectorHealth(database.db, now);

    expect(result.status).toBe("degraded");
    expect(result.causes).toEqual(["canary", "feed-overlap:gpu-radeon+gpu-rtx"]);
    expect(result.collector?.alarms).toEqual(["feed-overlap:gpu-radeon+gpu-rtx"]);
  });

  /**
   * H-7: THE SEEDED ROW IS `unknown`, NEVER `stale`.
   *
   * THE MUTATION IS DELETING THE `=== 0` BRANCH, under which a freshly migrated database reports
   * `ageMinutes` of roughly 29,000,000 and `stale` -- the page would claim the collector died in
   * 1970, on an install where it has simply never run.
   */
  it("H-7: reported_at 0 is unknown with collector null, not a 55-year-old stale row", async () => {
    await seed({ reported_at: 0 });

    await expect(readCollectorHealth(database.db, now)).resolves.toEqual({
      status: "unknown",
      causes: [],
      reportedAt: 0,
      ageMinutes: 0,
      collector: null,
    });
  });

  // H-7b: A READABLE TABLE WITH NO ROW IS "never reported", NOT "unreadable" -- the read worked,
  // so `causes` stays empty and the panel says no run has reported yet (H-8 is the other side).
  it("H-7b: no row at all is unknown too, with no causes", async () => {
    await expect(readCollectorHealth(database.db, now)).resolves.toEqual({
      status: "unknown",
      causes: [],
      reportedAt: 0,
      ageMinutes: 0,
      collector: null,
    });
  });

  /**
   * H-8: A MISSING `DB` IS `unknown`, AND A THROWING READ IS TOO -- NEVER AN ERROR.
   *
   * THE MUTATION IS `errorResponse("DATABASE_UNAVAILABLE", 503)`, as `/api/settings` and
   * `/api/watch` both do. It is the wrong answer HERE and only here: the one endpoint that
   * reports health must not go dark exactly when something is wrong, and both pre-existing
   * `/api/status` tests build environments with no `DB` at all. The signature takes
   * `D1Database | undefined` so the caller has nothing to guard with.
   */
  it.each<[string, D1Database | undefined]>([
    ["an unbound DB", undefined],
    ["a read that threw", brokenDb()],
  ])("H-8: %s is unknown with status-unreadable, not an error", async (_label, db) => {
    // THE CAUSE IS WHAT TELLS THE PANEL "could not read" APART FROM "never reported" (H-7, H-7b).
    await expect(readCollectorHealth(db, now)).resolves.toEqual({
      status: "unknown",
      causes: ["status-unreadable"],
      reportedAt: 0,
      ageMinutes: 0,
      collector: null,
    });
  });

  /**
   * H-9: 44 MINUTES IS `ok` AND 46 IS `stale`.
   *
   * THE MUTATION IS 45 -> 90, under which the 46-minute row reads `ok`. 45 is INHERITED, not
   * invented: `docs/collector-ingest.md`'s shipped terminal check already uses `if age > 45`,
   * and two staleness bounds in one product is the second authority that drifts.
   *
   * UNIT ONLY, AND THE CLOCK IS CONSTRUCTED. `npm run e2e:local` cannot wait 46 minutes, so no
   * process-layer test can see this boundary; `now` is passed in precisely so it is reachable
   * here. The exact-45 row is what pins the comparison as `>` rather than `>=`.
   */
  it.each<[string, number, string]>([
    ["44 minutes", 44, "ok"],
    ["exactly 45 minutes", 45, "ok"],
    ["46 minutes", 46, "stale"],
    ["six hours", 360, "stale"],
  ])("H-9: a row %s old is %s", async (_label, minutes, status) => {
    await seed({ reported_at: now - minutes * 60 });

    const result = await readCollectorHealth(database.db, now);

    expect(result.status).toBe(status);
    expect(result.ageMinutes).toBe(minutes);
    // THE DETAIL IS PRESENT ON BOTH, so the page's headline never depends on the word.
    expect(result.reportedAt).toBe(now - minutes * 60);
    expect(result.collector).not.toBeNull();
  });

  it("H-9b: the shipped bound is 45 minutes, which is the runbook's own number", () => {
    expect(COLLECTOR_STALE_MINUTES).toBe(45);
  });

  /**
   * THE WHOLE LOOP, END TO END: the body the collector sends, through the real handler, into real
   * local D1, and back out of the real read. It is what catches a column name that two halves of
   * this file disagree about -- neither H-1 nor the read rows above would see that on their own,
   * because each builds its own SQL.
   */
  it("the posted report is the report the read serves back", async () => {
    const result = await handlePostCollectorHealth(
      post(
        body({
          exitCode: 3,
          complete: false,
          canary: true,
          dryRun: false,
          fixture: true,
          targets: 9,
          alarms: ["source-empty:mobo-toronto", "canary-expired"],
        }),
      ),
      database.db,
      now - 120,
    );
    expect(result.ok).toBe(true);

    const read = await readCollectorHealth(database.db, now);

    expect(read).toEqual({
      status: "degraded",
      causes: [
        "fixture",
        "exit-code:3",
        "canary",
        "source-empty:mobo-toronto",
        "canary-expired",
      ],
      reportedAt: now - 120,
      ageMinutes: 2,
      collector: {
        exitCode: 3,
        complete: false,
        canary: true,
        dryRun: false,
        fixture: true,
        targets: 9,
        alarms: ["source-empty:mobo-toronto", "canary-expired"],
      },
    });
  });

  /**
   * AN `alarms` COLUMN A SECOND WRITER CORRUPTED MUST NOT CRASH THE PAGE.
   *
   * MEASURED WHILE WRITING THIS: `[oops` is REFUSED by the column's own `alarms LIKE '[%]'`
   * CHECK, so the value had to be `[oops]` to get past it -- which is the precise width of what
   * that CHECK buys and why the handler's validation is the real guard. The comment in
   * `collectorHealth.ts` was corrected to say so rather than overstate the CHECK.
   */
  /**
   * H-13: AN UNREADABLE `alarms` COLUMN IS `degraded`, NOT `ok`. IT FAILS TOWARD THE ALARM.
   *
   * THE MUTATION IS RETURNING `[]` ON A PARSE FAILURE, which is the obvious defensive reading and
   * is wrong in the one direction that matters. MEASURED against the real reader:
   * `alarms = '[refused:gpu-rtx]'` -- unquoted, so not JSON, and ACCEPTED by the column's own
   * `alarms LIKE '[%]'` CHECK -- produced `status:"ok", causes:[]` over a row that was REPORTING
   * A REFUSAL. Silence was indistinguishable from health in the function whose whole job is to
   * tell those two apart, and the shape is not hypothetical: this repository already documents a
   * hand-written `wrangler d1 execute` corrupting `search_revisions` in exactly this way.
   *
   * THE THIRD ROW IS THE SUBTLE ONE: a well-formed array with a number in it has LOST an alarm,
   * and a lost alarm must not read as no alarm either.
   */
  it.each<[string, string]>([
    ["unquoted text that passes the CHECK", "[refused:gpu-rtx]"],
    // MEASURED while writing this: `["refused:gpu-rtx"` (no trailing `]`) is REFUSED by the
    // column's own CHECK, so the seed threw. This form keeps the brackets the CHECK demands and
    // still fails `JSON.parse` -- another measurement of exactly how little that CHECK buys.
    ["an unterminated string inside brackets", '["refused:gpu-rtx]'],
    ["an array with a non-string member", "[\"canary\",7]"],
  ])("H-13: alarms stored as %s reads as degraded, never ok", async (_label, alarms) => {
    await seed({ alarms });

    const result = await readCollectorHealth(database.db, now);

    expect(result.status).toBe("degraded");
    expect(result.status).not.toBe("ok");
    expect(result.causes).toContain("alarms-unreadable");
  });

  it("H-13b: a readable array is NOT reported as unreadable", async () => {
    await seed({ alarms: JSON.stringify(["refused:gpu-rtx"]) });

    const result = await readCollectorHealth(database.db, now);

    expect(result.causes).toEqual(["refused:gpu-rtx"]);
    expect(result.causes).not.toContain("alarms-unreadable");
    // ...and the empty case, which is the ordinary healthy row.
    await seed({ alarms: "[]" });
    const healthy = await readCollectorHealth(database.db, now);
    expect(healthy.status).toBe("ok");
    expect(healthy.causes).toEqual([]);
  });
});
