// @vitest-environment node

import { readFileSync } from "node:fs";
import type { HealthPostResult, RunHealthReport } from "./postRunHealth.ts";
import * as exitCodes from "./run.ts";
import type { CollectorConfig, RunSummary } from "./run.ts";
import {
  CANARY_TARGETS,
  MAX_CANARY_RUNS,
  serializeRunState,
  type RunState,
} from "./runState.ts";
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
import { fetchWatchTargets, type FetchWatchTargetsResult } from "./watchTargets.ts";

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
 * EVERY RUN LINE THIS FILE PRODUCES IS CHECKED AGAINST THE THREE-CLAUSE INVARIANT AS IT IS
 * EMITTED, not only in L-11's own test. The property is the point; a test that only inspected
 * the cases it remembered to name would be exactly the hole the invariant exists to close.
 *
 * `ran` IS THE NUMBER OF `kind:"target"` LINES THE SAME RUN PRINTED, which is the only
 * observable `probeSet.length` has -- there is no `ran` field on the run line and the docstring
 * forbids adding one. The run line is always last, so the count is complete when it arrives.
 */
interface ObservedRunLine {
  line: RunLine;
  ran: number;
}

const runLines: ObservedRunLine[] = [];

const assertInvariant = (line: RunLine, ran: number): void => {
  const sum = Object.values(line.exitCodes).reduce((total, count) => total + count, 0);
  if (line.error !== undefined) {
    // error present => exitCodes EMPTY.
    expect({ case: line.error, exitCodes: line.exitCodes }).toEqual({
      case: line.error,
      exitCodes: {},
    });
  } else if (!line.canary) {
    // error absent, full run => the histogram sums to the count the SERVER returned.
    expect({ sum, targets: line.targets }).toEqual({ sum: line.targets, targets: line.targets });
  } else {
    // error absent, PROBE => the histogram sums to the probe set, which is a NON-EMPTY STRICT
    // subset. `0 < ran` is the conjunct that keeps "a run that collected nothing and exited 0"
    // unrepresentable; without it `sum === ran < targets` holds vacuously at ran = 0.
    expect({ sum, ran, strict: sum > 0 && sum < line.targets }).toEqual({
      sum: ran,
      ran,
      strict: true,
    });
  }
};

/**
 * `targetId` IS ON THE RUNTIME CONFIG AND NOT ON `CollectorConfig`, and that is the shipped
 * state rather than a gap this slice introduces: `perTargetConfig` is built as
 * `{...process, ...market, ...target}` and a SPREAD is exempt from TypeScript's excess-property
 * check, so the field is present at runtime (L-1 asserts the whole object) and absent from the
 * type. This reader is where that is said out loud instead of a bare cast at each use.
 */
const targetIdOf = (config: CollectorConfig): string =>
  (config as CollectorConfig & { targetId?: string }).targetId ?? "";

/** A state file's bytes, built from a partial so each test says only what it is about. */
const stateFile = (over: Partial<RunState> = {}): string =>
  serializeRunState({
    version: 1,
    consecutive: {},
    alarm: {},
    probe: 0,
    canaryRuns: 0,
    ...over,
  });

interface HarnessOptions {
  targets?: readonly unknown[];
  market?: unknown;
  delayMs?: number;
  fetchResult?: FetchWatchTargetsResult;
  /** Per-target exit code, by index, for the injected `run`. */
  codes?: readonly number[];
  /** Per-target `reason`, by index. Only the two refusal reasons change any behaviour. */
  reasons?: readonly (string | undefined)[];
  /** Per-target listing ids, BY TARGET ID, so a probe's ids do not shift with the slice. */
  ids?: Record<string, readonly string[]>;
  /** Index whose `run` throws instead of resolving. */
  throwAt?: number;
  dryRun?: boolean;
  htmlFile?: string | null;
  /** The state file's bytes. `undefined` means "no file", the first-ever-run case. */
  state?: string | null;
  /** `readState` rejects instead of resolving. */
  readStateThrows?: boolean;
  /** `writeState` rejects instead of resolving. */
  writeStateThrows?: boolean;
  /** What the health POST answers. */
  healthResult?: HealthPostResult;
}

