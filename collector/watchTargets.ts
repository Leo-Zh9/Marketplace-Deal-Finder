/**
 * The watch list, read from the Worker before anything is searched: what to hunt (one row per
 * target) and where (the singleton market).
 *
 * ONE request, NO retry -- the same rule `postListings` states, for the same reason. The next
 * scheduled run is the retry, and a retry loop on a process that lives on a laptop is what turns
 * one bad run into a hot loop.
 *
 * `parseMarket` and `parseTarget` are PURE and return a discriminated result; they never throw.
 * See the note on `parseMarket` for why "it throws" would be the wrong thing to assert anyway.
 */

import { LOCATION_PATTERN } from "./searchUrl.ts";
import { REQUEST_TIMEOUT_MS } from "./types.ts";

/** The market every target in one run shares. Singular by construction -- see migration 0005. */
export interface WatchMarket {
  location: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export interface WatchTarget {
  targetId: string;
  componentType: string;
  query: string;
}

/** The floor and the ceiling the schema's own CHECK enforces. Kept identical on purpose. */
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 25;

export type FetchFailureReason =
  | "http-client-error"
  | "http-server-error"
  | "transport"
  | "timeout"
  | "bad-shape";

/**
 * `market` and `targets` come back RAW. Per-item validation belongs to the loop, not here:
 * a target that fails `parseTarget` must still occupy a slot in the run's histogram, and a
 * fetcher that dropped it would make that impossible to report.
 */
export type FetchWatchTargetsResult =
  | { ok: true; market: unknown; targets: readonly unknown[] }
  | {
      ok: false;
      status: number | null;
      code: string | null;
      reason: FetchFailureReason;
      /**
       * RETRYABILITY IS ABOUT WHO MUST ACT, exactly as in `postListings`. 4xx is a contract
       * error -- the collector and the Worker disagree, or the credential is wrong -- and a
       * human must look. 5xx, a transport failure and a timeout are the server's problem and
       * the next run is the retry. A 200 whose body is the wrong shape is a CONTRACT error:
       * retrying it forever would hide a route that changed underneath the collector.
       */
      retryable: boolean;
    };

export interface FetchWatchTargetsInput {
  apiBase: string;
  token: string;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * WHY THIS FUNCTION EXISTS, and it is NOT "an uncaught throw would kill the remaining targets".
 * That is false and it was measured false: `buildSearchUrl(...)` is evaluated as an ARGUMENT
 * INSIDE `fetchLivePage`'s own try (collector/run.ts), so its `TypeError` is swallowed by the
 * catch that exists for network failures and returns `{state:"UNAVAILABLE"}` -- exit 5. A
 * `location` of "toronto/search" and a `radiusKm` of 12.5 both produce exactly that.
 *
 * THE REAL HAZARD IS QUIETER AND WORSE: a PERMANENT configuration error laundered into "the next
 * run is the retry", forever. collector/searchUrl.ts says why its TypeError exists -- "a bad
 * location or limit is a CONFIG BUG, not a source outcome. Mapping it to PROVIDER_FAILURE would
 * let a typo masquerade as Facebook being broken and be retried forever" -- and `run()` does the
 * mapping that file forbids. Nothing could see it before, because a single-target process had
 * nothing to compare against.
 *
 * SO THE ASSERTION THAT MATTERS IS ON THE EXIT CODE (2, not 5), NEVER ON "IT THROWS". This
 * function returns a result and never throws, which makes a throw-assertion structurally
 * impossible to write; runTargets.test.ts L-6b is where the exit code itself is pinned.
 *
 * SECOND MEASURED FACT, AND IT DECIDES WHERE THE COVERAGE GOES: on the `htmlFile` path
 * `buildSearchUrl` is never called at all (measured: exit 3 SOURCE_EMPTY with a `location` of
 * "toronto/search"). The e2e runs exclusively on that path, so the gate can NEVER see this. It
 * needs unit coverage and it has it.
 */
export const parseMarket = (raw: unknown): ParseResult<WatchMarket> => {
  if (raw === null) return { ok: false, reason: "the market row is absent" };
  if (!isRecord(raw)) return { ok: false, reason: "the market is not an object" };

  const { location, latitude, longitude, radiusKm } = raw;

  // THE SHAPE GUARD. The schema's `NOT GLOB '*[^a-z0-9-]*'` is a CHARACTER-CLASS guard and the
  // two are not the same: measured, the GLOB ACCEPTS a leading hyphen, a trailing hyphen and a
  // doubled hyphen, which this pattern refuses. It is never TIGHTER than this pattern, so the
  // two compose instead of fighting -- the schema can never store a location this would reject
  // on arrival. Those three hyphen classes are the only inputs that tell them apart, which is
  // why they are the rows in C-3.
  if (typeof location !== "string" || !LOCATION_PATTERN.test(location)) {
    return { ok: false, reason: `location must match ${LOCATION_PATTERN}` };
  }
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { ok: false, reason: "latitude must be a finite number in [-90, 90]" };
  }
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { ok: false, reason: "longitude must be a finite number in [-180, 180]" };
  }
  // `Number.isInteger`, not `>= 1`: 25.5 and the STRING "25" both have to be refused here, for
  // the same affinity reason migration 0005's `typeof(radius_km) = 'integer'` term exists.
  if (
    typeof radiusKm !== "number" ||
    !Number.isInteger(radiusKm) ||
    radiusKm < MIN_RADIUS_KM ||
    radiusKm > MAX_RADIUS_KM
  ) {
    return {
      ok: false,
      reason: `radiusKm must be an integer in [${MIN_RADIUS_KM}, ${MAX_RADIUS_KM}]`,
    };
  }

