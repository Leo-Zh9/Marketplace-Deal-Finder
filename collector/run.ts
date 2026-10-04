/**
 * One run: fetch one page, parse it, post at most one batch, exit. Every seam is injected, so
 * every line of logic here is reachable from a test with no network and no filesystem.
 *
 * IT IS ONE RUN, NOT THE PROCESS, AND THAT DISTINCTION IS NEW. One request to the source and one
 * POST -- and this function is now called ONCE PER WATCH TARGET, up to MAX_TARGETS_PER_RUN times,
 * by collector/runTargets.ts. The process-level claim lives there and nowhere else; a reader
 * auditing how much this collector asks of the source must read that file, not this one.
 *
 * What is unchanged, and is the property that matters: no pagination, no cursor following, no
 * retry of either request, no internal loop -- there is no code path HERE that can spin, and the
 * loop above it is bounded by a list length the server returns and the cap refuses. That matters
 * more than usual because this runs on a laptop, where a bad loop is easy to start and hard to
 * notice.
 *
 * ONE THING WAS ADDED AND IT IS A RETURN VALUE, NOT A REQUEST. `run()` now also returns
 * `listingIds` -- the ids the page yielded -- so that `runTargets.ts` can compare two DIFFERENT
 * queries' results inside ONE run. No extra fetch, no extra POST, no state: the cheapest
 * degradation signal available, and the one the only measured degradation event would have
 * tripped. See `ListingIds` below for which paths populate it and why.
 */

import { classifyParsedPage, parseSearchPage } from "./parseSearchPage.ts";
import { postListings, type IngestSummary, type PostResult } from "./postListings.ts";
import { buildSearchUrl, SEARCH_HEADERS } from "./searchUrl.ts";
import { REQUEST_TIMEOUT_MS, type ProviderReason, type ProviderResultState } from "./types.ts";

export interface CollectorConfig {
  apiBase: string;
  token: string;
  source: string;
  componentType: string;
  location: string;
  query: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  limit: number;
  daysSinceListed: number;
  /** null means fetch live. A path means read that file -- the seam that keeps tests offline. */
  htmlFile: string | null;
  dryRun: boolean;
}

export interface RunDependencies {
  readHtmlFile?: (path: string) => Promise<string>;
  fetchImplementation?: typeof fetch;
  post?: typeof postListings;
  timeoutMs?: number;
}

/**
 * THE PARSED LISTING IDS, AND THEY ARE A SIBLING OF `summary` RATHER THAN A FIELD INSIDE IT.
 *
 * `runTargets.ts`'s `emitTarget` spreads `...outcome.summary` straight into the per-target log
 * line, so an id array inside `RunSummary` would put 216 ids into every run's worth of log --
 * the one file that is the real signal history, and the file
 * `docs/collector-ingest.md`'s shipped health check greps. Outside it, the ids reach the
 * within-run overlap check and nothing else.
 *
 * POPULATED IF AND ONLY IF `classifyParsedPage` RETURNED SUCCESS, and then from
 * `page.listings` -- every id the page yielded, BEFORE the `config.limit` slice. The slice is
 * not the measurement: `COLLECTOR_LIMIT=50` today makes the two equal, but a limit below the
 * page's yield would shrink the overlap denominator and silently move the threshold
 * `collector/runState.ts` derives from a 24-listing page. R-1 is the guard.
 *
 * `[]` ON EVERY NON-SUCCESS PATH, which is what makes `0/0` unrepresentable in the pair loop.
 * It IS populated when the parse succeeded and the POST then failed (R-2b) and under `dryRun`
 * (R-3): both ran a real search against a real page, so both measured a real feed.
 */
export type ListingIds = readonly string[];

export interface RunSummary {
  state: ProviderResultState;
  reason: ProviderReason;
  parsed: number;
  posted: number;
  dryRun: boolean;
  sourceOrdered: boolean;
  httpStatus?: number | null;
  code?: string | null;
  received?: number;
  stored?: number;
  outcomes?: Record<string, number>;
  contributions?: Record<string, number>;
  pricesUnparsed?: number;
  usage?: IngestSummary["usage"];
}

