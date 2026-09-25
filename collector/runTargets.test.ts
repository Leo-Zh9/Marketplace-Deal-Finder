// @vitest-environment node

import * as exitCodes from "./run.ts";
import type { CollectorConfig, RunSummary } from "./run.ts";
import {
  EXIT_PRECEDENCE,
  MAX_TARGETS_PER_RUN,
  realSleep,
  SCHEDULE_WINDOW_MS,
  runAllTargets,
  TARGET_DELAY_MS,
  type ProcessConfig,
  type RunAllTargetsDependencies,
  type RunLine,
} from "./runTargets.ts";
import type { FetchWatchTargetsResult } from "./watchTargets.ts";

const processConfig: ProcessConfig = {
  apiBase: "https://api.example.workers.dev",
  token: "loop-suite-collector-token-5ac81e37b902",
  source: "loop-suite-market",
  limit: 4,
  daysSinceListed: 7,
  htmlFile: null,
  dryRun: false,
};

const market = { location: "toronto", latitude: 43.6532, longitude: -79.3832, radiusKm: 25 };

const target = (targetId: string, componentType = "gpu", query = "graphics card") => ({
  targetId,
  componentType,
  query,
});

const summaryFor = (exitCode: number): RunSummary => ({
  state: exitCode === 0 ? "SUCCESS" : "PROVIDER_FAILURE",
  reason: exitCode === 0 ? "ok" : "parser-blind",
  parsed: exitCode === 0 ? 4 : 0,
  posted: exitCode === 0 ? 4 : 0,
  dryRun: false,
  sourceOrdered: true,
});

/**
 * EVERY RUN LINE THIS FILE PRODUCES IS CHECKED AGAINST THE TWO-CLAUSE INVARIANT AS IT IS
 * EMITTED, not only in L-11's own test. The property is the point; a test that only inspected
 * the cases it remembered to name would be exactly the hole the invariant exists to close.
 */
const runLines: RunLine[] = [];

const assertInvariant = (line: RunLine): void => {
  const sum = Object.values(line.exitCodes).reduce((total, count) => total + count, 0);
  if (line.error !== undefined) {
    // error present => exitCodes EMPTY.
    expect({ case: line.error, exitCodes: line.exitCodes }).toEqual({
      case: line.error,
      exitCodes: {},
    });
  } else {
    // error absent => the histogram sums to the count the SERVER returned.
    expect({ sum, targets: line.targets }).toEqual({ sum: line.targets, targets: line.targets });
  }
};

interface HarnessOptions {
  targets?: readonly unknown[];
  market?: unknown;
  delayMs?: number;
  fetchResult?: FetchWatchTargetsResult;
  /** Per-target exit code, by index, for the injected `run`. */
  codes?: readonly number[];
  /** Index whose `run` throws instead of resolving. */
  throwAt?: number;
  dryRun?: boolean;
}

const harness = async (options: HarnessOptions = {}) => {
  const lines: string[] = [];
  const runCalls: CollectorConfig[] = [];
  const sleeps: number[] = [];
  /** An ordered trace, so "printed as it happens" can be asserted rather than assumed. */
  const events: string[] = [];

  const targets = options.targets ?? [target("only")];
  const codes = options.codes ?? [];

  const dependencies: RunAllTargetsDependencies = {
    fetchTargets: async () =>
      options.fetchResult ?? {
        ok: true,
        market: "market" in options ? options.market : market,
        targets,
      },
    run: async (config) => {
      const index = runCalls.length;
      runCalls.push(config);
      if (options.throwAt === index) throw new Error(`target ${index} exploded`);
      const exitCode = codes[index] ?? 0;
      events.push(`run:${config.componentType}:${index}`);
      return { exitCode, summary: summaryFor(exitCode) };
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      events.push("sleep");
    },
    log: (line) => {
      lines.push(line);
      const parsed = JSON.parse(line) as { kind: string; target?: string };
      events.push(`log:${parsed.kind}:${parsed.target ?? ""}`);
      if (parsed.kind === "run") {
        const runLine = JSON.parse(line) as RunLine;
        runLines.push(runLine);
        assertInvariant(runLine);
      }
    },
  };

  const exitCode = await runAllTargets(
    {
      process: { ...processConfig, dryRun: options.dryRun ?? processConfig.dryRun },
      delayMs: options.delayMs ?? 0,
    },
    dependencies,
  );

  const parsedLines = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    exitCode,
    lines,
    runCalls,
    sleeps,
    events,
    targetLines: parsedLines.filter((line) => line.kind === "target"),
    runLine: parsedLines[parsedLines.length - 1] as unknown as RunLine,
  };
};

