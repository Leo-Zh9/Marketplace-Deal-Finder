/**
 * THE SECOND REQUEST THE COLLECTOR MAKES TO THE WORKER: one health report per run line. ONE
 * request, NO retry -- the same rule `postListings.ts` states, for the same reason. The next
 * scheduled run reports again 30 minutes later, so declining to retry loses at most one
 * reading, and a retry loop on a process that lives on a laptop is what turns one bad run into
 * a hot loop.
 *
 * IT IS BEST-EFFORT FOR THE EXIT CODE AND LOUD IN THE LOG. A failed health write must never
 * change the run's exit code: the exit code is launchd's `LastExitStatus` and "the operator's
 * only signal", and a health surface that manufactures an exit 6 out of its own D1 hiccup is
 * worse than no health surface. Instead `runTargets.ts` appends one trailing
 * `{"kind":"run-health","reported":false,"reason":"..."}` line. L-20 is the guard.
 *
 * WHY A SEPARATE ROUTE RATHER THAN A FIELD ON THE INGEST POST. The ingest POST happens once per
 * TARGET and not at all on the six whole-run failure paths -- which are precisely the paths
 * where the page would otherwise blame the laptop for a configuration error. One report per RUN
 * LINE is what makes "every run is reported" structural.
 *
 * ONE UPSERT OF ONE SINGLETON ROW PER RUN LINE = 48 rows/day, against a measured 45,627 of
 * 100,000 rows/24 h: +0.05 %, 45.6 % -> 45.7 %. It grows with neither the target count nor
 * time, and the read side is one row per page load.
 */

import { REQUEST_TIMEOUT_MS } from "./types.ts";

/**
 * EXACTLY the eight fields `collector_health` stores, and nothing a compromised collector could
 * use to say something the run line did not already say. The Worker refuses unknown keys rather
 * than dropping them, so adding a field here is a loud 400, not a silent partial write.
 *
 * `reportedAt` IS NOT HERE ON PURPOSE. The server stamps its own clock: a laptop whose clock is
 * wrong would otherwise report itself permanently fresh, which is the single most load-bearing
 * value on the page. H-2 is the guard and its mutation is reading it from the body.
 */
export interface RunHealthReport {
  exitCode: number;
  complete: boolean;
  canary: boolean;
  dryRun: boolean;
  /** `COLLECTOR_HTML_FILE` is set: the collector is reading a saved page, not Facebook. */
  fixture: boolean;
  /** The count the SERVER returned, exactly as the run line defines it. Never the count that ran. */
  targets: number;
  alarms: string[];
}

export type HealthPostResult = { ok: true } | { ok: false; reason: string };

export interface PostRunHealthInput {
  apiBase: string;
  token: string;
  report: RunHealthReport;
}

export const postRunHealth = async (
  input: PostRunHealthInput,
  fetchImplementation: typeof fetch = globalThis.fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<HealthPostResult> => {
  let response: Response;
  try {
    response = await fetchImplementation(`${input.apiBase}/api/collector-health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A CUSTOM header, never `Authorization`, and NO `Origin`: the route refuses any request
        // carrying an Origin at all, and the token in `Authorization` would be read by the
        // Worker's Firebase bearer path on every other route. Identical to `postListings`.
        "X-Collector-Token": input.token,
      },
      body: JSON.stringify(input.report),
      // THE SAME BOUND AS EVERY OTHER REQUEST THE COLLECTOR MAKES, and here it is what keeps the
      // run line out of the network's critical path from mattering: the line is already printed
      // when this is awaited, so the worst case is 10 s of a 1,800 s window with the record
      // already on disk.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, reason: timedOut ? "timeout" : "network-error" };
  }

  /**
   * A 200 IS NOT A SUCCESS UNTIL THE BODY SAYS SO, AND THIS REPOSITORY HAS THE SCAR TO PROVE IT.
   * `collector/run.ts`'s exit-0 docstring records the measurement: "a Worker whose every write
   * failed answered 200 with FAILED:n and zero rows written", which is why exit 0 requires the
   * Worker's own report and not merely the status line. Reporting `ok` off the status alone here
   * would rebuild exactly that -- a success this collector did not verify, on the one request
   * whose entire job is to tell the operator whether anything is working.
   *
   * The reachable cases are not hypothetical: a proxy or a future route answering 200 with an
   * empty body, or a Worker that accepted the request and stored nothing.
   */
  if (response.status === 200) {
    let stored: unknown;
    try {
      stored = ((await response.json()) as { stored?: unknown }).stored;
    } catch {
      return { ok: false, reason: "status 200 with an unreadable body" };
    }
    return stored === true
      ? { ok: true }
      : { ok: false, reason: "status 200 without stored:true" };
  }

  // THE CODE IS READ WHEN THERE IS ONE, because the two outcomes need different fixes: a 400
  // means this collector and this Worker disagree about the body (deploy), and a 503 means D1
  // (wait). A body that is not JSON leaves the status alone to say it.
  let code: string | null = null;
  try {
    const parsed = (await response.json()) as { error?: { code?: unknown } };
    if (typeof parsed?.error?.code === "string") code = parsed.error.code;
  } catch {
    code = null;
  }

  return {
    ok: false,
    reason: code === null ? `status ${response.status}` : `status ${response.status}, ${code}`,
  };
};