/**
 * THE EXIT CODES ARE THE OPERATOR'S ONLY SIGNAL, so each one names who must act.
 *
 *   0  listings were parsed, the POST returned 200, AND the Worker reported zero FAILED.
 *      "Parsed and accepted" is NOT enough and saying so was a measured mistake: a Worker whose
 *      every write failed answered 200 with FAILED:n and zero rows written.
 *   2  configuration error -- a required variable is missing. Nothing was fetched.
 *   3  SOURCE_EMPTY. Nothing was posted. Normal on a quiet day; an ALARM if it repeats, because
 *      a wholesale rename of every evidence marker is indistinguishable from it in one run.
 *      THE ALARM NOW EXISTS AND THE NUMBER DID NOT CHANGE. `collector/runState.ts` counts
 *      CONSECUTIVE exit 3 PER TARGET across runs and latches `source-empty:<target>` at
 *      CONSECUTIVE_ALARM_RUNS = 3; the code this run exits with is still 3 and launchd still
 *      reads 3. The alarm ADDS a signal (the run line's `alarms`, the health row, the page); it
 *      does not redefine this one.
 *   4  PROVIDER_FAILURE. The page changed shape. A HUMAN MUST LOOK; nothing was posted.
 *   5  transient: the source was unavailable or rate-limited, or the POST failed with 5xx or a
 *      network error. The next run is the retry.
 *      A REPEATED EXIT 5 ACROSS RUNS IS A PERSISTENT SERVER-SIDE FAILURE, NOT A TRANSIENT ONE --
 *      measured: a one-listing batch whose only write fails answers 503 and lands here, so a
 *      total write outage carries the quieter code. Check `wrangler tail`.
 *      THAT SENTENCE IS NOW A MECHANISM TOO: three consecutive 5s at one target latch
 *      `transient:<target>`, and a 5 whose `reason` is `rate-limited` or `blocked-redirect`
 *      latches `refused:<target>` ON THE FIRST OCCURRENCE -- both of those mean Facebook has
 *      refused THIS IP, and 27 further requests over 90 minutes into an active refusal is how a
 *      soft throttle becomes the hard block that is not recoverable by backing off.
 *   6  the POST was refused with a 4xx (a contract error), or it returned 200 while the Worker
 *      reported FAILED > 0. Either way a human must look.
 */
export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
export const EXIT_SOURCE_EMPTY = 3;
export const EXIT_PROVIDER_FAILURE = 4;
export const EXIT_TRANSIENT = 5;
export const EXIT_CONTRACT = 6;

const exitForState = (state: ProviderResultState): number => {
  switch (state) {
    case "SOURCE_EMPTY":
      return EXIT_SOURCE_EMPTY;
    case "PROVIDER_FAILURE":
      return EXIT_PROVIDER_FAILURE;
    default:
      return EXIT_TRANSIENT;
  }
};

/**
 * THE LIVE-FETCH BRANCH. Exercised only by the operator's real run -- by design, because the
 * alternative is a test that dials out. It is named in the uncovered-lines list rather than
 * pretended to be covered.
 */
const fetchLivePage = async (
  config: CollectorConfig,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; html: string } | { ok: false; state: ProviderResultState; reason: ProviderReason }> => {
  let response: Response;
  try {
    response = await fetchImplementation(
      buildSearchUrl({
        location: config.location,
        query: config.query,
        limit: config.limit,
        radiusKm: config.radiusKm,
        daysSinceListed: config.daysSinceListed,
      }),
      {
        headers: SEARCH_HEADERS,
        // A redirect is never a valid search result -- both captures are served at 200 -- and
        // following one lands silently on a login wall.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, state: "UNAVAILABLE", reason: timedOut ? "timeout" : "network-error" };
  }

  if (response.status === 429) return { ok: false, state: "RATE_LIMITED", reason: "rate-limited" };
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "";
    return location.startsWith("/login") || location.includes("checkpoint")
      ? { ok: false, state: "UNAVAILABLE", reason: "blocked-redirect" }
      : { ok: false, state: "PROVIDER_FAILURE", reason: "unexpected-redirect" };
  }
  if (response.status >= 500) return { ok: false, state: "UNAVAILABLE", reason: "http-server-error" };
  if (response.status >= 400) {
    return { ok: false, state: "PROVIDER_FAILURE", reason: "http-client-error" };
  }

  // F4. `await response.text()` IS INSIDE A try, AND THAT IS NOT DEFENSIVE PADDING. A connection
  // reset mid-body is THE ordinary transient failure when scraping over a residential connection:
  // the status line arrived, so every check above passed, and the socket then died. Outside a try
  // that rejection leaves `run()` entirely, lands in runAllTargets' belt-and-braces catch and is
  // recorded as EXIT_CONFIG -- and since 2 TOPS the precedence, ONE FLAKY SOCKET MAKES THE WHOLE
  // RUN EXIT 2 even when the other eight targets succeeded. The docs define 2 as "nothing
  // self-heals", so the operator is sent to the wrong runbook by a blip that fixes itself.
  // UNAVAILABLE / network-error -> exit 5, "the next run is the retry", is what it actually is.
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, state: "UNAVAILABLE", reason: timedOut ? "timeout" : "network-error" };
  }

  return { ok: true, html };
};