describe("running every target in the watch list", () => {
  it("L-1: each target gets the process config, the SAME market, and its own type and query", async () => {
    const targets = [target("a", "gpu", "graphics card"), target("b", "cpu", "cpu"), target("c", "ram", "ddr5")];
    const { runCalls, runLine } = await harness({ targets });

    expect(runCalls).toHaveLength(3);
    // The whole config, spread in the order {...process, ...market, ...target}: the process
    // config must NOT win over the market or the target, and every call must carry the SAME
    // market rather than target 1's.
    expect(runCalls).toEqual(targets.map((row) => ({ ...processConfig, ...market, ...row })));
    expect(runCalls.map((call) => call.componentType)).toEqual(["gpu", "cpu", "ram"]);
    expect(runCalls.map((call) => call.query)).toEqual(["graphics card", "cpu", "ddr5"]);
    expect(runCalls.map((call) => call.radiusKm)).toEqual([25, 25, 25]);
    expect(runCalls.map((call) => call.location)).toEqual(["toronto", "toronto", "toronto"]);
    expect(runLine.targets).toBe(3);
  });

  it("L-2: sleep runs exactly N-1 times, between targets, at the configured delay", async () => {
    const { sleeps, events } = await harness({
      targets: [target("a"), target("b"), target("c")],
      delayMs: 60_000,
    });

    expect(sleeps).toEqual([60_000, 60_000]);
    // NOT before the first and NOT after the last -- the trace, not just the count.
    expect(events[0]).toBe("run:gpu:0");
    expect(events[events.length - 1]).toBe("log:run:");
    expect(events.filter((event) => event === "sleep")).toHaveLength(2);

    const single = await harness({ targets: [target("a")], delayMs: 60_000 });
    expect(single.sleeps).toEqual([]);
  });

  it("L-2b: the shipped default is 60 s", () => {
    expect(TARGET_DELAY_MS).toBe(60_000);
  });

  it("L-3: a target that THROWS does not stop the others and is exit 2 with an error", async () => {
    const { runCalls, targetLines, runLine, exitCode } = await harness({
      targets: [target("a"), target("b"), target("c")],
      throwAt: 1,
    });

    expect(runCalls).toHaveLength(3);
    expect(targetLines.map((line) => line.target)).toEqual(["a", "b", "c"]);
    expect(targetLines[1]).toMatchObject({ exitCode: 2, error: "target 1 exploded" });
    expect(runLine.exitCodes).toEqual({ "0": 2, "2": 1 });
    expect(runLine.complete).toBe(false);
    expect(exitCode).toBe(2);
  });

  it.each<[string, number[], number]>([
    ["{0,3}", [0, 3], 3],
    ["{0,5,3}", [0, 5, 3], 5],
    ["{0,4,5}", [0, 4, 5], 4],
    ["{0,6,4}", [0, 6, 4], 6],
    ["{0,2,6}", [0, 2, 6], 2],
  ])("L-4: per-target codes %s fold to %i", async (_label, codes, expected) => {
    const targets = codes.map((_code, index) => target(`t${index}`));
    const { runLine, exitCode } = await harness({ targets, codes });

    expect(runLine.exitCode).toBe(expected);
    expect(exitCode).toBe(expected);
  });

  /**
   * L-4b: EVERY EXIT CODE `run.ts` CAN RETURN IS RANKED, and this is the guard on the drift F7
   * removed. `severityRank` returns **-1** for a code the precedence list does not name, and -1
   * sorts as MORE SEVERE THAN EXIT_CONFIG -- so an unranked code would make a transient blip
   * outrank a real configuration error and become the whole run's exit status.
   *
   * The six constants are now IMPORTED from run.ts rather than re-declared here, which makes the
   * two lists unable to disagree about a code's VALUE. This row covers the half that import does
   * not: a SEVENTH code added to run.ts and not added here. Nothing else in this file would
   * notice, because every other test injects exit codes as literals and never routes through
   * run.ts's constants at all -- which is exactly why the drift was invisible.
   */
  it("L-4b: the precedence names every exit code run.ts exports, exactly once", () => {
    const declared = Object.entries(exitCodes)
      .filter(([name, value]) => name.startsWith("EXIT_") && typeof value === "number")
      .map(([, value]) => value as number);

    expect(declared).toHaveLength(6);
    expect([...EXIT_PRECEDENCE].sort()).toEqual([...declared].sort());
    // No duplicates, or two codes would share a rank and the fold would be order-dependent.
    expect(new Set(EXIT_PRECEDENCE).size).toBe(EXIT_PRECEDENCE.length);
    // The recorded judgement, in the one place it is written down.
    expect(EXIT_PRECEDENCE).toEqual([2, 6, 4, 5, 3, 0]);
  });

  /**
   * L-5: LINES ARE EMITTED DURING THE RUN, NOT BUFFERED. A process killed mid-run must still
   * leave the record of everything that completed -- and a test that only reads the final output
   * is blind to the difference.
   */
  it("L-5: target 1's line is printed before the first sleep", async () => {
    const { events } = await harness({ targets: [target("a"), target("b")], delayMs: 60_000 });

    expect(events).toEqual([
      "run:gpu:0",
      "log:target:a",
      "sleep",
      "run:gpu:1",
      "log:target:b",
      "log:run:",
    ]);
  });

  it("L-6: an empty watch list is exit 2 with targets:0 and run is never called", async () => {
    const { exitCode, runCalls, runLine, lines } = await harness({ targets: [] });

    expect(exitCode).toBe(2);
    expect(runCalls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(runLine).toMatchObject({
      kind: "run",
      targets: 0,
      complete: false,
      exitCode: 2,
      exitCodes: {},
    });
    expect(runLine.error).toBe("the watch list is empty");
  });

  /**
   * L-6: THE MARKET-NULL CASE, AND `targets` IS THE HALF THAT MATTERS. Reporting `targets:0`
   * here would hide from the operator that they still have two targets configured; inventing a
   * default market would collect into the wrong `market_key` silently.
   */
  it("L-6: a null market is exit 2, targets:2, and run is never called", async () => {
    const { exitCode, runCalls, runLine } = await harness({
      targets: [target("a"), target("b")],
      market: null,
    });

    expect(exitCode).toBe(2);
    expect(runCalls).toHaveLength(0);
    expect(runLine).toMatchObject({ targets: 2, complete: false, exitCode: 2, exitCodes: {} });
    expect(runLine.error).toContain("market");
  });

  /**
   * L-6b: THE EXIT CODE A BAD LOCATION ACTUALLY PRODUCES, and this row is the reason
   * `parseMarket` exists. MEASURED: without it, `buildSearchUrl`'s TypeError is swallowed by
   * `fetchLivePage`'s own catch and `run()` reports UNAVAILABLE/network-error -- EXIT 5, "the
   * next run is the retry", forever, for a permanent configuration error. 2, not 5.
   */
  it.each<[string, string]>([
    ["toronto/search", "toronto/search"],
    ["a doubled hyphen the schema CHECK accepts", "a--b"],
  ])("L-6b: the location %s is exit 2, not the exit 5 run() would report", async (_label, location) => {
    const { exitCode, runCalls, runLine } = await harness({
      targets: [target("a"), target("b")],
      market: { ...market, location },
    });

    expect(exitCode).toBe(2);
    expect(exitCode).not.toBe(5);
    expect(runCalls).toHaveLength(0);
    expect(runLine.targets).toBe(2);
  });

  it("L-7: complete is true only when every target exited 0 AND there was at least one", async () => {
    const allGood = await harness({ targets: [target("a"), target("b")], codes: [0, 0] });
    expect(allGood.runLine.complete).toBe(true);

    // A quiet-day SOURCE_EMPTY target makes complete:false. That is true -- the target
    // contributed nothing -- and exit 3 is unchanged, so the operator's existing signal stands.
    const quiet = await harness({ targets: [target("a"), target("b")], codes: [0, 3] });
    expect(quiet.runLine.complete).toBe(false);
    expect(quiet.exitCode).toBe(3);

    // `complete = failed === 0` is TRUE for an empty list. It must not be.
    const empty = await harness({ targets: [] });
    expect(empty.runLine.complete).toBe(false);

    // ...and for a cap refusal, where exitCodes is empty too.
    const over = await harness({
      targets: Array.from({ length: MAX_TARGETS_PER_RUN + 1 }, (_value, index) => target(`t${index}`)),
    });
    expect(over.runLine.complete).toBe(false);
  });

  it.each<[string, FetchWatchTargetsResult, number]>([
    [
      "a 4xx",
      { ok: false, status: 401, code: "AUTH_TOKEN_INVALID", reason: "http-client-error", retryable: false },
      6,
    ],
    [
      "a 5xx",
      { ok: false, status: 503, code: "WATCH_TARGETS_STORAGE_FAILED", reason: "http-server-error", retryable: true },
      5,
    ],
    ["a transport failure", { ok: false, status: null, code: null, reason: "transport", retryable: true }, 5],
    ["a timeout", { ok: false, status: null, code: null, reason: "timeout", retryable: true }, 5],
    ["a bad shape", { ok: false, status: 200, code: null, reason: "bad-shape", retryable: false }, 6],
  ])("L-8: a watch-list GET that fails with %s exits %i", async (_label, fetchResult, expected) => {
    const { exitCode, runCalls, runLine } = await harness({ fetchResult });

    expect(exitCode).toBe(expected);
    expect(runCalls).toHaveLength(0);
    expect(runLine).toMatchObject({ targets: 0, exitCodes: {} });
    expect(runLine.error).toBeDefined();
  });

  /**
   * L-9: THE ROW THAT STOPS `targets.filter(parseOk)`. That is the natural implementation, and
   * under it this case reports `targets:2, exitCodes:{"0":2}, complete:true, exit 0` while ONE
   * OF THE USER'S SEARCHES HAS SILENTLY STOPPED. Here the histogram sums to 3 with a 2 in it.
   */
  it("L-9: a target row that is not an object at all is still a result, with an empty label", async () => {
    const { runLine, targetLines, exitCode } = await harness({
      targets: [target("a"), null, "not-a-target"],
    });

    expect(runLine.targets).toBe(3);
    expect(runLine.exitCodes).toEqual({ "0": 1, "2": 2 });
    expect(exitCode).toBe(2);
    // No label and no component type to report, and the line still exists rather than vanishing.
    expect(targetLines[1]).toMatchObject({ target: "", componentType: "", exitCode: 2 });
    expect(targetLines[2]).toMatchObject({ target: "", componentType: "", exitCode: 2 });
  });

  it("L-9: a middle row that fails parseTarget is a RESULT, never a removal", async () => {
    const { exitCode, runCalls, runLine, targetLines } = await harness({
      targets: [target("a"), { targetId: "b", componentType: "", query: "cpu" }, target("c")],
    });

    expect(runLine.targets).toBe(3);
    expect(runLine.exitCodes).toEqual({ "0": 2, "2": 1 });
    expect(
      Object.values(runLine.exitCodes).reduce((total, count) => total + count, 0),
    ).toBe(3);
    expect(runLine.complete).toBe(false);
    expect(exitCode).toBe(2);

    // The other two still ran, and the failing row still got a line of its own.
    expect(runCalls.map((call) => call.componentType)).toEqual(["gpu", "gpu"]);
    expect(targetLines).toHaveLength(3);
    expect(targetLines[1]).toMatchObject({ target: "b", exitCode: 2 });
    expect(targetLines[1].error).toBeDefined();
  });

  /**
   * L-10: THE CAP REFUSES; IT NEVER TRUNCATES. `slice(0, MAX)` starves the same tail targets
   * every run, forever -- worker/scheduling/collection.ts already states the rule for
   * MAX_DRAIN_SOURCES. Reporting `targets:9` would hide from the operator that they have 10.
   */
  it("L-10: 10 targets run NOTHING, report targets:10, and name the cap and the cadence", async () => {
    const targets = Array.from({ length: 10 }, (_value, index) => target(`t${index}`));
    const { exitCode, runCalls, runLine } = await harness({ targets });

    expect(exitCode).toBe(2);
    expect(runCalls).toHaveLength(0);
    expect(runLine.targets).toBe(10);
    expect(runLine.exitCodes).toEqual({});
    expect(runLine.error).toContain(String(MAX_TARGETS_PER_RUN));
    expect(runLine.error).toContain("30 minutes");
  });

  it("L-10: exactly MAX_TARGETS_PER_RUN targets all run", async () => {
    const targets = Array.from({ length: MAX_TARGETS_PER_RUN }, (_value, index) => target(`t${index}`));
    const { exitCode, runCalls, runLine } = await harness({ targets });

    expect(runCalls).toHaveLength(MAX_TARGETS_PER_RUN);
    expect(runLine.targets).toBe(MAX_TARGETS_PER_RUN);
    expect(runLine.exitCodes).toEqual({ "0": MAX_TARGETS_PER_RUN });
    expect(runLine.complete).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("L-12: the run line carries the delay actually used and the dry-run flag", async () => {
    const throttled = await harness({ targets: [target("a")], delayMs: 60_000 });
    expect(throttled.runLine.delayMs).toBe(60_000);
    expect(throttled.runLine.dryRun).toBe(false);

    // A launchd environment file with COLLECTOR_DRY_RUN set reports complete:true, exitCode:0
    // FOREVER while collecting nothing. `dryRun` is the one field that distinguishes it.
    const dry = await harness({ targets: [target("a")], dryRun: true });
    expect(dry.runLine.dryRun).toBe(true);
    expect(dry.runLine.complete).toBe(true);
    expect(dry.runLine.exitCode).toBe(0);
  });

  it.each<[string, number]>([
    ["a negative delay", -1],
    ["a fractional delay", 0.5],
    ["NaN", Number.NaN],
  ])("L-13: %s is refused before any target runs", async (_label, delayMs) => {
    const { exitCode, runCalls, runLine } = await harness({
      targets: [target("a"), target("b")],
      delayMs,
    });

    expect(exitCode).toBe(2);
    // `sleep(-1)` returns immediately and the burst is back; the check belongs where a test can
    // reach it, which is here and not in main.ts.
    expect(runCalls).toHaveLength(0);
    expect(runLine.exitCodes).toEqual({});
    expect(runLine.error).toBeDefined();
  });

  /**
   * L-13b: THE OTHER END OF THE SAME CHECK. `COLLECTOR_TARGET_DELAY_MS=600000` is a plausible
   * fat-finger for "ten minutes" and gives an 80-minute run at the cap -- which
   * `StartCalendarInterval` turns into SILENTLY SKIPPED WINDOWS, because launchd coalesces what
   * it missed rather than complaining. The boundary rows are what stop the bound drifting into
   * an off-by-one that refuses a legal delay or admits an impossible one.
   */
  it.each<[string, number]>([
    ["ten minutes, the fat-finger", 600_000],
    ["one millisecond over the window", SCHEDULE_WINDOW_MS / (MAX_TARGETS_PER_RUN - 1) + 1],
  ])("L-13b: a delay of %s is refused before any target runs", async (_label, delayMs) => {
    const { exitCode, runCalls, runLine } = await harness({
      targets: [target("a"), target("b")],
      delayMs,
    });

    expect(exitCode).toBe(2);
    expect(runCalls).toHaveLength(0);
    expect(runLine.exitCodes).toEqual({});
    expect(runLine.error).toContain(String(SCHEDULE_WINDOW_MS));
  });

  it.each<[string, number]>([
    ["the shipped 60 s", TARGET_DELAY_MS],
    ["exactly the window, to the millisecond", SCHEDULE_WINDOW_MS / (MAX_TARGETS_PER_RUN - 1)],
    ["zero", 0],
  ])("L-13b: a delay of %s is accepted", async (_label, delayMs) => {
    const { exitCode, runCalls } = await harness({ targets: [target("a"), target("b")], delayMs });

    expect(runCalls).toHaveLength(2);
    expect(exitCode).toBe(0);
  });

  /**
   * L-14: THE THROTTLE'S MECHANISM, NOT ITS REPORTED VALUE.
   *
   * EVERY OTHER TEST IN THIS FILE INJECTS `sleep` AND IS THEREFORE BLIND TO WHETHER THE REAL ONE
   * WAITS. That blindness was measured, not imagined: with the implementation inline in
   * `collector/main.ts`, replacing it with `() => Promise.resolve()` left 156 unit tests and all
   * 79 gate assertions green -- nine back-to-back searches from the operator's residential IP,
   * which is the one failure that ends the Facebook half of the product.
   *
   * A LOWER BOUND, NEVER AN UPPER ONE. `setTimeout` guarantees "at least", so a slow or loaded
   * machine only makes this MORE true; there is no p95 here to flake. The 5 ms of slack absorbs
   * timer granularity. The complementary guard -- what `main.ts` actually supplies -- is the
   * gate's wall-time assertion, because no unit test can see that file.
   */
  it("L-14: realSleep actually elapses", async () => {
    const started = Date.now();
    await realSleep(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("L-14: realSleep(0) still resolves, so a delay of 0 is a no-op and not a hang", async () => {
    await expect(realSleep(0)).resolves.toBeUndefined();
  });

  /**
   * L-11: THE TWO-CLAUSE INVARIANT, AS A PROPERTY OVER EVERY CASE IN THIS FILE.
   *
   *   error !== undefined  =>  exitCodes is EMPTY
   *   error === undefined  =>  sum(Object.values(exitCodes)) === targets
   *
   * Every run line above was checked as it was emitted; this test proves the property is not
   * VACUOUS -- that both branches were actually exercised, and that a `targets:N, exitCodes:{}`
   * line really does occur, which is the case the single-clause "the sum always equals targets"
   * form gets wrong. THIS ROW IS WHAT STOPS A LATER EDIT REDEFINING `targets` AS THE COUNT THAT
   * RAN: under that redefinition the cap refusal and the null market both report targets:0.
   *
   * It runs last on purpose: `runLines` is filled by every harness call in this file.
   */
  it("L-11: both clauses hold on every run line, and both branches were exercised", () => {
    expect(runLines.length).toBeGreaterThan(20);

    for (const line of runLines) {
      const sum = Object.values(line.exitCodes).reduce((total, count) => total + count, 0);
      if (line.error !== undefined) {
        expect(line.exitCodes).toEqual({});
      } else {
        expect(sum).toBe(line.targets);
      }
    }

    // Non-vacuity, both ways.
    expect(runLines.some((line) => line.error !== undefined)).toBe(true);
    expect(runLines.some((line) => line.error === undefined && line.targets > 0)).toBe(true);
    // The case the one-clause form gets wrong: an error line whose `targets` is NOT zero.
    expect(runLines.some((line) => line.error !== undefined && line.targets > 0)).toBe(true);
  });
});
