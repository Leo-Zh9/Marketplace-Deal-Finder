/**
 * ONE SEARCH PER TARGET, in ONE process. This module owns the fetch of the watch list, the cap,
 * the per-target validation, the throttle, the per-target try/catch, the exit-code fold and the
 * emitted lines. `collector/main.ts` is wiring above it and `collector/run.ts` is one search
 * below it; neither is modified by this file's existence.
 *
 * IT IS STILL A ONE-SHOT PROCESS, NOT A DAEMON. There is exactly one bounded `for` over a list
 * whose length the server returned and `MAX_TARGETS_PER_RUN` caps; no retry of anything, no
 * cursor, no nesting. That property is what `collector/run.ts` says matters more than usual on a
 * laptop, and widening this loop is what would spend it.
 */

import {
  EXIT_CONFIG,
  EXIT_CONTRACT,
  EXIT_OK,
  EXIT_PROVIDER_FAILURE,
  EXIT_SOURCE_EMPTY,
  EXIT_TRANSIENT,
  type CollectorConfig,
  type RunSummary,
} from "./run.ts";
import {
  parseMarket,
  parseTarget,
  type FetchWatchTargetsInput,
  type FetchWatchTargetsResult,
} from "./watchTargets.ts";

/** Everything in a `CollectorConfig` that is NOT per-target and NOT per-market. */
export type ProcessConfig = Omit<
  CollectorConfig,
  "componentType" | "query" | "location" | "latitude" | "longitude" | "radiusKm"
>;

/**
 * F7. THE EXIT CODES ARE IMPORTED FROM run.ts, NEVER RE-DECLARED HERE, AND THE REASON IS SHARP.
 * Six local copies with nothing asserting they agreed meant that renumbering one in run.ts left
 * this file's `severityRank` seeing an UNNAMED value -- which returns -1 and therefore sorts as
 * MORE SEVERE THAN EXIT_CONFIG. A transient blip would then outrank a real configuration error
 * and the whole run would report the wrong thing. One authority makes that unrepresentable.
 */

/**
 * THE CAP IS A MECHANISM, NOT A PARAGRAPH -- docs/collector-ingest.md's own words: "A documented
 * schedule is a weaker guard than a mechanism."
 *
 * IT REFUSES; IT NEVER TRUNCATES, and that is the same rule worker/scheduling/collection.ts
 * already states about MAX_DRAIN_SOURCES: a cap below the item count, applied to an ORDERED
 * list, "would starve THE SAME sources every run, forever." A loud refusal is recoverable;
 * silent starvation is not. Over the cap NOTHING runs and the run line still reports the count
 * the SERVER returned, so the operator learns they have 12 targets rather than merely that the
 * cap is 9.
 *
 * It is also what makes the daily request count a known bounded number: `targets x 48`, at most
 * 432/day at the cap.
 */
export const MAX_TARGETS_PER_RUN = 9;

/**
 * 60 s BETWEEN targets -- not before the first, not after the last.
 *
 * THE JUSTIFICATION IS BURST SHAPE, AND ONLY BURST SHAPE. The hazard is nine searches back to
 * back: nine requests in ~nine seconds from one residential IP is how that IP starts getting the
 * login wall the datacenter IPs already get -- the exact failure that forced collection off
 * Cloudflare. A constant 60 s removes it outright: there is no code path in which two requests
 * to the source leave this process inside a minute.
 *
 * WHAT IT DOES NOT DO, and this must not be re-argued into a safety claim: IT DOES NOT CHANGE
 * DAILY VOLUME AT ALL. Volume is `runs/day x targets`, in which the delay does not appear. That
 * is what MAX_TARGETS_PER_RUN is for.
 *
 * WHAT NUMBER IS ACTUALLY SAFE HAS NOT BEEN MEASURED AND IS NOT INVENTED HERE. The delay's
 * sufficiency against Facebook's thresholds is ASSUMED: no measurement is possible without
 * spending requests from the one residential IP whose loss ends the product, and no request was
 * made to Facebook in producing it. The cheapest mitigation if a block appears is to lengthen
 * the CADENCE (one plist edit), not this delay.
 *
 * The size is the largest the schedule window affords with margin: worst case per target, with
 * both request timeouts in place, is 10 s page + 10 s POST = 20 s, so `20N + 60(N-1)` is 660 s
 * at N = 9 -- 11 minutes, 37 % of the 1,800 s window.
 *
 * NO JITTER AND NO RANDOMISED ORDER. A constant delay removes the burst, which is the named
 * hazard; the outer schedule is perfectly regular anyway; and jitter buys non-determinism in the
 * one process this repo insists must not be able to spin.
 */
export const TARGET_DELAY_MS = 60_000;

