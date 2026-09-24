// @vitest-environment node

import {
  authorizeCollector,
  COLLECTOR_TOKEN_HEADER,
  MIN_COLLECTOR_TOKEN_LENGTH,
  timingSafeEqualStrings,
  type CollectorEnvironment,
} from "./collectorToken";

/** 41 characters: longer than the 32 minimum, and obviously not a secret. */
const token = "collector-token-47bc9e1af0d2-not-a-secret";
const workerOrigin = "https://marketplace-deal-finder-api.example.workers.dev";

const call = (headers: Record<string, string> = {}, environment: CollectorEnvironment = { COLLECTOR_TOKEN: token }) =>
  authorizeCollector(
    new Request(`${workerOrigin}/api/listings`, { method: "POST", headers }),
    environment,
  );

describe("the collector credential", () => {
  it.each([
    ["an exact match", token, token, true],
    ["one character different", token, `${token.slice(0, -1)}X`, false],
    ["a prefix of the secret", token, token.slice(0, 20), false],
    ["the secret plus a suffix", token, `${token}X`, false],
    ["an empty presented value", token, "", false],
    // MEASURED and load-bearing: this is why the configuration check runs BEFORE the compare.
    ["both empty", "", "", true],
    ["equal non-ASCII", "é\u{1F642}", "é\u{1F642}", true],
    ["a trailing space", "a ", "a", false],
  ])("T1: %s compares as expected", async (_label, configured, presented, expected) => {
    await expect(timingSafeEqualStrings(presented, configured)).resolves.toBe(expected);
  });

  /**
   * T1b PINS THE MECHANISM, NOT THE TIMING. A spy observes CALLS, so it can tell a hashed
   * compare from `a === b` (which records 0 digest calls) even though the two produce identical
   * outputs. It does NOT measure wall-clock timing, and no test in this repo does.
   *
   * `toBe(2)` only holds in a file that does not ALSO hash listings: MEASURED that one
   * `contentHash` call adds a third `crypto.subtle.digest` call. This file does not import
   * `recordSightings`; do not move this test into `listings.test.ts` and expect the 2 to hold.
   *
   * No `mockRestore`: `vite.config.ts` sets `restoreMocks: true`, and MEASURED that it un-spies
   * a GLOBAL like `crypto.subtle.digest` before the next test in the same file runs.
   */
  it("T1b: the compare really hashes both sides to fixed-length digests", async () => {
    const spy = vi.spyOn(crypto.subtle, "digest");

    await timingSafeEqualStrings("a", "s".repeat(40));

    expect(spy.mock.calls.length).toBe(2);
    expect(spy.mock.calls.map((call) => (call[1] as ArrayBufferLike).byteLength)).toEqual([1, 40]);
    const digests = await Promise.all(
      spy.mock.results.map((result) => result.value as Promise<ArrayBuffer>),
    );
    expect(digests.map((digest) => digest.byteLength)).toEqual([32, 32]);
  });

  it.each([
    ["absent", {} as CollectorEnvironment, ""],
    ["empty", { COLLECTOR_TOKEN: "" }, ""],
    ["whitespace", { COLLECTOR_TOKEN: "   " }, "   "],
    ["a setup placeholder", { COLLECTOR_TOKEN: "REPLACE_WITH_COLLECTOR_TOKEN" }, "REPLACE_WITH_COLLECTOR_TOKEN"],
    // Each row presents THE SAME VALUE in the header: with `environment.COLLECTOR_TOKEN ?? ""`
    // and the compare first, the empty row would answer ok:true because ("","") is true.
  ])("T2: a %s secret is a 503, not an open route", async (_label, environment, presented) => {
    await expect(call({ [COLLECTOR_TOKEN_HEADER]: presented }, environment)).resolves.toEqual({
      ok: false,
      status: 503,
      code: "COLLECTOR_CONFIG_MISSING",
    });
  });

  it("T3: a secret below the minimum length is a 503, and the minimum itself is admitted", async () => {
    const short = "a".repeat(MIN_COLLECTOR_TOKEN_LENGTH - 1);
    await expect(call({ [COLLECTOR_TOKEN_HEADER]: short }, { COLLECTOR_TOKEN: short })).resolves.toEqual({
      ok: false,
      status: 503,
      code: "COLLECTOR_CONFIG_INVALID",
    });

    const exact = "b".repeat(MIN_COLLECTOR_TOKEN_LENGTH);
    await expect(call({ [COLLECTOR_TOKEN_HEADER]: exact }, { COLLECTOR_TOKEN: exact })).resolves.toEqual({
      ok: true,
    });
  });

  it("T4: a missing header and a wrong header are DIFFERENT 401s", async () => {
    await expect(call()).resolves.toEqual({
      ok: false,
      status: 401,
      code: "AUTH_TOKEN_MISSING",
    });
    await expect(call({ [COLLECTOR_TOKEN_HEADER]: "not-the-collector-token-but-long-enough" })).resolves.toEqual({
      ok: false,
      status: 401,
      code: "AUTH_TOKEN_INVALID",
    });
  });

  it("T5: the correct token in Authorization: Bearer opens nothing", async () => {
    await expect(call({ Authorization: `Bearer ${token}` })).resolves.toEqual({
      ok: false,
      status: 401,
      code: "AUTH_TOKEN_MISSING",
    });
  });

  it.each([
    ["a correct token", token],
    ["a wrong token", "not-the-collector-token-but-long-enough"],
  ])("T6: an Origin header is refused before the token is read, with %s", async (_label, presented) => {
    await expect(
      call({ Origin: "https://allowed.example", [COLLECTOR_TOKEN_HEADER]: presented }),
    ).resolves.toEqual({ ok: false, status: 403, code: "CORS_ORIGIN_DENIED" });
  });

  /**
   * T7 pins what no behavioural test can: the SHIPPED values. Every test above passes with a
   * different minimum length or a different header name.
   */
  it("T7: the shipped constants and the distinct configuration codes", async () => {
    expect(MIN_COLLECTOR_TOKEN_LENGTH).toBe(32);
    expect(COLLECTOR_TOKEN_HEADER).toBe("X-Collector-Token");

    const missing = await call({}, {});
    const invalid = await call({}, { COLLECTOR_TOKEN: "a".repeat(31) });
    for (const result of [missing, invalid]) {
      expect(result.ok).toBe(false);
      // NOT the codes readAllowedOrigins and authenticateRequest already use: three different
      // fixes behind one code sends an operator to the wrong one.
      expect(result.ok ? "" : result.code).not.toBe("AUTH_CONFIG_MISSING");
      expect(result.ok ? "" : result.code).not.toBe("AUTH_CONFIG_INVALID");
    }
    expect(missing).toEqual({ ok: false, status: 503, code: "COLLECTOR_CONFIG_MISSING" });
    expect(invalid).toEqual({ ok: false, status: 503, code: "COLLECTOR_CONFIG_INVALID" });
  });
});