const harness = async (options: HarnessOptions = {}) => {
  const lines: string[] = [];
  const runCalls: CollectorConfig[] = [];
  const sleeps: number[] = [];
  /** An ordered trace, so "printed as it happens" can be asserted rather than assumed. */
  const events: string[] = [];
  const written: string[] = [];
  const healthReports: RunHealthReport[] = [];

  const targets = options.targets ?? [target("only")];
  const codes = options.codes ?? [];
  let ranLines = 0;

  const dependencies: RunAllTargetsDependencies = {
    fetchTargets: async () =>
      options.fetchResult ?? {
        ok: true,
        market: "market" in options ? options.market : market,
        targets,
        monitoring: "running",
      },
    run: async (config) => {
      const index = runCalls.length;
      runCalls.push(config);
      if (options.throwAt === index) throw new Error(`target ${index} exploded`);
      // BY TARGET ID WHERE THE TEST SUPPLIES ONE, so that a probe running targets 3 and 7 gets
      // THEIR codes rather than the first two in the list -- a by-index lookup would make the
      // probe tests silently assert the wrong targets' outcomes.
      const id = targetIdOf(config);
      const byId = targets.findIndex(
        (row) =>
          typeof row === "object" && row !== null && (row as { targetId?: string }).targetId === id,
      );
      const slot = byId === -1 ? index : byId;
      const exitCode = codes[slot] ?? 0;
      events.push(`run:${config.componentType}:${index}`);
      return {
        exitCode,
        summary: {
          ...summaryFor(exitCode),
          reason: (options.reasons?.[slot] ??
            summaryFor(exitCode).reason) as RunSummary["reason"],
        },
        listingIds: options.ids?.[id] ?? [],
      };
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      events.push("sleep");
    },
    log: (line) => {
      lines.push(line);
      const parsed = JSON.parse(line) as { kind: string; target?: string };
      events.push(`log:${parsed.kind}:${parsed.target ?? ""}`);
      if (parsed.kind === "target") ranLines += 1;
      if (parsed.kind === "run") {
        const runLine = JSON.parse(line) as RunLine;
        runLines.push({ line: runLine, ran: ranLines });
        assertInvariant(runLine, ranLines);
      }
    },
    readState: async () => {
      if (options.readStateThrows === true) throw new Error("EACCES: permission denied");
      return options.state ?? null;
    },
    writeState: async (serialized) => {
      if (options.writeStateThrows === true) throw new Error("EROFS: read-only file system");
      written.push(serialized);
      events.push("write-state");
    },
    postHealth: async (report) => {
      healthReports.push(report);
      events.push("post-health");
      return options.healthResult ?? { ok: true };
    },
  };

  const exitCode = await runAllTargets(
    {
      process: {
        ...processConfig,
        dryRun: options.dryRun ?? processConfig.dryRun,
        htmlFile: options.htmlFile ?? processConfig.htmlFile,
      },
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
    written,
    healthReports,
    /** The state the run persisted, or `undefined` when it wrote none at all. */
    savedState:
      written.length === 0 ? undefined : (JSON.parse(written[written.length - 1]) as RunState),
    targetLines: parsedLines.filter((line) => line.kind === "target"),
    healthLines: parsedLines.filter((line) => line.kind === "run-health"),
    runLine: parsedLines.find((line) => line.kind === "run") as unknown as RunLine,
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
    // THE LAST EVENT IS THE HEALTH POST, NOT THE RUN LINE, AND THAT IS THE RULED ORDER: the run
    // line goes out FIRST and synchronously, then the POST is awaited. See `emit`.
    expect(events[events.length - 1]).toBe("post-health");
    expect(events[events.length - 2]).toBe("log:run:");
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
   *
   * IT NOW ALSO PINS THE WHOLE TAIL'S ORDER, AND THAT IS A RULING RATHER THAN A DETAIL.
   * `write-state` -> `log:run:` -> `post-health` is the only order in which the run line -- the
   * laptop's ONLY durable record, and what `docs/collector-ingest.md`'s shipped health check
   * reads -- cannot be lost to a 10 s network call. Awaiting the POST first would make it
   * losable, and the exposure window would be LONGEST EXACTLY WHEN THE WORKER IS UNREACHABLE,
   * i.e. in the scenario this slice exists for: the loss probability would be correlated with
   * the failure being reported, not a flat 10 s in 1,800.
   *
   * `write-state` BEFORE the run line is the other half: `guard-blind` has to be known before
   * the line is serialized, or the log's `alarms` and the health row's `alarms` differ by
   * construction -- two authorities on one field. It is a local file write, not a network call.
   */
  it("L-5: target 1's line is printed before the first sleep, and the run line before the POST", async () => {
    const { events } = await harness({ targets: [target("a"), target("b")], delayMs: 60_000 });

    expect(events).toEqual([
      "run:gpu:0",
      "log:target:a",
      "sleep",
      "run:gpu:1",
      "log:target:b",
      "write-state",
      "log:run:",
      "post-health",
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
   * L-m1: STOPPED FROM THE DASHBOARD IS ONE LINE AND EXIT 0, AND NOTHING ELSE. Paired with L-6
   * above on the same empty list: there, running, it is exit 2 and a degraded health POST. Here
   * the word is "stopped" and a latched state file is present, so a run that wrote state, posted
   * health or searched would show it. Targets are present on purpose: a Worker that sent them
   * anyway must still not be searched. Kills: dropping the early return (exit 2 or a run), moving
   * it after the empty-list check (exit 2), and routing it through `emit` (a health POST).
   */
  it("L-m1: monitoring stopped logs kind:stopped, exits 0, posts no health and writes no state", async () => {
    const { exitCode, runCalls, lines, healthReports, written, events } = await harness({
      fetchResult: { ok: true, market, targets: [target("a")], monitoring: "stopped" },
      state: stateFile({ consecutive: { a: { sourceEmpty: 0, transient: 2 } }, probe: 1 }),
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([JSON.stringify({ kind: "stopped" })]);
    expect(runCalls).toEqual([]);
    expect(healthReports).toEqual([]);
    expect(written).toEqual([]);
    expect(events).toEqual(["log:stopped:"]);
  });

  it("L-m1b: the same empty list with monitoring stopped is exit 0, running is exit 2", async () => {
    const stopped = await harness({
      fetchResult: { ok: true, market, targets: [], monitoring: "stopped" },
    });
    const running = await harness({
      fetchResult: { ok: true, market, targets: [], monitoring: "running" },
    });

    expect([stopped.exitCode, running.exitCode]).toEqual([0, 2]);
    expect([stopped.healthReports.length, running.healthReports.length]).toEqual([0, 1]);
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

  /* ---------- the guard: the probe, the state file and the health report ---------- */

  /**
   * Nine targets, like production. `t0`..`t8`, so a cause can name a specific one.
   *
   * NINE DISTINCT QUERIES, BECAUSE THAT IS WHAT PRODUCTION IS -- `ryzen`, `cpu`, `radeon`, `rtx`,
   * `graphics card`, `motherboard`, `power supply`, `ddr4 ram`, `ssd`. `target()`'s default query
   * is shared, and nine rows sharing one query are not nine searches: they make the IDENTICAL
   * request, so `maxPairOverlap` correctly refuses to call them a feed. MEASURED: leaving the
   * default here turned L-23 and L-23b red, which is the guard working on a fixture that did not
   * look like production.
   */
  const nine = Array.from({ length: 9 }, (_value, index) =>
    target(`t${index}`, "gpu", `query-${index}`),
  );

  /**
   * L-15: A LATCHED CAUSE MAKES THE NEXT RUN A PROBE OF THAT CAUSE'S TARGETS.
   *
   * `targets` still reports NINE -- the count the server returned -- while two ran, which is the
   * whole reason the run line's `targets` is defined the way it is. The mutation that matters is
   * ignoring `state.alarm` when choosing the set: nine targets run, `sleep` is called eight
   * times, and the line says `canary:false` while the page claims a reduction.
   */
  it("L-15: a latched cause probes its own targets, reports canary:true and targets:9", async () => {
    const { runCalls, runLine, sleeps, exitCode } = await harness({
      targets: nine,
      delayMs: 60_000,
      state: stateFile({
        consecutive: { t4: { sourceEmpty: 3, transient: 0 } },
        alarm: { "source-empty:t4": { runs: 4, cleanProbes: 0 } },
      }),
    });

    // THE CAUSE'S OWN TARGET IS ALWAYS IN THE SET, and the second is topped up from watch-list
    // order so the probe is a PAIR -- without which condition 3 is unmeasurable while the guard
    // is engaged, which is the defect CANARY_TARGETS = 2 exists to prevent.
    expect(runCalls.map(targetIdOf)).toEqual(["t0", "t4"]);
    expect(runCalls.map(targetIdOf)).toContain("t4");
    expect(runLine.canary).toBe(true);
    expect(runLine.targets).toBe(9);
    expect(runLine.exitCodes).toEqual({ "0": 2 });
    // TWO targets means exactly ONE sleep: the throttle is between targets that RAN.
    expect(sleeps).toEqual([60_000]);
    expect(exitCode).toBe(0);
  });

  /**
   * L-15b: TWO SINGLE-TARGET CAUSES FILL THE PROBE, and the cursor is what picks which two.
   * `probe: 1` over the sorted cause list starts at the second cause, so the walk is cyclic
   * rather than a prefix -- a prefix implementation would run t1 and t3 on every run forever and
   * `source-empty:t8` could never clear.
   */
  it("L-15b: the probe is two causes from the cursor, cyclically, and never exceeds the cap", async () => {
    const { runCalls, runLine, sleeps } = await harness({
      targets: nine,
      delayMs: 60_000,
      state: stateFile({
        probe: 2,
        alarm: {
          "source-empty:t1": { runs: 9, cleanProbes: 0 },
          "source-empty:t3": { runs: 9, cleanProbes: 0 },
          "source-empty:t8": { runs: 9, cleanProbes: 0 },
        },
      }),
    });

    // Sorted causes are [t1, t3, t8]; `probe: 2` starts at t8 and wraps to t1.
    expect(runCalls.map(targetIdOf)).toEqual(["t1", "t8"]);
    expect(runCalls.length).toBeLessThanOrEqual(CANARY_TARGETS);
    expect(runLine.canary).toBe(true);
    expect(sleeps).toEqual([60_000]);
  });

  /**
   * L-16: A PROBE REPORTS `complete:false`, AND THAT IS HONEST RATHER THAN AWKWARD. Two of nine
   * searches ran, so the run is not complete. The mutation is making `isComplete` count what
   * ran, which reports `complete:true` on a run that collected two ninths of the data -- and
   * `complete` is one of the four conjuncts the page's health derivation reads.
   */
  it("L-16: a probe run reports complete:false although every target that ran exited 0", async () => {
    const { runLine } = await harness({
      targets: nine,
      state: stateFile({ alarm: { "source-empty:t4": { runs: 4, cleanProbes: 0 } } }),
    });

    expect(runLine.exitCodes).toEqual({ "0": 2 });
    expect(runLine.exitCode).toBe(0);
    expect(runLine.complete).toBe(false);
  });

  /**
   * L-17: A PROBE TARGET THAT FAILS VALIDATION IS STILL A RESULT -- TWO CODES, NOT ONE.
   *
   * THE MUTATION IS `filter(parseOk)` INSIDE THE PROBE SET, which is the natural implementation
   * when the watch list has to be turned into ids: build it from validated rows and the probe
   * silently shrinks by exactly the broken rows, so `exitCodes` sums to 1 and the invariant's
   * third clause still holds. The run line would then report a clean probe of a target whose
   * configuration is broken.
   */
  it("L-17: a probe target whose row fails validation still produces its own exit 2", async () => {
    const { runLine, targetLines } = await harness({
      targets: [
        target("t0"),
        { targetId: "t1", componentType: "", query: "cpu" },
        target("t2"),
        target("t3"),
      ],
      state: stateFile({
        alarm: {
          "source-empty:t1": { runs: 4, cleanProbes: 0 },
          "source-empty:t3": { runs: 4, cleanProbes: 0 },
        },
      }),
    });

    expect(targetLines.map((line) => line.target)).toEqual(["t1", "t3"]);
    expect(runLine.exitCodes).toEqual({ "0": 1, "2": 1 });
    expect(
      Object.values(runLine.exitCodes).reduce((total, count) => total + count, 0),
    ).toBe(2);
    expect(runLine.canary).toBe(true);
  });

  /**
   * L-18: VOLUME NEVER INCREASES, AS A PROPERTY OVER EVERY CASE IN THIS FILE.
   *
   * INVARIANT 5 is the one invariant whose violation is not recoverable: losing the residential
   * IP cannot be undone by backing off afterwards. So this is asserted as a property over every
   * run line the file produced, not as a row about the case someone remembered.
   *
   * The mutations are `CANARY_TARGETS = 12` and running the probe set twice; either makes the
   * inequality false. It runs late on purpose, like L-11'.
   */
  it("L-18: no run ever ran more targets than the watch list, and a probe never exceeds the cap", () => {
    expect(runLines.length).toBeGreaterThan(20);

    for (const { line, ran } of runLines) {
      expect(ran).toBeLessThanOrEqual(Math.min(line.targets, MAX_TARGETS_PER_RUN));
      if (line.canary) expect(ran).toBeLessThanOrEqual(CANARY_TARGETS);
    }

    // Non-vacuity: at least one line really was a probe, or the second clause never ran.
    expect(runLines.some(({ line }) => line.canary)).toBe(true);
  });

  /**
   * L-26: AN EMPTY PROBE SET, OR ONE EQUAL TO THE WHOLE LIST, IS A FULL RUN WITH `canary:false`.
   *
   * THE MUTATION IS RUNNING THE EMPTY SET, and its failure shape is the sharpest in the file: a
   * run that makes ZERO requests, stores NOTHING, and exits 0 -- `exitCodes:{}` with `error`
   * absent, which also violates the invariant. `watch_targets` has no `enabled` column, so the
   * only way to pause a search is to DELETE its row, which is how a cause comes to name a target
   * that is gone.
   */
  it("L-26: a cause naming only absent targets is a FULL run, not an empty probe", async () => {
    const { runCalls, runLine, savedState } = await harness({
      targets: [target("t0"), target("t1")],
      state: stateFile({ alarm: { "source-empty:deleted-target": { runs: 9, cleanProbes: 0 } } }),
    });

    expect(runCalls.map(targetIdOf)).toEqual(["t0", "t1"]);
    expect(runLine.canary).toBe(false);
    expect(runLine.exitCodes).toEqual({ "0": 2 });
    // ...and the unprobeable cause is pruned rather than left to strand the next run too.
    expect(savedState?.alarm).toEqual({});
    expect(runLine.alarms).toEqual([]);
  });

  /**
   * L-26b: A SINGLE-TARGET WATCH LIST WITH THAT TARGET LATCHED IS A FULL RUN. The probe set
   * would be `{t0}`, which EQUALS the whole list -- not a reduction -- so reporting `canary:true`
   * would be the page claiming a cut that did not happen.
   */
  it("L-26b: a probe set equal to the whole watch list reports canary:false", async () => {
    const { runCalls, runLine } = await harness({
      targets: [target("t0")],
      state: stateFile({ alarm: { "source-empty:t0": { runs: 9, cleanProbes: 0 } } }),
    });

    expect(runCalls).toHaveLength(1);
    expect(runLine.canary).toBe(false);
    expect(runLine.targets).toBe(1);
  });

  /**
   * L-19: A THROWING `writeState` CHANGES NO EXIT CODE, AND IS REPORTED AS `guard-blind`.
   *
   * A health surface that manufactures an exit 2 out of a read-only disk is worse than none: the
   * exit code is launchd's `LastExitStatus` and the operator's only signal. But a write that
   * failed means the NEXT run forgets this one, so it is loud in the log instead.
   *
   * `guard-blind` NEVER ENTERS `state.alarm` -- the guard's mode is decided from `state.alarm`
   * and never from the run line's `alarms`, because otherwise a read-only disk would pin the
   * collector at 2 of 9 over a local filesystem problem that reducing Facebook traffic does
   * nothing whatsoever about.
   */
  it("L-19: a write failure is reported as guard-blind and the exit code is untouched", async () => {
    const { exitCode, runLine, healthReports } = await harness({
      targets: [target("t0"), target("t1")],
      writeStateThrows: true,
    });

    expect(exitCode).toBe(0);
    expect(runLine.exitCode).toBe(0);
    expect(runLine.alarms).toEqual(["guard-blind"]);
    expect(runLine.canary).toBe(false);
    // THE SENT BODY AND THE LOGGED LINE CARRY THE SAME ARRAY. Two authorities on one field is
    // the defect that the emit ordering exists to make unrepresentable.
    expect(healthReports[0].alarms).toEqual(["guard-blind"]);
  });

  /**
   * L-20: A FAILING HEALTH POST CHANGES NO EXIT CODE, AND IS REPORTED ON A TRAILING LINE.
   *
   * THE MUTATION IS FOLDING THE HEALTH RESULT INTO `codes`, which makes a 400 from the health
   * route exit 6 -- so a Worker deploy that renamed a field would take the collector's exit
   * status with it and launchd would report a write failure that never happened.
   *
   * IT IS A TRAILING LINE AND NOT AN `alarms` ENTRY, which is the ordering ruling: the POST's
   * outcome is not known until the run line is already printed, and the alternative -- reporting
   * it in the log but not in the body that was sent -- makes the two `alarms` arrays differ by
   * construction.
   */
  it("L-20: a health POST failure is a trailing run-health line, not an exit code", async () => {
    const { exitCode, runLine, healthLines } = await harness({
      targets: [target("t0")],
      healthResult: { ok: false, reason: "status 400, INVALID_COLLECTOR_HEALTH" },
    });

    expect(exitCode).toBe(0);
    expect(runLine.exitCode).toBe(0);
    expect(runLine.alarms).toEqual([]);
    expect(healthLines).toEqual([
      { kind: "run-health", reported: false, reason: "status 400, INVALID_COLLECTOR_HEALTH" },
    ]);
  });

  it("L-20b: a health POST that succeeded appends no trailing line", async () => {
    const { healthLines, healthReports } = await harness({ targets: [target("t0")] });

    expect(healthLines).toEqual([]);
    expect(healthReports).toHaveLength(1);
  });

  /**
   * L-21: THE HEALTH REPORT IS SENT UNDER DRY-RUN, CARRYING `dryRun:true`. INVARIANT 3.
   *
   * THE MUTATION IS `if (dryRun) return` BEFORE THE POST, and it is the obvious reading -- "do
   * not report a run that collected nothing". It rebuilds exactly the lie this slice exists to
   * kill, in the STALE disguise: a dry-run collector would read `stale` on the page, and "stale"
   * reads as a broken cron, whereas `dry_run:1` says WHY nothing is being collected.
   *
   * `fixture` IS THE SAME LIE BY A DIFFERENT MECHANISM and is asserted in the same row: a
   * punctual run, exit 0, `complete:true`, every listing stored -- off a saved page.
   */
  it("L-21: the health report is SENT under dry-run and under a fixture, carrying both flags", async () => {
    const dry = await harness({ targets: [target("t0")], dryRun: true });
    expect(dry.healthReports).toHaveLength(1);
    expect(dry.healthReports[0]).toMatchObject({ dryRun: true, exitCode: 0, complete: true });

    const fixture = await harness({
      targets: [target("t0")],
      htmlFile: "collector/testing/fixtures/facebookSearchPage.html",
    });
    expect(fixture.healthReports).toHaveLength(1);
    expect(fixture.healthReports[0]).toMatchObject({ fixture: true, dryRun: false });

    const live = await harness({ targets: [target("t0")] });
    expect(live.healthReports[0]).toMatchObject({ fixture: false, dryRun: false });
  });

  /**
   * L-24: HEALTH IS POSTED ON EVERY WHOLE-RUN FAILURE PATH -- ALL SIX, TABLE-DRIVEN.
   *
   * THE MUTATION IS POSTING ONLY AFTER THE LOOP, and the consequence is the one the plan's own
   * round-one draft had: a configuration error posts NO health at all, so the page says nothing
   * is wrong until the row goes stale 45 minutes later -- AND THEN BLAMES THE LAPTOP FOR A
   * CONFIG ERROR. All six paths return BEFORE the loop and all six have `apiBase` and `token` in
   * hand, so there is no path on which reporting is impossible.
   */
  it.each<[string, HarnessOptions]>([
    ["a bad delay", { delayMs: -1 }],
    ["a delay that cannot fit the window", { delayMs: 600_000 }],
    [
      "an unreadable watch list",
      { fetchResult: { ok: false, status: 503, code: null, reason: "http-server-error", retryable: true } },
    ],
    ["an empty watch list", { targets: [] }],
    [
      "a list over the cap",
      { targets: Array.from({ length: 10 }, (_value, index) => target(`t${index}`)) },
    ],
    ["a null market", { market: null }],
  ])("L-24: %s still posts exactly one health report", async (_label, options) => {
    const { healthReports, runLine } = await harness(options);

    expect(healthReports).toHaveLength(1);
    expect(healthReports[0]).toMatchObject({
      exitCode: runLine.exitCode,
      complete: false,
      canary: false,
      targets: runLine.targets,
      alarms: [],
    });
    expect(runLine.error).toBeDefined();
  });

  /**
   * L-25: A WHOLE-RUN FAILURE WRITES NO STATE AT ALL.
   *
   * THE MUTATION IS WRITING STATE ON THE FAILURE PATHS, and its failure shape is a laundered
   * streak: a cap refusal between two empty runs resets a real `source-empty` counter, so the
   * alarm the operator needs can be held off indefinitely by an unrelated configuration error.
   * No targets ran, so there is NO EVIDENCE -- `consecutive` must not reset, `cleanProbes` must
   * not advance, and `canaryRuns` must not advance because no requests were made. Not writing
   * makes all three structural rather than careful.
   */
  it.each<[string, HarnessOptions]>([
    ["a bad delay", { delayMs: -1 }],
    ["an empty watch list", { targets: [] }],
    [
      "a list over the cap",
      { targets: Array.from({ length: 10 }, (_value, index) => target(`t${index}`)) },
    ],
    ["a null market", { market: null }],
  ])("L-25: %s writes no state", async (_label, options) => {
    const { written, savedState } = await harness({
      ...options,
      state: stateFile({
        consecutive: { t0: { sourceEmpty: 2, transient: 0 } },
        canaryRuns: 7,
      }),
    });

    expect(written).toEqual([]);
    expect(savedState).toBeUndefined();
  });

  /**
   * L-29: `canary-expired` IS REPORTED ONLY WHILE A CAUSE IS STILL LATCHED.
   *
   * THE MUTATION IS APPENDING IT WHENEVER THE EXPIRY FIRED, and the failure shape is the one that
   * matters most on a page whose whole job is to be believed: the expiry run is ALSO the best
   * possible probe -- it measures every cause and all 36 pairs -- so it is the run most likely to
   * clear the LAST cause. Under the mutation the operator's first fully recovered run in two days
   * reads `degraded`, with nine of nine targets clean, exit 0 and every cause gone.
   *
   * BOTH ROWS ARE NEEDED. The second is what stops the fix being "never report it": while a cause
   * survives, nine searches ran and the reduction is still in force, so the page has to say why.
   */
  it("L-29: an expiry run that CLEARS its last cause reports no alarm at all", async () => {
    const { runLine, savedState, exitCode } = await harness({
      targets: nine,
      state: stateFile({
        canaryRuns: MAX_CANARY_RUNS,
        // One clean probe short of clearing, so this full run finishes the job.
        alarm: { "source-empty:t4": { runs: 52, cleanProbes: 1 } },
      }),
    });

    expect(exitCode).toBe(0);
    expect(runLine.complete).toBe(true);
    expect(savedState?.alarm).toEqual({});
    // THE ASSERTION: a recovered run is not labelled degraded by its own recovery.
    expect(runLine.alarms).toEqual([]);
    expect(runLine.canary).toBe(false);
  });

  it("L-29b: an expiry run whose cause SURVIVES still reports canary-expired", async () => {
    const { runLine } = await harness({
      targets: nine,
      codes: [0, 0, 0, 0, 3, 0, 0, 0, 0],
      state: stateFile({
        canaryRuns: MAX_CANARY_RUNS,
        alarm: { "source-empty:t4": { runs: 52, cleanProbes: 0 } },
      }),
    });

    expect(runLine.alarms).toEqual(["canary-expired", "source-empty:t4"]);
  });

  /**
   * L-30: A THROWING `postHealth` DOES NOT TAKE THE PROCESS WITH IT.
   *
   * UNREACHABLE TODAY AND WRAPPED ANYWAY, and the reason is structural rather than a known bug.
   * `postRunHealth` catches its own `fetch` rejection, so nothing shipped throws here -- but
   * leaving it unwrapped makes invariant 1 ("the exit codes are the operator's only signal") rest
   * on a CALLEE's internal discipline instead of on this function's shape. An unhandled rejection
   * out of `emit` would replace the operator's only signal with exit 1 and a stack trace, and
   * launchd would record a failure for a HEALTH REPORT while every target succeeded.
   *
   * THE MUTATION IS REMOVING THE try, which makes this row reject rather than resolve.
   * `writeState` is wrapped for the same reason; the two seams now agree.
   */
  it("L-30: a postHealth that THROWS leaves the exit code alone and logs the reason", async () => {
    const lines: string[] = [];
    const { runAllTargetsExitCode, healthLines } = await (async () => {
      const dependencies: RunAllTargetsDependencies = {
        fetchTargets: async () => ({ ok: true, market, targets: [target("only")], monitoring: "running" }),
        run: async () => ({ exitCode: 0, summary: summaryFor(0), listingIds: [] }),
        sleep: async () => undefined,
        log: (line) => lines.push(line),
        readState: async () => null,
        writeState: async () => undefined,
        postHealth: () => {
          throw new Error("the health client exploded");
        },
      };

      const code = await runAllTargets(
        { process: processConfig, delayMs: 0 },
        dependencies,
      );
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      return {
        runAllTargetsExitCode: code,
        healthLines: parsed.filter((line) => line.kind === "run-health"),
      };
    })();

    expect(runAllTargetsExitCode).toBe(0);
    expect(healthLines).toEqual([{ kind: "run-health", reported: false, reason: "threw" }]);
  });

  /**
   * L-28: THE `reason` REACHES `advanceState`, SO A REFUSAL LATCHES ON THE FIRST OCCURRENCE.
   *
   * THIS ROW EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. `collector/runState.test.ts` G-6
   * drives the two IMMEDIATE_REFUSAL_REASONS with CONSTRUCTED input, so it is blind to whether
   * anything ever hands it a real `reason` -- and replacing this file's
   * `reason: outcome.summary?.reason ?? null` with a flat `null` left the whole unit suite green
   * with the rate-limit guard silently disarmed. That is the same hole `realSleep` fell into, one
   * layer up: a value only as good as what observes it.
   *
   * THE SECOND HALF IS WHAT MAKES IT A LINK TEST RATHER THAN A RESTATEMENT OF G-6: the NEXT run
   * must be a probe of that target, which can only happen if the cause was written to the state
   * file the previous run produced.
   */
  it("L-28: one exit 5 with reason rate-limited latches on the first run and cuts the next", async () => {
    const first = await harness({
      targets: nine,
      codes: [0, 0, 5, 0, 0, 0, 0, 0, 0],
      reasons: [undefined, undefined, "rate-limited"],
    });

    expect(first.runLine.alarms).toEqual(["refused:t2"]);
    expect(first.runLine.canary).toBe(false);
    expect(first.healthReports[0].alarms).toEqual(["refused:t2"]);

    const second = await harness({
      targets: nine,
      state: JSON.stringify(first.savedState),
    });

    expect(second.runCalls.map(targetIdOf)).toEqual(["t0", "t2"]);
    expect(second.runCalls.map(targetIdOf)).toContain("t2");
    expect(second.runLine.canary).toBe(true);
  });

  /**
   * L-28b: AN ORDINARY EXIT 5 DOES NOT. The real log's only exit 5 is a POST failure carrying
   * `reason:"ok"`, so without this row L-28 would pass against a mutation that latched on EVERY
   * exit 5 -- which would cut volume by 78 % the first time D1 hiccupped.
   */
  it("L-28b: one exit 5 whose reason is ok latches nothing", async () => {
    const { runLine } = await harness({
      targets: nine,
      codes: [0, 0, 5, 0, 0, 0, 0, 0, 0],
      reasons: [undefined, undefined, "ok"],
    });

    expect(runLine.alarms).toEqual([]);
    expect(runLine.exitCode).toBe(5);
  });

  /**
   * L-27: AT `MAX_CANARY_RUNS` THE RUN IS FULL, `canary-expired` JOINS `alarms`, AND THE ALARM
   * STANDS.
   *
   * This is the reporting half of the expiry; `collector/runState.test.ts` G-19 owns the state
   * half. THE MUTATION IS DROPPING `canary-expired` FROM THE REPORTED ARRAY, whose failure shape
   * is a page that reads `degraded` with the cause still named but no explanation for why nine
   * searches ran that run -- the operator concludes the guard cleared itself and stops looking.
   *
   * It is sorted into the array rather than appended, so the order is deterministic whatever
   * causes are latched.
   */
  it("L-27: the expiry run is FULL, reports canary-expired, and keeps the cause", async () => {
    const { runCalls, runLine, savedState } = await harness({
      targets: nine,
      state: stateFile({
        canaryRuns: MAX_CANARY_RUNS,
        alarm: { "source-empty:t4": { runs: 52, cleanProbes: 0 } },
      }),
    });

    expect(runCalls).toHaveLength(9);
    expect(runLine.canary).toBe(false);
    expect(runLine.alarms).toEqual(["canary-expired", "source-empty:t4"]);
    // THE ALARM IS STILL RAISED. The expiry flips only the volume cut.
    expect(Object.keys(savedState?.alarm ?? {})).toEqual(["source-empty:t4"]);
    expect(savedState?.canaryRuns).toBe(0);
  });

  /**
   * L-22: AN UNREADABLE STATE FILE IS A FRESH STATE AND THE RUN PROCEEDS AT FULL VOLUME.
   *
   * THE MUTATION IS DEFAULTING TO A PROBE, whose failure shape is a FIRST-EVER run pinned at 2 of
   * 9 -- the absent file is the normal case, not an exceptional one, because nothing writes it
   * until the first run finishes. A read failure is deliberately NOT reported as `guard-blind`:
   * ENOENT on the first run would put a permanent alarm on the page, and the condition is
   * already visible in what the run does.
   */
  it.each<[string, HarnessOptions]>([
    ["no file at all", {}],
    ["a read that threw", { readStateThrows: true }],
    ["an empty file", { state: "" }],
    ["garbage", { state: "{not json" }],
    ["a latch with no version", { state: '{"alarm":{"source-empty:t0":{"runs":9,"cleanProbes":0}}}' }],
  ])("L-22: %s runs at FULL volume with no alarms", async (_label, options) => {
    const { runCalls, runLine } = await harness({ targets: nine, ...options });

    expect(runCalls).toHaveLength(9);
    expect(runLine.canary).toBe(false);
    expect(runLine.alarms).toEqual([]);
  });

  /**
   * L-23: THE OVERLAP IS COMPUTED FROM ID SETS, NOT FROM COUNTS.
   *
   * THE MUTATION IS COMPARING `summary.parsed` OR `summary.contributions`, both of which are on
   * the per-target summary and both of which are IDENTICAL on nine targets that returned nine
   * DISJOINT pages -- the ordinary healthy run. Under it every healthy run latches
   * `feed-overlap` and the guard pins the collector at 2 of 9 forever.
   *
   * 24 ids each, which is a real page's yield, so the floor is cleared and the pair loop really
   * does evaluate all 36 pairs.
   */
  it("L-23: nine targets with 24 DISJOINT ids each raise no alarm", async () => {
    const ids: Record<string, readonly string[]> = {};
    for (let index = 0; index < 9; index += 1) {
      ids[`t${index}`] = Array.from({ length: 24 }, (_value, slot) => `t${index}-listing-${slot}`);
    }

    const { runLine } = await harness({ targets: nine, ids });

    expect(runLine.alarms).toEqual([]);
    expect(runLine.canary).toBe(false);
    // ...and the measurement is reported anyway, which is what makes the absence above evidence
    // rather than the silence of a feature that never ran.
    expect(runLine.overlap).toEqual({ a: "t0", b: "t1", shared: 0, of: 24 });
  });

  /**
   * L-23b: THE SAME NINE TARGETS SERVING ONE IDENTICAL PAGE LATCH EXACTLY ONE CAUSE, and the run
   * line reports the measurement. This is the shape of the degradation actually observed: three
   * different queries, one answer, every run exiting 0.
   */
  it("L-23b: nine targets serving ONE identical 24-listing page latch one feed cause", async () => {
    const feed = Array.from({ length: 24 }, (_value, slot) => `shared-${slot}`);
    const ids = Object.fromEntries(nine.map((row) => [row.targetId, feed]));

    const { runLine, savedState, exitCode } = await harness({ targets: nine, ids });

    expect(exitCode).toBe(0);
    expect(runLine.alarms).toEqual(["feed-overlap:t0+t1"]);
    expect(runLine.overlap).toEqual({ a: "t0", b: "t1", shared: 24, of: 24 });
    expect(Object.keys(savedState?.alarm ?? {})).toEqual(["feed-overlap:t0+t1"]);
    // THE LATCH DOES NOT CUT THIS RUN. The cut starts on the NEXT run, because this one had
    // already made its nine requests by the time the overlap was measurable.
    expect(runLine.canary).toBe(false);
  });

  /**
   * PER-TARGET MARKETS. Each target searches its own `market` when its row carries one, else the
   * shared top-level `market`. A wire with no per-target markets behaves exactly as before: every
   * L- row above is that evidence, unchanged.
   */
  const hamilton = { location: "hamilton", latitude: 43.2557, longitude: -79.8711, radiusKm: 20 };
  const withMarket = (row: ReturnType<typeof target>, own: unknown) => ({ ...row, market: own });

  /**
   * M-1: THE WIRE FIXTURE, THROUGH THE REAL FETCHER AND THE REAL LOOP, NO WORKER. Two areas, a
   * null top-level market, and every search goes to its own row's area. Kills: reading only the
   * top-level market (the run is refused as "market absent"). M-2 covers own-over-shared.
   */
  it("M-1: the per-target wire fixture runs every target in its own market", async () => {
    const wire = readFileSync(
      new URL("./testing/fixtures/watchTargetsPerTargetMarket.json", import.meta.url),
      "utf8",
    );
    const rows = (JSON.parse(wire) as { targets: { targetId: string; market: unknown }[] }).targets;
    const fetchResult = await fetchWatchTargets(
      { apiBase: processConfig.apiBase, token: processConfig.token },
      (async () => new Response(wire, { status: 200 })) as unknown as typeof fetch,
    );
    expect(fetchResult).toMatchObject({ ok: true, market: null });

    const { exitCode, runCalls, runLine, healthReports, savedState } = await harness({
      fetchResult,
      codes: [0, 0, 0],
    });

    expect(exitCode).toBe(0);
    expect(runCalls).toEqual(
      rows.map(({ market: own, ...row }) => ({
        ...processConfig,
        ...(own as object),
        ...row,
      })),
    );
    expect(runCalls.map((call) => `${call.location}-${call.radiusKm}`)).toEqual([
      "toronto-25",
      "hamilton-20",
      "toronto-25",
    ]);
    expect(runLine).toMatchObject({ targets: 3, complete: true, exitCodes: { "0": 3 } });
    expect(healthReports).toHaveLength(1);
    expect(savedState).toBeDefined();
  });

  /** M-2: the row's own market beats a non-null shared one. Kills: shared spread last. */
  it("M-2: a row's own market wins over the shared top-level market", async () => {
    const { runCalls } = await harness({
      targets: [withMarket(target("a"), hamilton), withMarket(target("b"), market)],
    });

    expect(runCalls.map((call) => call.location)).toEqual(["hamilton", "toronto"]);
    expect(runCalls[0]).toEqual({ ...processConfig, ...hamilton, ...target("a") });
    expect(runCalls[1]).toEqual({ ...processConfig, ...market, ...target("b") });
  });

  /**
   * M-3: ON THE PER-TARGET WIRE A ROW WITHOUT A MARKET IS THAT TARGET'S EXIT 2. It never silently
   * takes the top-level market, and a null top-level market never refuses the whole run. Kills:
   * falling back to the top-level market when other rows carry their own (the `market` row), and
   * the whole-run refusal for a null top-level market whenever some row lacks one (the `null` row).
   */
  it.each<[string, unknown]>([
    ["a valid top-level market", market],
    ["a null top-level market", null],
  ])("M-3: with %s, a row without a market among rows with one is that target's exit 2", async (_label, top) => {
    const { exitCode, runCalls, runLine, targetLines } = await harness({
      targets: [withMarket(target("a"), hamilton), target("b", "cpu", "cpu"), withMarket(target("c"), market)],
      market: top,
      codes: [0, 0, 0],
    });

    expect(exitCode).toBe(2);
    expect(runCalls.map(targetIdOf)).toEqual(["a", "c"]);
    expect(runCalls.map((call) => call.location)).toEqual(["hamilton", "toronto"]);
    expect(runLine).toMatchObject({ targets: 3, exitCodes: { "0": 2, "2": 1 }, complete: false });
    expect(runLine.error).toBeUndefined();
    expect(targetLines[1]).toMatchObject({
      target: "b",
      exitCode: 2,
      error: "the target has no market of its own and no shared market applies",
    });
  });

  /**
   * M-3b: TODAY'S WORKER, TODAY'S MESSAGE. With no row carrying a market the refusal text is
   * byte-identical to before.
   */
  it("M-3b: a null market with no per-target markets keeps the old message exactly", async () => {
    const { runLine } = await harness({ targets: [target("a"), target("b")], market: null });
    expect(runLine.error).toBe("the watch market is unusable: the market row is absent");
  });

  /**
   * M-4: A MALFORMED OWN MARKET IS THAT TARGET'S EXIT 2: never searched in the shared market,
   * never a whole-run failure, under BOTH top-level markets. The `null` top-level rows are the
   * wire the multi-user Worker sends. Kills: falling back to the shared market on a bad own market,
   * treating an explicit `market: null` on a row as "no market" (truthiness instead of presence),
   * and one row's `market: null` refusing the whole run when the top-level market is null.
   */
  it.each<[string, unknown, unknown]>([
    ["null, top-level valid", null, market],
    ["a location with a slash, top-level valid", { ...hamilton, location: "hamilton/search" }, market],
    ["a fractional radius, top-level valid", { ...hamilton, radiusKm: 12.5 }, market],
    ["null, top-level null", null, null],
    ["a location with a slash, top-level null", { ...hamilton, location: "hamilton/search" }, null],
    ["a fractional radius, top-level null", { ...hamilton, radiusKm: 12.5 }, null],
  ])("M-4: an own market of %s is that target's exit 2 and the others still run", async (_label, own, top) => {
    const { exitCode, runCalls, runLine, targetLines } = await harness({
      targets: [
        withMarket(target("a"), hamilton),
        withMarket(target("b", "cpu", "cpu"), own),
        withMarket(target("c"), market),
      ],
      market: top,
      codes: [0, 0, 0],
    });

    expect(exitCode).toBe(2);
    expect(runCalls.map(targetIdOf)).toEqual(["a", "c"]);
    expect(runLine).toMatchObject({ targets: 3, exitCodes: { "0": 2, "2": 1 }, complete: false });
    expect(runLine.error).toBeUndefined();
    expect(targetLines[1]).toMatchObject({ target: "b", componentType: "cpu", exitCode: 2 });
    expect(String(targetLines[1].error)).toMatch(/^the target's market is unusable: /);
  });

  /**
   * M-4c: EVERY ROW'S OWN MARKET IS NULL, TOP-LEVEL NULL. Every row still carries the key, so this
   * is the per-target wire: three target exit 2s, never the whole-run refusal. Kills: deciding the
   * wire by value (`raw.market !== null`) instead of key presence.
   */
  it("M-4c: every row with market:null is three target exit 2s, not a whole-run refusal", async () => {
    const { exitCode, runCalls, runLine, targetLines } = await harness({
      targets: [withMarket(target("a"), null), withMarket(target("b"), null), withMarket(target("c"), null)],
      market: null,
    });

    expect(exitCode).toBe(2);
    expect(runCalls).toHaveLength(0);
    expect(runLine).toMatchObject({ targets: 3, exitCodes: { "2": 3 } });
    expect(runLine.error).toBeUndefined();
    expect(targetLines.map((line) => line.target)).toEqual(["a", "b", "c"]);
  });

  /**
   * M-5: A NON-NULL SHARED MARKET IS ALWAYS VALIDATED, even when every row carries its own.
   * Kills: validating the shared market only when some row falls back to it.
   */
  it("M-5: a malformed shared market is a whole-run exit 2 even when every row has its own", async () => {
    const { exitCode, runCalls, runLine } = await harness({
      targets: [withMarket(target("a"), hamilton), withMarket(target("b"), market)],
      market: { ...market, radiusKm: 0 },
    });

    expect(exitCode).toBe(2);
    expect(runCalls).toHaveLength(0);
    expect(runLine).toMatchObject({ targets: 2, exitCodes: {} });
  });

  /** M-6: the cap still refuses first, whatever markets the rows carry. */
  it("M-6: ten targets that each carry a market still run nothing", async () => {
    const targets = Array.from({ length: 10 }, (_value, index) =>
      withMarket(target(`t${index}`), hamilton),
    );
    const { exitCode, runCalls, runLine } = await harness({ targets, market: null });

    expect(exitCode).toBe(2);
    expect(runCalls).toHaveLength(0);
    expect(runLine.targets).toBe(10);
    expect(runLine.error).toContain(String(MAX_TARGETS_PER_RUN));
  });

  /**
   * L-11': THE THREE-CLAUSE INVARIANT, AS A PROPERTY OVER EVERY CASE IN THIS FILE.
   *
   *   error !== undefined             =>  exitCodes is EMPTY
   *   error === undefined && !canary  =>  sum(Object.values(exitCodes)) === targets
   *   error === undefined && canary   =>  sum === probeSet.length AND 0 < probeSet.length < targets
   *
   * Every run line above was checked as it was emitted; this test proves the property is not
   * VACUOUS -- that all three branches were actually exercised, and that a `targets:N,
   * exitCodes:{}` line really does occur, which is the case the single-clause "the sum always
   * equals targets" form gets wrong. THIS ROW IS WHAT STOPS A LATER EDIT REDEFINING `targets` AS
   * THE COUNT THAT RAN: under that redefinition the cap refusal and the null market both report
   * targets:0.
   *
   * CLAUSE 3'S `0 < probeSet.length` CONJUNCT IS ASSERTED HERE AND NOT ONLY IN L-26. The shorter
   * `sum === probeSet.length < targets` form HOLDS at length 0 -- `0 === 0 && 0 < targets` --
   * which pushes the guarantee out of the invariant and into a behaviour test. Both are kept.
   *
   * It runs last on purpose: `runLines` is filled by every harness call in this file.
   */
  it("L-11': all three clauses hold on every run line, and all three branches were exercised", () => {
    expect(runLines.length).toBeGreaterThan(20);

    for (const { line, ran } of runLines) {
      const sum = Object.values(line.exitCodes).reduce((total, count) => total + count, 0);
      if (line.error !== undefined) {
        expect(line.exitCodes).toEqual({});
      } else if (!line.canary) {
        expect(sum).toBe(line.targets);
      } else {
        expect(sum).toBe(ran);
        expect(sum).toBeGreaterThan(0);
        expect(sum).toBeLessThan(line.targets);
      }
    }

    // Non-vacuity, all three ways.
    expect(runLines.some(({ line }) => line.error !== undefined)).toBe(true);
    expect(
      runLines.some(({ line }) => line.error === undefined && !line.canary && line.targets > 0),
    ).toBe(true);
    // THE NEW CLAUSE'S OWN NON-VACUITY. Without a probe run anywhere in this file, clause 3 is
    // never evaluated and the loop above is a two-clause check wearing a three-clause comment.
    expect(runLines.some(({ line }) => line.error === undefined && line.canary)).toBe(true);
    // The case the one-clause form gets wrong: an error line whose `targets` is NOT zero.
    expect(runLines.some(({ line }) => line.error !== undefined && line.targets > 0)).toBe(true);
  });
});