/**
 * The cadence `scripts/launchd/...plist.template` fires at: every 30 minutes, 1,800,000 ms.
 *
 * F9. THE BUDGET THIS FILE DERIVES IS NOW ENFORCED RATHER THAN ASSERTED.
 * `COLLECTOR_TARGET_DELAY_MS=600000` is a plausible fat-finger for "ten minutes" and gives an
 * 80-minute run at the cap -- which `StartCalendarInterval` turns into SILENTLY SKIPPED WINDOWS,
 * not a loud failure, because launchd coalesces what it missed. So a delay that cannot fit the
 * cap inside one window is refused before anything runs.
 *
 * THE BOUND IS THE LOOSEST ONE THAT STILL FORBIDS AN IMPOSSIBLE RUN, and that is said plainly:
 * it counts ONLY the sleeps, `delayMs * (MAX_TARGETS_PER_RUN - 1)`, and NOT the up-to-20 s of
 * request time per target that the same comment's `20N + 60(N-1)` figure includes. A delay that
 * passes this check can still overrun once the requests are counted. Tightening it is one line;
 * it is left loose so the check refuses only what is unarguable.
 */
export const SCHEDULE_WINDOW_MS = 1_800_000;

/**
 * THE PRECEDENCE, MOST SEVERE FIRST, in the repo's own "who must act" terms (collector/run.ts):
 * 2 nothing self-heals; 6 the server refused or partially refused a WRITE, so data is at risk;
 * 4 the source changed shape -- a human must look, but nothing was posted; 5 the next run is the
 * retry; 3 normal on a quiet day; 0.
 *
 * `6 > 4` IS A JUDGEMENT, RECORDED AS ONE. Both mean "a human must look"; the one nearer the
 * data was picked. Reversing it is one line and one test row.
 *
 * NOT `Math.max`, which ranks 6 above 2 and 5 above 4 -- both wrong.
 */
export const EXIT_PRECEDENCE: readonly number[] = [
  EXIT_CONFIG,
  EXIT_CONTRACT,
  EXIT_PROVIDER_FAILURE,
  EXIT_TRANSIENT,
  EXIT_SOURCE_EMPTY,
  EXIT_OK,
];