export const run = async (
  config: CollectorConfig,
  dependencies: RunDependencies = {},
): Promise<{ exitCode: number; summary: RunSummary; listingIds: ListingIds }> => {
  const post = dependencies.post ?? postListings;

  let html: string;
  if (config.htmlFile !== null) {
    const readHtmlFile = dependencies.readHtmlFile;
    if (readHtmlFile === undefined) {
      throw new TypeError("COLLECTOR_HTML_FILE is set but no file reader was provided");
    }
    html = await readHtmlFile(config.htmlFile);
  } else {
    const fetched = await fetchLivePage(
      config,
      dependencies.fetchImplementation ?? globalThis.fetch,
      dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    if (!fetched.ok) {
      return {
        exitCode: exitForState(fetched.state),
        summary: {
          state: fetched.state,
          reason: fetched.reason,
          parsed: 0,
          posted: 0,
          dryRun: config.dryRun,
          sourceOrdered: true,
        },
        // Nothing was fetched, so nothing was measured. R-2's first row.
        listingIds: [],
      };
    }
    html = fetched.html;
  }

  const page = parseSearchPage(html);
  const classification = classifyParsedPage(page);

  // NON-SUCCESS POSTS NOTHING, and `listings` is structurally empty on every such path. A
  // partially parsed page carries 5 real listings in hand and STILL posts none of them: partial
  // data flowing into a running aggregate is the failure mode this refuses.
  if (classification.state !== "SUCCESS") {
    return {
      exitCode: exitForState(classification.state),
      summary: {
        ...classification,
        parsed: page.acceptedBlocks,
        posted: 0,
        dryRun: config.dryRun,
        sourceOrdered: page.sourceOrdered,
      },
      // `[]` EVEN ON THE TWO PATHS THAT HOLD FIVE GOOD LISTINGS IN HAND. A partially parsed page
      // posts nothing, and the overlap check must not read a feed signal off a page the
      // classifier refused -- a five-of-six page shares five with its neighbour by construction.
      listingIds: [],
    };
  }

  // SORTED, THEN SLICED -- parseSearchPage already sorted, so the N kept really are the newest N
  // of what came back rather than the first N the source happened to emit.
  const selected = page.listings.slice(0, config.limit);

  // `page.listings`, NEVER `selected`, AND THE TWO ARE EQUAL ONLY BY CONFIGURATION. Production
  // runs COLLECTOR_LIMIT=50 against a ~24-listing page, so the slice is inert there -- but
  // `SPEC_RESULT_LIMIT = 15` is the default, and under it the denominator would be 15 while
  // runState.ts's OVERLAP_MIN_DENOMINATOR and OVERLAP_ALARM_FRACTION were both derived against
  // the page's full yield. A threshold whose denominator moves with an unrelated environment
  // variable is not a threshold. R-1 is the guard and it runs at `limit: 4`.
  const listingIds: ListingIds = page.listings.map((listing) => listing.id);

  if (config.dryRun) {
    return {
      exitCode: EXIT_OK,
      summary: {
        ...classification,
        parsed: page.acceptedBlocks,
        posted: 0,
        dryRun: true,
        sourceOrdered: page.sourceOrdered,
      },
      // IDS UNDER DRY-RUN, AND THAT IS INVARIANT 3's ANSWER IN THIS FILE. A dry run still fetches
      // and still parses; only the POST is skipped. Returning `[]` here would make condition 3
      // -- the one degradation this slice has actually OBSERVED -- structurally blind in exactly
      // the mode that already reports `complete:true, exitCode:0` forever while collecting
      // nothing. R-3 is the guard.
      listingIds,
    };
  }

  const result: PostResult = await post(
    {
      apiBase: config.apiBase,
      token: config.token,
      source: config.source,
      componentType: config.componentType,
      market: {
        latitude: config.latitude,
        longitude: config.longitude,
        radiusKm: config.radiusKm,
      },
      listings: selected,
    },
    dependencies.fetchImplementation ?? globalThis.fetch,
  );

  const base = {
    ...classification,
    parsed: page.acceptedBlocks,
    posted: selected.length,
    dryRun: false,
    sourceOrdered: page.sourceOrdered,
  };

  if (!result.ok) {
    return {
      exitCode: result.retryable ? EXIT_TRANSIENT : EXIT_CONTRACT,
      summary: { ...base, httpStatus: result.status, code: result.code },
      // THE PARSE SUCCEEDED AND THE *POST* FAILED, so the page was really measured and the ids
      // are real. This is not a formality: the gate's own 3-target block drives `a-bad` down
      // exactly this path (parse SUCCESS -> 400 -> not retryable -> exit 6), and with `[]` here
      // that target would contribute no ids and the pair that the gate measures would not exist.
      // R-2b is the guard.
      listingIds,
    };
  }

  // THE WORKER REPORTS TRUTHFULLY; THE COLLECTOR REFUSES TO CALL A PARTIAL FAILURE A SUCCESS.
  const failed = result.summary.outcomes.FAILED ?? 0;
  return {
    exitCode: failed > 0 ? EXIT_CONTRACT : EXIT_OK,
    summary: {
      ...base,
      httpStatus: 200,
      received: result.summary.received,
      stored: result.summary.stored,
      outcomes: result.summary.outcomes,
      contributions: result.summary.contributions,
      pricesUnparsed: result.summary.pricesUnparsed,
      usage: result.summary.usage,
    },
    listingIds,
  };
};
