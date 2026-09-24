/**
 * One run: fetch one page, parse it, post at most one batch, exit. Every seam is injected, so
 * every line of logic here is reachable from a test with no network and no filesystem.
 *
 * IT IS A ONE-SHOT PROCESS, NOT A DAEMON. One request to the source, one POST, then it exits.
 * No pagination, no cursor following, no retry of either request, no internal loop -- there is
 * no code path here that can spin. That matters more than usual because this runs on a laptop,
 * where a bad loop is easy to start and hard to notice.
 */

import { classifyParsedPage, parseSearchPage } from "./parseSearchPage.ts";
import { postListings, type IngestSummary, type PostResult } from "./postListings.ts";
import { buildSearchUrl, SEARCH_HEADERS } from "./searchUrl.ts";
import type { ProviderReason, ProviderResultState } from "./types.ts";

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
 *   4  PROVIDER_FAILURE. The page changed shape. A HUMAN MUST LOOK; nothing was posted.
 *   5  transient: the source was unavailable or rate-limited, or the POST failed with 5xx or a
 *      network error. The next run is the retry.
 *      A REPEATED EXIT 5 ACROSS RUNS IS A PERSISTENT SERVER-SIDE FAILURE, NOT A TRANSIENT ONE --
 *      measured: a one-listing batch whose only write fails answers 503 and lands here, so a
 *      total write outage carries the quieter code. Check `wrangler tail`.
 *   6  the POST was refused with a 4xx (a contract error), or it returned 200 while the Worker
 *      reported FAILED > 0. Either way a human must look.
 */
export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
export const EXIT_SOURCE_EMPTY = 3;
export const EXIT_PROVIDER_FAILURE = 4;
export const EXIT_TRANSIENT = 5;
export const EXIT_CONTRACT = 6;

const REQUEST_TIMEOUT_MS = 10_000;

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

  return { ok: true, html: await response.text() };
};

export const run = async (
  config: CollectorConfig,
  dependencies: RunDependencies = {},
): Promise<{ exitCode: number; summary: RunSummary }> => {
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
    };
  }

  // SORTED, THEN SLICED -- parseSearchPage already sorted, so the N kept really are the newest N
  // of what came back rather than the first N the source happened to emit.
  const selected = page.listings.slice(0, config.limit);

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
  };
};