/** A label for an unparseable row's line. The row may be anything at all, including null. */
const readString = (raw: unknown, key: string): string => {
  if (typeof raw !== "object" || raw === null) return "";
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

/**
 * An unnamed code ranks as MORE severe than every named one. UNREACHABLE now that `run.ts` is the
 * single authority above -- it can only fire if `run()` returns a code outside its own documented
 * set, i.e. a bug -- and the direction is deliberate: the process then exits with THAT code
 * rather than folding it away, so a number nobody planned is visible instead of hidden.
 */
const severityRank = (code: number): number => {
  const index = EXIT_PRECEDENCE.indexOf(code);
  return index === -1 ? -1 : index;
};

export const worstExitCode = (codes: readonly number[]): number =>
  codes.reduce(
    (worst, code) => (severityRank(code) < severityRank(worst) ? code : worst),
    EXIT_OK,
  );

/**
 * THE THROTTLE'S MECHANISM, AND IT LIVES HERE RATHER THAN IN main.ts BECAUSE IT IS NOT WIRING.
 *
 * MEASURED HOLE, and this constant is half of the fix: while this one line sat inline in
 * `collector/main.ts`, replacing it with `() => Promise.resolve()` left the ENTIRE unit suite
 * (156 tests) AND the whole e2e gate (79 assertions) green -- nine back-to-back searches from the
 * operator's residential IP with every check passing. Every unit test injects `sleep` and asserts
 * it was CALLED with 60000, which is correct and blind to whether the real one waits; the gate's
 * two throttle rows assert the REPORTED `delayMs`, not elapsed time.
 *
 * `setTimeout` is exercisable without a network and without a process fork, so it does not belong
 * in the one file no test reaches. L-14 pins that it actually elapses.
 *
 * IT IS NOT THE ONLY GUARD, AND IT CANNOT BE: main.ts could still be rewired to pass something
 * else. `scripts/e2e-local.sh`'s multi-target block asserts the WALL TIME of a real run, which is
 * the only thing that pins what main.ts actually supplies. The two catch different edits.
 */
export const realSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface RunAllTargetsConfig {
  process: ProcessConfig;
  /** Milliseconds between targets. `COLLECTOR_TARGET_DELAY_MS` overrides `TARGET_DELAY_MS`. */
  delayMs: number;
}

export interface RunAllTargetsDependencies {
  fetchTargets: (input: FetchWatchTargetsInput) => Promise<FetchWatchTargetsResult>;
  run: (config: CollectorConfig) => Promise<{ exitCode: number; summary: RunSummary }>;
  sleep: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
}

interface TargetOutcome {
  target: string;
  componentType: string;
  exitCode: number;
  summary?: RunSummary;
  error?: string;
}

/**
 * THE RUN LINE'S FIELDS, AND WHY EACH ONE IS THERE.
 *
 * `targets` IS THE COUNT THE SERVER RETURNED, NEVER THE COUNT THAT RAN. An operator whose cap
 * fired needs to know they have 12 targets, not merely that the cap is 9. THIS DEFINITION IS
 * WHAT MAKES THE INVARIANT BELOW AN INVARIANT RATHER THAN A TAUTOLOGY, AND IT MUST NOT CHANGE.
 *
 * `exitCodes` is the histogram -- strictly more informative than an ok/failed pair, which is
 * derivable from it. `complete` is `targets > 0 && every target exited 0`. `delayMs` is the
 * throttle actually used. `dryRun` is NOT cosmetic: a launchd environment file with
 * COLLECTOR_DRY_RUN set produces `complete:true, exitCode:0` FOREVER WHILE COLLECTING NOTHING,
 * and this is the one field that distinguishes that state. `error` is present only on a
 * whole-run failure.
 *
 * THERE IS NO `attempted` FIELD AND NO `ran` FIELD. Adding one is the obvious way to reconcile
 * the invariant, and it is the wrong one: it makes "how many ran" the headline number and
 * invites a later edit to redefine `targets` to match.
 */
export interface RunLine {
  kind: "run";
  targets: number;
  complete: boolean;
  exitCode: number;
  exitCodes: Record<string, number>;
  delayMs: number;
  dryRun: boolean;
  error?: string;
}

const histogram = (codes: readonly number[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const code of codes) {
    const key = String(code);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

/**
 * ONE definition, reached by the whole-run failure paths AND by the ordinary path, so that
 * `complete = failed === 0` -- which is TRUE for a zero-target run and for a cap refusal, where
 * `codes` is empty -- cannot be written in only one of them and survive. L-7 is the guard.
 */
const isComplete = (targets: number, codes: readonly number[]): boolean =>
  targets > 0 && codes.length === targets && codes.every((code) => code === EXIT_OK);

/**
 * THE INVARIANT HAS TWO CLAUSES AND BOTH ARE TOTAL:
 *
 *   error !== undefined  =>  exitCodes is EMPTY
 *   error === undefined  =>  sum(Object.values(exitCodes)) === targets
 *
 * The one-clause form ("the sum always equals targets") is FALSE on two of the four whole-run
 * failure paths -- cap-exceeded and null-market both report `targets:N` with an empty
 * `exitCodes` -- and stating it flatly is not a cosmetic error: an implementer reconciles it the
 * obvious way by redefining `targets` as the count that RAN, and under that redefinition the
 * natural `targets.filter(parseOk)` reports `complete:true`, exit 0, and SILENTLY STOPS ONE OF
 * THE USER'S SEARCHES while every other test still passes. The two-clause form is what makes a
 * dropped target unrepresentable. runTargets.test.ts L-11 asserts it as a property over every
 * case in that file.
 */
const wholeRunFailure = (
  config: RunAllTargetsConfig,
  targets: number,
  exitCode: number,
  error: string,
): RunLine => ({
  kind: "run",
  targets,
  complete: isComplete(targets, []),
  exitCode,
  exitCodes: histogram([]),
  delayMs: config.delayMs,
  dryRun: config.process.dryRun,
  error,
});

export const runAllTargets = async (
  config: RunAllTargetsConfig,
  dependencies: RunAllTargetsDependencies,
): Promise<number> => {
  const emit = (line: RunLine): number => {
    dependencies.log(JSON.stringify(line));
    return line.exitCode;
  };

  /**
   * PRINTED AS IT HAPPENS, not buffered: a process killed mid-run still leaves the record of
   * everything that completed. L-5 asserts target 1's line is out BEFORE the first sleep begins.
   */
  const emitTarget = (outcome: TargetOutcome): void => {
    dependencies.log(
      JSON.stringify({
        kind: "target",
        target: outcome.target,
        componentType: outcome.componentType,
        exitCode: outcome.exitCode,
        ...(outcome.summary ?? {}),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }),
    );
  };

  // REFUSED HERE, NOT IN main.ts, AND THAT PLACEMENT IS THE POINT: a negative delay makes
  // `sleep` a no-op and SILENTLY RESTORES THE BURST, so the check belongs where a test can
  // reach it. main.ts is the one file no unit test runs. A non-integer is refused for the same
  // reason -- `sleep(NaN)` is `setTimeout(NaN)`, which fires immediately.
  if (!Number.isInteger(config.delayMs) || config.delayMs < 0) {
    return emit(
      wholeRunFailure(
        config,
        0,
        EXIT_CONFIG,
        `the target delay must be a non-negative integer number of milliseconds: ${String(config.delayMs)}`,
      ),
    );
  }

  // The other end of the same check, and it is refused HERE for the same reason: a delay this
  // large cannot fit MAX_TARGETS_PER_RUN inside one schedule window, and the failure it causes
  // is a silently skipped window rather than anything an operator would notice.
  if (config.delayMs * (MAX_TARGETS_PER_RUN - 1) > SCHEDULE_WINDOW_MS) {
    return emit(
      wholeRunFailure(
        config,
        0,
        EXIT_CONFIG,
        `a target delay of ${config.delayMs} ms cannot fit ${MAX_TARGETS_PER_RUN} targets inside the ${SCHEDULE_WINDOW_MS} ms schedule window: ${config.delayMs * (MAX_TARGETS_PER_RUN - 1)} ms of waiting alone. Lengthen the cadence in the launchd plist, or lower the delay.`,
      ),
    );
  }

  const fetched = await dependencies.fetchTargets({
    apiBase: config.process.apiBase,
    token: config.process.token,
  });

  if (!fetched.ok) {
    // The SAME 4xx/5xx split postListings already draws: 4xx is a contract error and a human
    // must look; 5xx, a transport failure and a timeout are the server's problem and the next
    // run is the retry. A 200 of the wrong shape is a contract error too.
    return emit(
      wholeRunFailure(
        config,
        0,
        fetched.retryable ? EXIT_TRANSIENT : EXIT_CONTRACT,
        `the watch list could not be read (${fetched.reason}${
          fetched.status === null ? "" : `, status ${fetched.status}`
        }${fetched.code === null ? "" : `, ${fetched.code}`})`,
      ),
    );
  }

  const returned = fetched.targets.length;

  if (returned === 0) {
    // Exit 2's documented meaning is "nothing was fetched", which is exactly this.
    return emit(wholeRunFailure(config, 0, EXIT_CONFIG, "the watch list is empty"));
  }

  if (returned > MAX_TARGETS_PER_RUN) {
    return emit(
      wholeRunFailure(
        config,
        returned,
        EXIT_CONFIG,
        `the watch list holds ${returned} targets and MAX_TARGETS_PER_RUN is ${MAX_TARGETS_PER_RUN}: nothing was run. The cap is refused, never truncated -- a prefix would starve the same tail targets every run, forever. Trim the list, or lengthen the 30 minutes cadence.`,
      ),
    );
  }

  const market = parseMarket(fetched.market);
  if (!market.ok) {
    // NO DEFAULT MARKET IS EVER INVENTED. A wrong market collects into the wrong `market_key`
    // silently, and `targets` still reports the returned count so the operator is not told they
    // have zero targets when they have two.
    return emit(
      wholeRunFailure(config, returned, EXIT_CONFIG, `the watch market is unusable: ${market.reason}`),
    );
  }

  const outcomes: TargetOutcome[] = [];

  for (let index = 0; index < fetched.targets.length; index += 1) {
    // BETWEEN targets: not before the first, not after the last. Exactly N-1 sleeps, whatever
    // each target's outcome was.
    if (index > 0) await dependencies.sleep(config.delayMs);

    const raw = fetched.targets[index];
    const parsed = parseTarget(raw);

    if (!parsed.ok) {
      // A TARGET THAT FAILS VALIDATION IS STILL A RESULT, NEVER A REMOVAL. `filter(parseOk)` is
      // the natural implementation and it reports `complete:true`, exit 0 and a smaller
      // `targets` while one of the user's searches has silently stopped. L-9 is the guard.
      const failed: TargetOutcome = {
        target: readString(raw, "targetId"),
        componentType: readString(raw, "componentType"),
        exitCode: EXIT_CONFIG,
        error: parsed.reason,
      };
      outcomes.push(failed);
      emitTarget(failed);
      continue;
    }

    const target = parsed.value;
    const perTargetConfig: CollectorConfig = {
      ...config.process,
      ...market.value,
      ...target,
    };

    let outcome: TargetOutcome;
    try {
      const result = await dependencies.run(perTargetConfig);
      outcome = {
        target: target.targetId,
        componentType: target.componentType,
        exitCode: result.exitCode,
        summary: result.summary,
      };
    } catch (error) {
      // BELT AND BRACES for a throw `parseTarget` cannot anticipate. It is NOT the justification
      // for `parseTarget` -- see that function's docstring for the measured reason.
      outcome = {
        target: target.targetId,
        componentType: target.componentType,
        exitCode: EXIT_CONFIG,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    outcomes.push(outcome);
    emitTarget(outcome);
  }

  const codes = outcomes.map((outcome) => outcome.exitCode);

  return emit({
    kind: "run",
    targets: returned,
    complete: isComplete(returned, codes),
    exitCode: worstExitCode(codes),
    exitCodes: histogram(codes),
    delayMs: config.delayMs,
    dryRun: config.process.dryRun,
  });
};
