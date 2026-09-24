// @vitest-environment node

import { postListings, type IngestSummary, type PostResult } from "./postListings.ts";
import { run, type CollectorConfig } from "./run.ts";
import {
  facebookSearchEmpty,
  facebookSearchPage,
  truncatedMidBlock,
  withCorruptBlock,
  withMissingTitle,
  withRenamedTypename,
  reordered,
} from "./testing/fixtures.ts";

/** Every value here is distinct from every other suite's and from every shipped default. */
const config: CollectorConfig = {
  apiBase: "https://api.example.workers.dev",
  token: "run-suite-collector-token-5d0c83fa1e97",
  source: "run-suite-market",
  componentType: "gpu",
  location: "guelph",
  query: "rtx 3060",
  latitude: 43.5448,
  longitude: -80.2482,
  radiusKm: 9,
  limit: 4,
  daysSinceListed: 2,
  htmlFile: "/fixtures/facebookSearchPage.html",
  dryRun: false,
};

const summaryWith = (overrides: Partial<IngestSummary> = {}): IngestSummary => ({
  received: 4,
  stored: 4,
  outcomes: { NEW: 4, CHANGED: 0, UNCHANGED: 0, FAILED: 0 },
  contributions: {
    recorded: 0,
    restored: 0,
    removed: 0,
    none: 0,
    "skipped-no-price": 0,
    "skipped-no-model": 4,
    "skipped-invalid": 0,
  },
  pricesUnparsed: 0,
  usage: { rowsRead: 1, rowsWritten: 12 },
  ...overrides,
});

type PostCall = Parameters<typeof postListings>[0];

const recorder = (result: PostResult) => {
  const calls: PostCall[] = [];
  const post: typeof postListings = async (input) => {
    calls.push(input);
    return result;
  };
  return { calls, post };
};

const okResult = (summary: IngestSummary = summaryWith()): PostResult => ({
  ok: true,
  status: 200,
  summary,
});

const fromHtml = (html: string) => async () => html;

beforeEach(() => {
  // NO TEST IN THIS FILE MAY DIAL OUT, and that is enforced rather than promised.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("a test reached the network");
  });
});

describe("one collector run", () => {
  /**
   * R1: `limit: 4` against a SIX-block page, so the slice is observable, and the reordered page
   * makes "slice before sorting" return the four OLDEST ids instead. Both rows must produce the
   * same four ids in the same order.
   */
  it.each([
    ["the capture's own order", facebookSearchPage],
    ["a page whose source order is reversed", reordered()],
  ])("R1: %s posts exactly the newest four, in order", async (_label, html) => {
    const { calls, post } = recorder(okResult());

    const { exitCode, summary } = await run(config, { post, readHtmlFile: fromHtml(html) });

    expect(calls).toHaveLength(1);
    expect(calls[0].listings.map((listing) => listing.id)).toEqual([
      "1807946430653887",
      "915010494744438",
      "913388811629562",
      "1812246723463464",
    ]);
    expect(calls[0].source).toBe("run-suite-market");
    expect(calls[0].market).toEqual({ latitude: 43.5448, longitude: -80.2482, radiusKm: 9 });
    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({ state: "SUCCESS", reason: "ok", parsed: 6, posted: 4 });
  });

  it("R2: a genuinely empty market posts nothing and exits 3", async () => {
    const { calls, post } = recorder(okResult());

    const { exitCode, summary } = await run(config, {
      post,
      readHtmlFile: fromHtml(facebookSearchEmpty),
    });

    expect(calls).toHaveLength(0);
    expect(exitCode).toBe(3);
    expect(summary).toMatchObject({ state: "SOURCE_EMPTY", reason: "no-results", posted: 0 });
  });

  /**
   * R3: a page whose shape moved posts NOTHING -- including the two variants that leave five
   * perfectly good listings in hand. Partial data flowing into a running aggregate is the
   * failure this refuses, and "failures carry no listings" would otherwise be satisfied by a
   * path that never had any.
   */
  it.each([
    ["every anchor renamed", withRenamedTypename(), "parser-blind", 0],
    ["one block corrupted", withCorruptBlock(), "block-unparseable", 5],
    ["the body truncated mid-block", truncatedMidBlock(), "block-unparseable", 5],
    ["one block missing its title", withMissingTitle(), "listing-schema-changed", 5],
  ])("R3: %s posts nothing and exits 4", async (_label, html, reason, parsed) => {
    const { calls, post } = recorder(okResult());

    const { exitCode, summary } = await run(config, { post, readHtmlFile: fromHtml(html) });

    expect(calls).toHaveLength(0);
    expect(exitCode).toBe(4);
    expect(summary).toMatchObject({ state: "PROVIDER_FAILURE", reason, parsed, posted: 0 });
  });

  it("R4: a dry run parses, reports and never writes", async () => {
    const { calls, post } = recorder(okResult());

    const { exitCode, summary } = await run(
      { ...config, dryRun: true },
      { post, readHtmlFile: fromHtml(facebookSearchPage) },
    );

    expect(calls).toHaveLength(0);
    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({ state: "SUCCESS", parsed: 6, posted: 0, dryRun: true });
  });

  it.each([
    ["a contract error", 400, 6, false],
    ["a server error", 503, 5, true],
  ])("R5: %s (HTTP %i) exits %i", async (_label, status, exitCode, retryable) => {
    const { post } = recorder({ ok: false, status, code: "SOME_CODE", retryable });

    const result = await run(config, { post, readHtmlFile: fromHtml(facebookSearchPage) });

    expect(result.exitCode).toBe(exitCode);
    expect(result.summary).toMatchObject({ httpStatus: status, code: "SOME_CODE" });
  });

  /**
   * R6 IS THE COLLECTOR HALF OF THE MEASURED DEFECT. A Worker whose per-listing writes all
   * failed answered 200 with FAILED:n and zero rows written; branching on the HTTP status alone
   * makes this run exit 0 and call a total write outage a success.
   */
  it("R6: a 200 that reports FAILED listings is not a success", async () => {
    const { post } = recorder(
      okResult(
        summaryWith({
          stored: 4,
          outcomes: { NEW: 2, CHANGED: 0, UNCHANGED: 0, FAILED: 2 },
        }),
      ),
    );

    const { exitCode, summary } = await run(config, {
      post,
      readHtmlFile: fromHtml(facebookSearchPage),
    });

    expect(exitCode).toBe(6);
    expect(summary.outcomes).toEqual({ NEW: 2, CHANGED: 0, UNCHANGED: 0, FAILED: 2 });
    // The one line the operator reads must say so too.
    expect(JSON.stringify(summary)).toContain('"FAILED":2');
  });

  it("R6: a clean 200 exits 0 and its printed line says FAILED:0", async () => {
    const { post } = recorder(okResult());

    const { exitCode, summary } = await run(config, {
      post,
      readHtmlFile: fromHtml(facebookSearchPage),
    });

    expect(exitCode).toBe(0);
    expect(JSON.stringify(summary)).toContain('"state":"SUCCESS"');
    expect(JSON.stringify(summary)).toContain('"FAILED":0');
  });
});