  return { ok: true, value: { location, latitude, longitude, radiusKm } };
};

export const parseTarget = (raw: unknown): ParseResult<WatchTarget> => {
  if (!isRecord(raw)) return { ok: false, reason: "the target is not an object" };

  const { targetId, componentType, query } = raw;
  if (!nonEmptyString(targetId)) return { ok: false, reason: "targetId must be a non-empty string" };
  if (!nonEmptyString(componentType)) {
    return { ok: false, reason: "componentType must be a non-empty string" };
  }
  if (!nonEmptyString(query)) return { ok: false, reason: "query must be a non-empty string" };

  return { ok: true, value: { targetId, componentType, query } };
};

/**
 * THE TIMEOUT IS NOT OPTIONAL POLISH, AND IT WAS MEASURED. A GET to a TCP server that accepts
 * the connection and never responds did not settle after 12,005 ms on Node 24 -- only the
 * harness's own cap ended it. With one search per process a hang hung one process; with N
 * targets in one process a hung GET strands ALL N before one of them starts, and pushes the
 * process past its own schedule window. An abort is `retryable: true` -> exit 5, "the next run
 * is the retry", which is what the docs already promise.
 */
export const fetchWatchTargets = async (
  input: FetchWatchTargetsInput,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<FetchWatchTargetsResult> => {
  let response: Response;
  try {
    response = await fetchImplementation(`${input.apiBase}/api/watch-targets`, {
      headers: {
        // A CUSTOM header, never `Authorization`, and NO `Origin`: this route refuses any
        // request carrying an Origin at all, and the token in `Authorization` would be read by
        // the Worker's Firebase bearer path on every other route.
        "X-Collector-Token": input.token,
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      status: null,
      code: null,
      reason: timedOut ? "timeout" : "transport",
      retryable: true,
    };
  }

  if (response.status !== 200) {
    let code: string | null = null;
    try {
      const parsed = (await response.json()) as { error?: { code?: unknown } };
      if (typeof parsed?.error?.code === "string") code = parsed.error.code;
    } catch {
      code = null;
    }
    const serverError = response.status >= 500;
    return {
      ok: false,
      status: response.status,
      code,
      reason: serverError ? "http-server-error" : "http-client-error",
      retryable: serverError,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: 200, code: null, reason: "bad-shape", retryable: false };
  }

  // SHAPE-CHECKED, NOT TRUSTED. `JSON.parse` alone would let a 200 carrying `{}` read as "an
  // empty watch list", which is a silent stop dressed as a quiet day.
  if (!isRecord(body) || !("market" in body) || !Array.isArray(body.targets)) {
    return { ok: false, status: 200, code: null, reason: "bad-shape", retryable: false };
  }

  return { ok: true, market: body.market, targets: body.targets };
};
