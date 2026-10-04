// @vitest-environment node

import { postRunHealth, type RunHealthReport } from "./postRunHealth.ts";
import { REQUEST_TIMEOUT_MS } from "./types.ts";

const apiBase = "https://api.example.workers.dev";
const token = "health-suite-collector-token-3f9a71bc2e05";

/** A probe run with a latched feed cause -- the shape the page has the most to say about. */
const report: RunHealthReport = {
  exitCode: 0,
  complete: false,
  canary: true,
  dryRun: false,
  fixture: false,
  targets: 9,
  alarms: ["feed-overlap:gpu-radeon+gpu-rtx"],
};

const input = { apiBase, token, report };

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  // NO TEST IN THIS FILE MAY DIAL OUT, and that is enforced rather than promised.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("a test reached the network");
  });
});

describe("posting one health report to the Worker", () => {
  /**
   * N1: THE EXACT REQUEST -- the custom header, NO Origin, and EXACTLY the seven report fields.
   *
   * `X-Collector-Token` AND NOT `Authorization`, for the two reasons `postListings` records: the
   * route refuses any request carrying an Origin at all, and the token in `Authorization` would
   * be read by the Worker's Firebase bearer path on every other route.
   *
   * THE FIELD LIST IS ASSERTED EXHAUSTIVELY, and the field that matters is the one that is NOT
   * there: `reportedAt`. The server stamps its own clock, and the route refuses unknown keys, so
   * a collector that sent one would get a loud 400 rather than a silently trusted timestamp.
   */
  it("N1: one POST, the custom header, no Origin, and exactly the seven report fields", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImplementation = (async (url: string, init: RequestInit) => {
      calls.push([String(url), init]);
      return jsonResponse(200, { stored: true });
    }) as unknown as typeof fetch;

    const result = await postRunHealth(input, fetchImplementation);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe("https://api.example.workers.dev/api/collector-health");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Collector-Token": token,
    });
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("Origin");
    expect(JSON.parse(String(init.body))).toEqual({
      exitCode: 0,
      complete: false,
      canary: true,
      dryRun: false,
      fixture: false,
      targets: 9,
      alarms: ["feed-overlap:gpu-radeon+gpu-rtx"],
    });
    expect(Object.keys(JSON.parse(String(init.body)) as object).sort()).toEqual([
      "alarms",
      "canary",
      "complete",
      "dryRun",
      "exitCode",
      "fixture",
      "targets",
    ]);
  });

  /**
   * N2: A FAILURE IS A REASON, NEVER A THROW AND NEVER AN EXIT CODE.
   *
   * `runTargets.ts` turns the reason into one trailing log line and leaves the exit code alone,
   * so this function's whole contract is "say what happened and do not throw". The CODE is
   * carried when there is one because the two outcomes need different fixes: a 400 means the
   * collector and the Worker disagree about the body (deploy), a 503 means D1 (wait).
   */
  it.each<[string, number, unknown, string]>([
    [
      "a 400 naming the field",
      400,
      { error: { code: "INVALID_COLLECTOR_HEALTH", field: "alarms" } },
      "status 400, INVALID_COLLECTOR_HEALTH",
    ],
    [
      "a 503 from D1",
      503,
      { error: { code: "COLLECTOR_HEALTH_STORAGE_FAILED" } },
      "status 503, COLLECTOR_HEALTH_STORAGE_FAILED",
    ],
    ["a 401", 401, { error: { code: "AUTH_TOKEN_INVALID" } }, "status 401, AUTH_TOKEN_INVALID"],
  ])("N2: %s reports its status and code", async (_label, status, body, reason) => {
    const fetchImplementation = (async () => jsonResponse(status, body)) as unknown as typeof fetch;

    await expect(postRunHealth(input, fetchImplementation)).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it("N2b: a non-200 whose body is not JSON still reports the status", async () => {
    const fetchImplementation = (async () =>
      new Response("<html>gateway</html>", { status: 502 })) as unknown as typeof fetch;

    await expect(postRunHealth(input, fetchImplementation)).resolves.toEqual({
      ok: false,
      reason: "status 502",
    });
  });

  /**
   * N3: A TRANSPORT FAILURE AND A TIMEOUT ARE SEPARATED, AND NEITHER THROWS.
   *
   * THE MUTATION THAT MATTERS IS REMOVING THE try/catch: a rejected fetch would then propagate
   * out of `emit`, out of `runAllTargets` and out of the process -- so a Worker that was simply
   * unreachable would make the collector die with an unhandled rejection instead of exiting with
   * the code its targets earned. That is the scenario this whole slice exists for.
   */
  it.each<[string, string, string]>([
    ["a network error", "TypeError", "network-error"],
    ["a timeout", "TimeoutError", "timeout"],
  ])("N3: %s reports %s rather than throwing", async (_label, name, reason) => {
    const fetchImplementation = (async () => {
      const error = new Error("fetch failed");
      error.name = name;
      throw error;
    }) as unknown as typeof fetch;

    await expect(postRunHealth(input, fetchImplementation)).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  /**
   * N4: THE SHIPPED REQUEST BOUND IS THE ONE IN `collector/types.ts`.
   *
   * A PIN, and it is not decoration: this is the one request that is awaited AFTER the run line
   * is already on disk, so its timeout is what bounds how long a run lingers past its own
   * record. Nothing else asserts the default here, and a literal would be a second authority
   * that can drift from the page fetch and the listings POST.
   */
  it("N4: the live default is REQUEST_TIMEOUT_MS", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImplementation = (async () =>
      jsonResponse(200, { stored: true })) as unknown as typeof fetch;

    await postRunHealth(input, fetchImplementation);

    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  /** N5: ONE request, NO retry -- the same rule `postListings` states, for the same reason. */
  it("N5: a 503 is not retried", async () => {
    let calls = 0;
    const fetchImplementation = (async () => {
      calls += 1;
      return jsonResponse(503, { error: { code: "COLLECTOR_HEALTH_STORAGE_FAILED" } });
    }) as unknown as typeof fetch;

    await postRunHealth(input, fetchImplementation);

    expect(calls).toBe(1);
  });
});
