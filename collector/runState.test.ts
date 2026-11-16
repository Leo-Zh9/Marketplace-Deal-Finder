// @vitest-environment node

import {
  advanceState,
  CANARY_CLEAN_PROBES,
  CANARY_TARGETS,
  CONSECUTIVE_ALARM_RUNS,
  IMMEDIATE_REFUSAL_REASONS,
  MAX_CANARY_RUNS,
  maxPairOverlap,
  OVERLAP_ALARM_FRACTION,
  OVERLAP_MIN_DENOMINATOR,
  parseRunState,
  selectProbe,
  serializeRunState,
  type AdvanceInput,
  type RunState,
  type TargetRun,
} from "./runState.ts";
import { worstExitCode } from "./runTargets.ts";

const fresh = (over: Partial<RunState> = {}): RunState => ({
  version: 1,
  consecutive: {},
  alarm: {},
  probe: 0,
  canaryRuns: 0,
  ...over,
});

/**
 * A target that ran, with no ids. The default exit is 0, the ordinary clean case.
 *
 * `query` DEFAULTS TO THE TARGET ID, i.e. DISTINCT PER TARGET, which is what production looks
 * like: nine watch rows carrying nine DIFFERENT queries. It must be set, and the reason is worth
 * the line -- `maxPairOverlap` now skips pairs whose queries are identical, because two rows with
 * the same query make the same request and overlap 1.000 by construction. MEASURED: leaving this
 * `undefined` made `undefined === undefined` true for every pair and silently skipped ALL of
 * them, which turned thirteen overlap tests red at once. A test fixture that does not look like
 * production is how that guard would have been written backwards.
 */
const ran = (
  targetId: string,
  exitCode = 0,
  over: Partial<TargetRun> = {},
): TargetRun => ({
  targetId,
  exitCode,
  reason: exitCode === 0 ? "ok" : null,
  ids: [],
  query: targetId,
  ...over,
});

/**
 * `runs` real runs: `selectProbe` plans each, only the planned targets answer, and
 * `advanceState` folds the answers in. `cut` counts runs with the volume cut engaged.
 */
const simulate = (
  watchList: readonly string[],
  runs: number,
  answer: (targetId: string, run: number) => TargetRun,
) => {
  let state = fresh();
  let cut = 0;
  let requests = 0;
  for (let run = 0; run < runs; run += 1) {
    const plan = selectProbe(state, watchList);
    const answers = plan.indices.map((index) => answer(watchList[index], run));
    if (plan.canary) cut += 1;
    requests += answers.length;
    state = advanceState({
      state,
      watchList,
      ran: answers,
      canary: plan.canary,
      expired: plan.expired,
      nextProbe: plan.nextProbe,
    }).state;
  }
  return { state, cut, requests };
};

/** `n` distinct ids on a prefix. `ids("a", 24)` is a full page nothing else shares. */
const ids = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);

/**
 * A page of `count` ids of which the FIRST `shared` come from a common pool. This is how a
 * partial feed is expressed: `page("a", 24, 20)` and `page("b", 24, 20)` share exactly 20.
 */
const page = (prefix: string, count: number, shared: number): string[] => [
  ...Array.from({ length: shared }, (_value, index) => `shared-${index}`),
  ...Array.from({ length: count - shared }, (_value, index) => `${prefix}-own-${index}`),
];

/**
 * ONE RUN, with every target in the watch list having run unless `watchList` says otherwise.
 * Defaults are the ordinary full-run case, so each test states only what it is about.
 */
const advance = (over: Partial<AdvanceInput> & { ran: readonly TargetRun[] }) => {
  const watchList = over.watchList ?? over.ran.map((target) => target.targetId);
  return advanceState({
    state: over.state ?? fresh(),
    watchList,
    ran: over.ran,
    canary: over.canary ?? false,
    expired: over.expired ?? false,
    nextProbe: over.nextProbe ?? 0,
  });
};

/** Drive N runs of the same shape, folding the state forward. Returns every run's result. */
const runs = (count: number, shape: (index: number) => Partial<AdvanceInput> & { ran: readonly TargetRun[] }) => {
  let state = fresh();
  const results: ReturnType<typeof advance>[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = advance({ ...shape(index), state });
    state = result.state;
    results.push(result);
  }
  return results;
};

describe("the collector's cross-run state", () => {
  /* ---------- conditions 1 and 2: N consecutive at one target ---------- */

  /**
   * G-1: THREE CONSECUTIVE EXIT 3 AT ONE TARGET LATCH; TWO DO NOT.
   *
   * THE MUTATION IS `>=` -> `>` ON `CONSECUTIVE_ALARM_RUNS`, which turns N into 4 silently: the
   * three-run row reports `alarms: []` where `["source-empty:t1"]` is expected. Both rows are
   * needed -- the two-run row alone is satisfied by a guard that never fires at all.
   */
  it("G-1: three consecutive exit 3 at one target latch source-empty; two do not", () => {
    const results = runs(3, () => ({ ran: [ran("t1", 3), ran("t2", 0)] }));

    expect(results[0].causes).toEqual([]);
    expect(results[1].causes).toEqual([]);
    expect(results[2].causes).toEqual(["source-empty:t1"]);
    expect(results[2].state.consecutive.t1).toEqual({ sourceEmpty: 3, transient: 0 });
  });

  /**
   * G-2: ANY OTHER CODE RESETS THE COUNTER.
   *
   * THE MUTATION IS DELETING THE `= 0` RESET, under which a target empty on runs 1, 3 and 5
   * latches -- and "empty three times this week" is not the condition. `parseSearchPage.ts`'s
   * named gap is "SOURCE_EMPTY forever", which is consecutive by definition.
   */
  it("G-2: a target empty on runs 1, 3 and 5 never latches", () => {
    const results = runs(5, (index) => ({ ran: [ran("t1", index % 2 === 0 ? 3 : 0)] }));

    expect(results.map((result) => result.causes)).toEqual([[], [], [], [], []]);
    expect(results[4].state.consecutive.t1).toEqual({ sourceEmpty: 1, transient: 0 });
  });

  /**
   * G-3: THE COUNTERS ARE KEYED PER TARGET.
   *
   * THE MUTATION IS KEYING ON A CONSTANT instead of the target id, under which alternating
   * empties at t1, t2 and t3 latch on run 3 although NO TARGET WAS EMPTY TWICE.
   */
  it("G-3: three different targets empty once each never latch", () => {
    const results = runs(3, (index) => ({
      ran: [ran("t1", index === 0 ? 3 : 0), ran("t2", index === 1 ? 3 : 0), ran("t3", index === 2 ? 3 : 0)],
    }));

    expect(results[2].causes).toEqual([]);
    expect(results[2].state.consecutive).toEqual({
      t1: { sourceEmpty: 0, transient: 0 },
      t2: { sourceEmpty: 0, transient: 0 },
      t3: { sourceEmpty: 1, transient: 0 },
    });
  });

  /**
   * G-4: A RUN-LEVEL FOLD CANNOT MASK A PER-TARGET STREAK, AND THE MUTATION IS RUN HERE RATHER
   * THAN DESCRIBED.
   *
   * `worstExitCode` folds a run to ONE code. The mutation -- driving `advanceState` from
   * `worstExitCode(codes)` instead of per target -- is applied below as a second, parallel
   * computation, so this row shows the two answers DISAGREEING on the real log's own shape: t1
   * empty for three runs while t2 throws a single 5 on run 2. Under the fold the 5 wins run 2
   * and the streak resets; per target it does not.
   */
  it("G-4: t1 empty for 3 runs latches although another target's 5 folds the middle run", () => {
    const shape = (index: number) => [ran("t1", 3), ran("t2", index === 1 ? 5 : 0)];

    const perTarget = runs(3, (index) => ({ ran: shape(index) }));
    expect(perTarget[2].causes).toEqual(["source-empty:t1"]);

    // THE MUTANT, COMPUTED SIDE BY SIDE: one synthetic target carrying the folded code.
    const folded = runs(3, (index) => ({
      watchList: ["t1"],
      ran: [ran("t1", worstExitCode(shape(index).map((target) => target.exitCode)))],
    }));
    expect(folded[2].causes).toEqual([]);
    expect(worstExitCode([3, 5])).toBe(5);
  });

  /** G-5: the same N for exit 5, and `transient` is a separate counter from `sourceEmpty`. */
  it("G-5: three consecutive exit 5 at one target latch transient; two do not", () => {
    const results = runs(3, () => ({ ran: [ran("t1", 5)] }));

    expect(results[1].causes).toEqual([]);
    expect(results[2].causes).toEqual(["transient:t1"]);
    expect(results[2].state.consecutive.t1).toEqual({ sourceEmpty: 0, transient: 3 });
  });

  it("G-5b: an exit 3 run resets the transient counter and vice versa", () => {
    const results = runs(4, (index) => ({ ran: [ran("t1", index === 2 ? 3 : 5)] }));

    expect(results.map((result) => result.causes)).toEqual([[], [], [], []]);
    expect(results[3].state.consecutive.t1).toEqual({ sourceEmpty: 0, transient: 1 });
  });

  /**
   * G-6: `rate-limited` AND `blocked-redirect` LATCH ON THE FIRST OCCURRENCE.
   *
   * THE MUTATION IS DELETING THE `IMMEDIATE_REFUSAL_REASONS` CHECK, under which `alarms` is
   * empty after one run and the collector makes 27 FURTHER REQUESTS OVER 90 MINUTES INTO AN
   * ACTIVE REFUSAL before N=3 fires -- which is how a soft throttle becomes the hard block that
   * backing off afterwards cannot undo.
   *
   * THE THIRD ROW IS THE ONE THAT MAKES THE OTHER TWO MEAN ANYTHING: the real log's only exit 5
   * is a POST failure carrying `reason:"ok"`, and it must NOT latch on the first occurrence.
   */
  it.each<[string, string | null, string[]]>([
    ["rate-limited", "rate-limited", ["refused:t1"]],
    ["blocked-redirect", "blocked-redirect", ["refused:t1"]],
    ["an ordinary POST failure", "ok", []],
    ["no reason at all", null, []],
  ])("G-6: one exit 5 with reason %s raises %s", (_label, reason, expected) => {
    const result = advance({ ran: [ran("t1", 5, { reason })] });

    expect(result.causes).toEqual(expected);
  });

  it("G-6b: the two refusal reasons are exactly these two", () => {
    expect([...IMMEDIATE_REFUSAL_REASONS].sort()).toEqual(["blocked-redirect", "rate-limited"]);
  });

  /* ---------- condition 3: the within-run feed check ---------- */

  /**
   * G-7a/b: 20 of 24 LATCHES AND 19 OF 24 DOES NOT.
   *
   * THE MUTATIONS ARE 0.80 -> 0.85 (the 20/24 row goes silent) AND 0.80 -> 0.75 (the 19/24 row
   * latches where `[]` is expected).
   *
   * HONEST LIMIT, STATED RATHER THAN IMPLIED: these two rows kill a change of more than about
   * 4 % in either direction at n=24. THEY DO NOT CATCH 0.80 -> 0.82. The constant's derivation
   * is the record of where it came from; these rows pin the behaviour at the two counts the
   * measured baseline actually sits between.
   */
  it.each<[string, number, string[]]>([
    ["20 of 24 (0.833)", 20, ["feed-overlap:a+b"]],
    ["19 of 24 (0.792)", 19, []],
  ])("G-7: a pair sharing %s raises %s", (_label, shared, expected) => {
    const result = advance({
      ran: [
        ran("a", 0, { ids: page("a", 24, shared) }),
        ran("b", 0, { ids: page("b", 24, shared) }),
      ],
    });

    expect(result.causes).toEqual(expected);
    expect(result.overlap).toEqual({ a: "a", b: "b", shared, of: 24 });
  });

  it("G-7c: the shipped fraction is 0.80", () => {
    expect(OVERLAP_ALARM_FRACTION).toBe(0.8);
  });

  /**
   * G-8: SAME-COMPONENT-TYPE PAIRS ARE COMPARED.
   *
   * THE MUTATION IS A `componentType` GUARD -- `if (a.componentType === b.componentType)
   * continue` -- which is the natural "two gpu queries legitimately overlap" reading, and it is
   * STRUCTURALLY BLIND TO THE ONLY DEGRADATION EVER OBSERVED: three GPU queries (`rtx 4060`,
   * `rtx 3060`, `rtx 3070`) returning the identical three matched listings. Production runs
   * three gpu targets and two cpu targets.
   *
   * THE PAIR THE MUTATION WOULD EXCUSE IS MEASURED AT 0.458 IN PRODUCTION (`rtx` vs `graphics
   * card`, 6-7 proving runs) and `ryzen`/`cpu` at 0.042 over 13-14 -- so the guard would be
   * excusing pairs that have never come close to the trip point.
   *
   * `componentType` IS NOT A FIELD ON `TargetRun` AT ALL, which is what makes the mutation
   * require a deliberate widening rather than a one-word edit. The three targets below are the
   * three production gpu rows by name.
   */
  it("G-8: three gpu targets serving identical pages latch, with no component-type excuse", () => {
    const feed = ids("feed", 24);
    const result = advance({
      ran: [
        ran("gpu-radeon", 0, { ids: feed }),
        ran("gpu-rtx", 0, { ids: feed }),
        ran("gpu-toronto", 0, { ids: feed }),
      ],
    });

    expect(result.causes).toEqual(["feed-overlap:gpu-radeon+gpu-rtx"]);
    expect(Object.keys(result.state).sort()).not.toContain("componentType");
  });

  /**
   * G-9: ONE TRIPPED PAIR IS ENOUGH.
   *
   * THE MUTATION IS `tripped.length >= 2`, which is blind to a CPU-SCOPED feed: production has
   * exactly ONE cpu pair (`ryzen` + `cpu`), so a two-pair requirement cannot see a feed that
   * affects only the cpu targets. The run below is seven honest targets and one feeding pair.
   */
  it("G-9: one feeding pair among eight targets is enough to latch", () => {
    const feed = ids("feed", 24);
    const result = advance({
      ran: [
        ran("cpu-ryzen", 0, { ids: feed }),
        ran("cpu-toronto", 0, { ids: feed }),
        ...Array.from({ length: 6 }, (_value, index) =>
          ran(`other-${index}`, 0, { ids: ids(`other-${index}`, 24) }),
        ),
      ],
    });

    expect(result.causes).toEqual(["feed-overlap:cpu-ryzen+cpu-toronto"]);
  });

  /**
   * G-10: EMPTY ID SETS ARE EXCLUDED FROM THE PAIR LOOP.
   *
   * THE MUTATION IS INCLUDING THEM, which gives `0/0` -- `NaN`, which never trips and never says
   * why, or `1` if an implementation reaches for a guard, which trips always. TWO SOURCE_EMPTY
   * TARGETS ARE NOT A FEED, and a run in which every target came back empty is the exact shape
   * of condition 1.
   */
  it("G-10: two empty targets raise no feed cause and report no overlap", () => {
    const result = advance({ ran: [ran("a", 3), ran("b", 3)] });

    expect(result.causes).toEqual([]);
    expect(result.overlap).toBeNull();
  });

  it("G-10b: one empty target beside two real ones is skipped, not counted as a match", () => {
    const feed = ids("feed", 24);
    const result = advance({
      ran: [ran("empty", 3), ran("a", 0, { ids: feed }), ran("b", 0, { ids: feed })],
    });

    expect(result.overlap).toEqual({ a: "a", b: "b", shared: 24, of: 24 });
  });

  /**
   * G-17: THE FLOOR. A PAIR AT 4 OF 5 DOES NOT LATCH; A PAIR AT 10 OF 12 DOES.
   *
   * THE MUTATION IS DELETING THE `OVERLAP_MIN_DENOMINATOR` GUARD, under which 4 of 5 trips --
   * and 4 of 5 on a thin day is market behaviour, not a feed. The fraction was derived from a
   * COUNT (20) at n~24, and the observed `parsed` values over 460 target-runs are ONLY 0, 24 and
   * 25: no denominator between 1 and 23 has ever been seen, so every value below 24 is
   * extrapolation and the rule must REFUSE to evaluate rather than guess.
   *
   * 12 IS THE BOUNDARY AND BOTH SIDES OF IT ARE HERE: at n=12 the margin is 0.175 x 12 = 2.1
   * listings, which is the two the derivation requires; at n=11 it is 1.925.
   */
  it.each<[string, number, number, string[]]>([
    ["4 of 5", 5, 4, []],
    ["10 of 11, one below the floor", 11, 10, []],
    ["10 of 12, exactly at the floor", 12, 10, ["feed-overlap:a+b"]],
    ["9 of 12, at the floor but under the fraction", 12, 9, []],
  ])("G-17: a pair at %s raises %s", (_label, count, shared, expected) => {
    const result = advance({
      ran: [
        ran("a", 0, { ids: page("a", count, shared) }),
        ran("b", 0, { ids: page("b", count, shared) }),
      ],
    });

    expect(result.causes).toEqual(expected);
    // THE MEASUREMENT IS REPORTED EITHER WAY, which is what makes the empty `causes` above
    // evidence that the FLOOR declined rather than that nothing ran.
    expect(result.overlap).toEqual({ a: "a", b: "b", shared, of: count });
  });

  it("G-17b: the shipped floor is 12", () => {
    expect(OVERLAP_MIN_DENOMINATOR).toBe(12);
  });

  /**
   * G-18: A GLOBAL FEED RECORDS EXACTLY ONE CAUSE -- THE WORST PAIR, TIES BY WATCH-LIST ORDER.
   *
   * THE MUTATION IS RECORDING EVERY TRIPPED PAIR: `Object.keys(state.alarm).length` becomes 36
   * on nine targets, the cause set becomes the whole watch list, and the clear condition becomes
   * 36 independent probes -- roughly 72 runs, or a day and a half at 2 targets per run.
   */
  it("G-18: nine targets on one feed record ONE cause, not 36", () => {
    const feed = ids("feed", 24);
    const nine = Array.from({ length: 9 }, (_value, index) =>
      ran(`t${index}`, 0, { ids: feed }),
    );

    const result = advance({ ran: nine });

    expect(Object.keys(result.state.alarm)).toHaveLength(1);
    expect(result.causes).toEqual(["feed-overlap:t0+t1"]);
  });

  /**
   * G-18b: THE WORST PAIR WINS WHEN THERE IS A WORST PAIR. Three targets: a+b share 24 of 24 and
   * a+c share 20 of 24, so the recorded cause must name a+b. A tie-only test would pass against
   * an implementation that returned the LAST pair it looked at.
   */
  it("G-18b: the recorded pair is the one with the highest coefficient", () => {
    const result = advance({
      ran: [
        ran("a", 0, { ids: page("a", 24, 24) }),
        ran("b", 0, { ids: page("b", 24, 24) }),
        ran("c", 0, { ids: page("c", 24, 20) }),
      ],
    });

    expect(result.overlap).toEqual({ a: "a", b: "b", shared: 24, of: 24 });
    expect(result.causes).toEqual(["feed-overlap:a+b"]);
  });

  /** `maxPairOverlap` directly: it is exported, and the coefficient is over `min`, not Jaccard. */
  it("G-18c: the denominator is min(|A|,|B|), which is the coefficient and not Jaccard", () => {
    const overlap = maxPairOverlap([
      ran("a", 0, { ids: [...ids("shared", 20), ...ids("a-own", 4)] }),
      ran("b", 0, { ids: ids("shared", 20) }),
    ]);

    // 20 shared of min(24, 20) = 20 -> 1.000. Jaccard would be 20/24 = 0.833.
    expect(overlap).toEqual({ a: "a", b: "b", shared: 20, of: 20 });
  });

  /* ---------- clearing, and the oscillation it must not produce ---------- */

  /**
   * G-11: A CAUSE CLEARS ONLY WHEN ITS OWN CAUSE IS RE-MEASURED CLEAN.
   *
   * THE MUTATION IS CREDITING `cleanProbes` FOR ANY CLEAN RUN, and this is the walkthrough that
   * killed the rotation design: `source-empty:mobo` is latched, the probe runs two CPU targets,
   * both come back clean, `cleanProbes` reaches 2, THE ALARM CLEARS -- AND `mobo` NEVER RAN.
   * The guard then delivers neither the volume cut nor a stable alarm.
   */
  it("G-11: two clean probes of OTHER targets do not clear source-empty:mobo", () => {
    let state = fresh({
      consecutive: { mobo: { sourceEmpty: 3, transient: 0 } },
      alarm: { "source-empty:mobo": { runs: 4, cleanProbes: 0 } },
    });

    for (let index = 0; index < 2; index += 1) {
      const result = advance({
        state,
        watchList: ["cpu-a", "cpu-b", "mobo"],
        ran: [ran("cpu-a"), ran("cpu-b")],
        canary: true,
      });
      state = result.state;
      expect(result.causes).toEqual(["source-empty:mobo"]);
    }

    expect(state.alarm["source-empty:mobo"]).toEqual({ runs: 6, cleanProbes: 0 });
  });

  it("G-11b: two clean probes OF MOBO do clear it", () => {
    let state = fresh({
      consecutive: { mobo: { sourceEmpty: 3, transient: 0 } },
      alarm: { "source-empty:mobo": { runs: 4, cleanProbes: 0 } },
    });

    const first = advance({
      state,
      watchList: ["cpu-a", "cpu-b", "mobo"],
      ran: [ran("mobo")],
      canary: true,
    });
    expect(first.causes).toEqual(["source-empty:mobo"]);
    expect(first.state.alarm["source-empty:mobo"].cleanProbes).toBe(1);
    state = first.state;

    const second = advance({
      state,
      watchList: ["cpu-a", "cpu-b", "mobo"],
      ran: [ran("mobo")],
      canary: true,
    });
    expect(second.causes).toEqual([]);
    expect(second.state.alarm).toEqual({});
  });

  /**
   * G-12: AN UNMEASURED CAUSE GETS NO CREDIT.
   *
   * THE MUTATION IS ADVANCING `cleanProbes` UNCONDITIONALLY, under which a ONE-TARGET probe
   * clears a `feed-overlap` cause -- a pair cannot be measured by running half of it, which is
   * exactly why CANARY_TARGETS is 2 and not 1.
   */
  it("G-12: a probe of half a feed pair never clears it, however often it runs", () => {
    let state = fresh({ alarm: { "feed-overlap:a+b": { runs: 2, cleanProbes: 0 } } });

    for (let index = 0; index < 5; index += 1) {
      const result = advance({
        state,
        watchList: ["a", "b", "c"],
        ran: [ran("a", 0, { ids: ids("a", 24) })],
        canary: true,
      });
      state = result.state;
      expect(result.causes).toEqual(["feed-overlap:a+b"]);
    }

    expect(state.alarm["feed-overlap:a+b"].cleanProbes).toBe(0);
  });

  it("G-12b: a probe of BOTH halves whose pages are now disjoint clears it in two runs", () => {
    let state = fresh({ alarm: { "feed-overlap:a+b": { runs: 2, cleanProbes: 0 } } });

    for (let index = 0; index < CANARY_CLEAN_PROBES; index += 1) {
      const result = advance({
        state,
        watchList: ["a", "b", "c"],
        ran: [ran("a", 0, { ids: ids("a", 24) }), ran("b", 0, { ids: ids("b", 24) })],
        canary: true,
      });
      state = result.state;
    }

    expect(state.alarm).toEqual({});
  });

  /**
   * G-12c: A PROBE OF BOTH HALVES WHOSE PAGES CAME BACK TOO THIN MEASURES NOTHING. The pair's
   * clean condition carries the same floor the trip does, so 5 ids each is no evidence either
   * way -- crediting it would clear a feed alarm off a quiet market.
   */
  it("G-12c: a probe of both halves below the floor earns no credit", () => {
    const result = advance({
      state: fresh({ alarm: { "feed-overlap:a+b": { runs: 2, cleanProbes: 0 } } }),
      watchList: ["a", "b", "c"],
      ran: [ran("a", 0, { ids: ids("a", 5) }), ran("b", 0, { ids: ids("b", 5) })],
      canary: true,
    });

    expect(result.causes).toEqual(["feed-overlap:a+b"]);
    expect(result.state.alarm["feed-overlap:a+b"].cleanProbes).toBe(0);
  });

  /**
   * G-16: CLEARING A CAUSE RESETS THAT TARGET'S `consecutive` COUNTERS -- BOTH OF THEM.
   *
   * MEASURED CORRECTION TO THE REASON THIS RESET WAS RULED IN, AND IT NARROWS THE CLAIM RATHER
   * THAN THE RULE. The reset was ruled in to stop an oscillation: a cleared cause re-latching on
   * the very next dirty full run, giving a period-3 cycle (9 -> 2 -> 2 -> 9 -> ...) that delivers
   * neither the volume cut nor a stable alarm. THE FIRST VERSION OF THIS TEST ASSERTED EXACTLY
   * THAT AND COULD NOT BE MADE TO FAIL: deleting the reset left it green. The reason is that
   * `source-empty:t` clears only when `t`'s exit is NOT 3, and the ordinary counter update
   * already zeroes `sourceEmpty` on any exit that is not 3 -- so for a cause clearing on its OWN
   * condition the reset is REDUNDANT, and the oscillation it was ruled in to prevent is
   * prevented by the counter update instead.
   *
   * WHERE IT IS OBSERVABLE, AND THEREFORE WHAT IT ACTUALLY DOES, IS ACROSS CONDITIONS AT ONE
   * TARGET. A target can be accumulating a `source-empty` streak while its `transient` cause
   * clears -- the two counters move on different exit codes -- and the reset wipes the
   * `source-empty` progress along with the cause that cleared. That is the ruled behaviour
   * ("that target's `consecutive` counters reset to 0", plural) and it is the only shape that can
   * go green-to-red, so it is what this row drives.
   *
   * THE MUTATION IS DROPPING THE RESET: run 2 below then latches `source-empty:t1` off a streak
   * that was two runs old when an unrelated cause cleared.
   */
  it("G-16: clearing a feed cause also resets its targets' transient streaks", () => {
    /**
     * THE RESET'S REACHABLE CASE NARROWED AGAIN WHEN THE CLEAN PREDICATE GAINED ITS POSITIVE-
     * EVIDENCE REQUIREMENT, AND THIS IS THE THIRD DRAFT OF THIS ROW. Recorded because the
     * narrowing IS the finding:
     *
     *   Draft 1 asserted the oscillation and could not be made to fail -- the ordinary counter
     *   update already zeroes a counter on any exit that is not its own code.
     *   Draft 2 drove `transient:t1` clearing while `sourceEmpty` accumulated on an exit 3. That
     *   is now UNREACHABLE: an exit 3 is no longer positive evidence of anything, so it cannot
     *   clear a transient cause at all.
     *
     * WHAT IS LEFT IS THE ONE CROSSING THAT SURVIVES, and it is a real production shape: a
     * `feed-overlap` pair clears while BOTH its targets are failing their POSTs. Exit 5 after a
     * SUCCESS parse populates `listingIds` (R-2b), so the pair IS measurable and the feed really
     * did go away -- while `transient` climbs on both targets, because the Worker is 5xx-ing.
     * Dropping the cause resets both counters; without the reset a third such run latches
     * `transient:a` off a streak the operator has no new evidence for.
     */
    let state = fresh({
      consecutive: { a: { sourceEmpty: 0, transient: 0 }, b: { sourceEmpty: 0, transient: 0 } },
      alarm: { "feed-overlap:a+b": { runs: 4, cleanProbes: 0 } },
    });

    // Two clean probes of the pair, both targets exiting 5 on a FAILED POST after a good parse.
    for (let index = 0; index < CANARY_CLEAN_PROBES; index += 1) {
      const result = advance({
        state,
        watchList: ["a", "b", "c"],
        ran: [
          ran("a", 5, { reason: "ok", ids: ids("a", 24) }),
          ran("b", 5, { reason: "ok", ids: ids("b", 24) }),
        ],
        canary: true,
      });
      state = result.state;
    }

    expect(state.alarm).toEqual({});
    // THE ASSERTION: both counters are back to 0 although this run drove them UP to 2.
    expect(state.consecutive.a).toEqual({ sourceEmpty: 0, transient: 0 });
    expect(state.consecutive.b).toEqual({ sourceEmpty: 0, transient: 0 });

    // ...and the consequence, which is what the reset is for: one more exit 5 does not latch.
    const next = advance({
      state,
      watchList: ["a", "b", "c"],
      ran: [ran("a", 5, { reason: "ok", ids: ids("a", 24) }), ran("b", 5, { reason: "ok", ids: ids("b", 24) })],
    });
    expect(next.causes).toEqual([]);
  });

  /* ---------- the clean predicate needs POSITIVE evidence, not a negation ---------- */

  /**
   * G-23: EXIT 2 AND EXIT 4 ARE NOT CLEAN PROBES OF ANYTHING, AND THIS IS THE SHARPEST ROW IN
   * THE FILE.
   *
   * THE MUTATION IS A PURE NEGATION of the cause's own exit code -- `exitCode !== 3`,
   * `exitCode !== 5`, `!refused(t)` -- which is the obvious implementation and was the shipped
   * one. Under it NEITHER exit 2 (the row was unusable) NOR exit 4 (the page changed shape,
   * nothing posted) is the cause's own code, so both counted as evidence of recovery.
   *
   * THE `refused` ROW IS THE ONE THAT MATTERS. Facebook escalating a 429 into a checkpoint page
   * is an exit 4, and two of them cleared `refused:a` -- sending the collector back to nine
   * requests per run INTO AN ACTIVE REFUSAL, which invariant 5 calls the one loss that backing
   * off afterwards cannot undo.
   */
  it.each<[string]>([["source-empty:a"], ["transient:a"], ["refused:a"]])(
    "G-23: %s survives any number of exit-2 and exit-4 runs",
    (cause) => {
      let state = fresh({ alarm: { [cause]: { runs: 4, cleanProbes: 0 } } });

      for (const exitCode of [2, 4, 2, 4, 2, 4]) {
        const result = advance({
          state,
          watchList: ["a", "b"],
          ran: [ran("a", exitCode)],
          canary: true,
        });
        state = result.state;
        expect(result.causes).toEqual([cause]);
      }

      expect(state.alarm[cause].cleanProbes).toBe(0);
    },
  );

  /**
   * G-23b: THE OSCILLATION A NEGATION PRODUCED, MEASURED AS VOLUME.
   *
   * A target alternating 3,3,3,5,5 forever held the latch on only 40 % of runs under the
   * negation, because each condition read the OTHER condition's failure as its own recovery:
   * the exit 5s cleared `source-empty:a` and the exit 3s cleared `transient:a`, turn and turn
   * about. 232 requests over 40 runs against a 360 baseline -- neither the 78 % cut nor a stable
   * alarm, which is the period-cycle this design was chosen to avoid.
   *
   * THE ASSERTION IS THE FRACTION OF RUNS UNDER THE CUT, not a counter, because the fraction is
   * what the operator pays.
   */
  it("G-23b: a target alternating 3,3,3,5,5 holds a latch on every run after the third", () => {
    const pattern = [3, 3, 3, 5, 5];
    const watchList = Array.from({ length: 9 }, (_value, index) => `t${index}`);
    let state = fresh();
    let latchedRuns = 0;

    for (let index = 0; index < 40; index += 1) {
      const exitCode = pattern[index % pattern.length];
      const plan = selectProbe(state, watchList);
      const running = plan.indices.map((position) => watchList[position]);
      const result = advance({
        state,
        watchList,
        ran: running.map((targetId) =>
          ran(targetId, targetId === "t0" ? exitCode : 0, { reason: "ok", ids: ids(targetId, 24) }),
        ),
        canary: plan.canary,
        expired: plan.expired,
        nextProbe: plan.nextProbe,
      });
      state = result.state;
      if (result.causes.length > 0) latchedRuns += 1;
    }

    // Runs 1 and 2 build the streak; every run from the third onwards is latched.
    expect(latchedRuns).toBe(38);
    expect(Object.keys(state.alarm)).toContain("source-empty:t0");
  });

  /**
   * G-23c: EXIT 6 *IS* A CLEAN PROBE, and that is not a loophole.
   *
   * At a target, exit 6 is reachable ONLY after `classifyParsedPage` returned SUCCESS -- the POST
   * was refused 4xx, or answered 200 with FAILED > 0. So the SOURCE was fetched and parsed and
   * only the Worker write failed. Refusing to count it would make a Worker-side contract break
   * pin a source alarm indefinitely, which is the opposite error: the collector would be unable
   * to tell the operator that Facebook had recovered because its own backend was broken.
   */
  it("G-23c: two exit-6 runs clear a source-empty cause", () => {
    let state = fresh({
      consecutive: { a: { sourceEmpty: 3, transient: 0 } },
      alarm: { "source-empty:a": { runs: 4, cleanProbes: 0 } },
    });

    for (let index = 0; index < CANARY_CLEAN_PROBES; index += 1) {
      const result = advance({ state, watchList: ["a", "b"], ran: [ran("a", 6)], canary: true });
      state = result.state;
    }

    expect(state.alarm).toEqual({});
  });

  /* ---------- two rows with the same query are one search, not a feed ---------- */

  /**
   * G-24: TWO WATCH ROWS CARRYING THE SAME QUERY ARE NOT A GENERIC FEED.
   *
   * `buildSearchUrl` reads the query, the location, the limit, the radius and the day window --
   * NOT the component type -- so `('gpu','rtx')` and `('cpu','rtx')` fetch the IDENTICAL URL and
   * their id sets are identical by construction. Without the guard the pair trips on the first
   * run and can never be re-measured clean, because the next probe fetches the same URL twice
   * again: a PERMANENT 78 % volume cut, explained to the operator as a generic feed when the real
   * fault is two watch rows that should be one.
   *
   * THE SECOND ROW IS WHAT STOPS THE GUARD BEING WRITTEN TOO WIDE: two DIFFERENT queries that
   * happen to return the same page are exactly the degradation this slice exists to detect, and
   * must still latch.
   */
  /**
   * THE COMPARISON IS NORMALISED, NOT BYTE-FOR-BYTE, AND THE THREE CASING/WHITESPACE ROWS BELOW
   * ARE EACH REACHABLE THROUGH THE SHIPPED SAVE PATH. `worker/api/watch.ts` validates a query
   * with `typeof query === "string" && query.trim() !== ""` and then stores the UNTRIMMED string,
   * and its `searchKey` is `JSON.stringify([componentType, query])` -- so `('gpu','rtx')` and
   * `('cpu','rtx ')` are two distinct, storable rows that make ONE Facebook request, because
   * Facebook's search trims and is case-insensitive. A byte comparison skipped only the first of
   * these and left the other two tripping 1.000 on every run and never clearing.
   */
  it.each<[string, string, string, string[]]>([
    ["the same query under two types", "rtx", "rtx", []],
    ["the same query in different case", "rtx", "RTX", []],
    ["the same query with a trailing space", "rtx", "rtx ", []],
    ["the same query with both", " RTX  ", "rtx", []],
    ["two different queries", "rtx", "radeon", ["feed-overlap:a+b"]],
    ["two queries differing by more than space", "rtx", "rtx 4060", ["feed-overlap:a+b"]],
  ])("G-24: %s raises %s", (_label, queryA, queryB, expected) => {
    const feed = ids("feed", 24);
    const result = advance({
      ran: [
        ran("a", 0, { ids: feed, query: queryA }),
        ran("b", 0, { ids: feed, query: queryB }),
      ],
    });

    expect(result.causes).toEqual(expected);
  });

  /**
   * G-24b: AN EMPTY QUERY IS "NO QUERY", AND WHITESPACE IS EMPTY. `trim()` runs BEFORE the
   * emptiness test, which is the same decision `worker/api/watch.ts`'s own `trim() !== ""` guard
   * already makes. Two rows with nothing to compare are not "the same search", so the pair is
   * still measured.
   *
   * SCOPE: THIS PINS `advanceState`, NOT A PRODUCTION PATH. Through `runTargets` the exclusion is
   * belt-and-braces: a target that failed validation has no `listingIds`, so its `ids` are empty
   * and `maxPairOverlap` already skips the pair; and a validated target always has a non-empty
   * trimmed query, because `parseTarget` requires one. Only a direct `advanceState` call, which
   * is what these rows make, reaches the guard with two empty queries.
   */
  it.each<[string, string, string]>([
    ["two empty queries", "", ""],
    ["two whitespace-only queries", "   ", "\t"],
    ["one empty and one real", "", "rtx"],
  ])("G-24b: %s leaves the pair measured", (_label, queryA, queryB) => {
    const feed = ids("feed", 24);
    const result = advance({
      ran: [ran("a", 0, { ids: feed, query: queryA }), ran("b", 0, { ids: feed, query: queryB })],
    });

    expect(result.causes).toEqual(["feed-overlap:a+b"]);
  });

  /**
   * G-25: AN ALREADY-LATCHED PAIR WHOSE ROWS BECOME ONE SEARCH IS DROPPED, NOT PINNED FOREVER.
   *
   * THIS DEFECT WAS CREATED BY THE SAME-QUERY SKIP ITSELF, which is why the row exists. The skip
   * lives in `maxPairOverlap`, and the feed branch's `measured` test calls it -- so editing both
   * rows of a latched pair down to one query makes the pair unmeasurable, which the branch read
   * as "no evidence" and left the cause standing. MEASURED before the fix: eight consecutive
   * spotless probe runs and `feed-overlap:a+b` survived all eight, with
   * `rm ~/.marketplace-collector-state.json` the only escape -- a permanent 78 % volume cut the
   * operator cannot clear by fixing the configuration that caused it.
   *
   * DROPPING IS THE PRUNE'S TREATMENT: the question the cause asks has become unanswerable, so
   * holding the collector at 2 of 9 waiting for an answer is the one thing that cannot be right.
   * IT IS NOT CREDITED AS A CLEAN PROBE -- the second assertion is that the targets' unrelated
   * `consecutive` counters are left exactly as they were, because this says nothing about them.
   */
  it.each<[string, string, string]>([
    ["byte-identical", "rtx", "rtx"],
    ["differing only in case", "rtx", "RTX"],
    ["differing only in whitespace", "rtx", " rtx "],
  ])("G-25: a latched pair whose queries become %s is dropped on the next probe", (_label, queryA, queryB) => {
    /**
     * BOTH TARGETS EXIT 5 ON A FAILED POST, AND THAT CHOICE IS WHAT MAKES THE SECOND ASSERTION
     * ABLE TO FAIL. MEASURED: the first draft had them exit 0, and routing this drop through the
     * clean-probe path (which resets counters) SURVIVED -- because an exit 0 zeroes `transient`
     * in the ordinary counter update anyway, so the reset was invisible. A test whose input
     * cannot distinguish the two paths is not a test of the difference between them.
     *
     * Exit 5 after a SUCCESS parse CLIMBS `transient` instead, so whether the drop resets it is
     * observable: 1 -> 2 and stays 2 here, or 1 -> 2 -> 0 under the mutation.
     */
    const result = advance({
      state: fresh({
        consecutive: { a: { sourceEmpty: 0, transient: 1 }, b: { sourceEmpty: 0, transient: 0 } },
        alarm: { "feed-overlap:a+b": { runs: 9, cleanProbes: 0 } },
      }),
      watchList: ["a", "b", "c"],
      ran: [
        ran("a", 5, { reason: "ok", ids: ids("feed", 24), query: queryA }),
        ran("b", 5, { reason: "ok", ids: ids("feed", 24), query: queryB }),
      ],
      canary: true,
    });

    expect(result.causes).toEqual([]);
    expect(result.state.alarm).toEqual({});
    // NOT CREDITED AS A CLEAN PROBE: `a`'s unrelated transient streak is real evidence about
    // something else -- the Worker is 5xx-ing -- and it survives, exactly as it does when the
    // prune removes a cause naming a deleted target.
    expect(result.state.consecutive.a).toEqual({ sourceEmpty: 0, transient: 2 });
    expect(result.state.consecutive.b).toEqual({ sourceEmpty: 0, transient: 1 });
  });

  /**
   * G-25b: AND IT IS NOT A BACK DOOR. A latched pair whose queries are still DIFFERENT is dropped
   * only by the ordinary clean-probe route, so this row is what stops the fix from being "any
   * feed cause clears on the next probe".
   *
   * WHAT IT PINS, EXACTLY: that the drop condition contains the equality test at all. Removing
   * it (drop every feed cause on its next probe) turns this row red. It does NOT pin `every`
   * over "any two equal": `raise` only writes `feed-overlap:<a>+<b>`, so a cause always names
   * two targets, and at two the forms are logically identical. No test can tell them apart.
   */
  it("G-25b: a latched pair with different queries still needs real clean probes", () => {
    const state = fresh({ alarm: { "feed-overlap:a+b": { runs: 9, cleanProbes: 0 } } });
    const dirty = advance({
      state,
      watchList: ["a", "b", "c"],
      ran: [
        ran("a", 0, { ids: ids("feed", 24), query: "rtx" }),
        ran("b", 0, { ids: ids("feed", 24), query: "radeon" }),
      ],
      canary: true,
    });

    expect(dirty.causes).toEqual(["feed-overlap:a+b"]);
    expect(dirty.state.alarm["feed-overlap:a+b"].cleanProbes).toBe(0);
  });

  /**
   * G-16b: AND THE OSCILLATION IS STILL ASSERTED, because it is the property that matters even
   * though the counter update is what prevents it.
   *
   * LABELLED, SO THE NEXT READER DOES NOT MISTAKE IT FOR A LIVE GUARD: THIS ROW HAS NO CURRENT
   * KILLER. It is a PROPERTY, kept deliberately. Deleting the `consecutive` reset -- the edit it
   * reads as being about -- leaves it green, because the ordinary counter update already zeroes
   * `sourceEmpty` on any exit that is not 3 (G-16 is the row that goes red for that edit, and it
   * had to be rewritten to the cross-condition case to get there). What this row WOULD catch is
   * the OTHER way to reintroduce the period-3 cycle: an edit that made a clean measurement stop
   * zeroing the counter. No mutation of the reset can reach it, and that is the point of keeping
   * it rather than deleting it as unkillable.
   */
  it("G-16b: a cleared source-empty cause does not re-latch on the next dirty run", () => {
    const cleared = advance({
      state: fresh({
        consecutive: { t1: { sourceEmpty: CONSECUTIVE_ALARM_RUNS, transient: 0 } },
        alarm: { "source-empty:t1": { runs: 4, cleanProbes: CANARY_CLEAN_PROBES - 1 } },
      }),
      watchList: ["t1", "t2"],
      ran: [ran("t1")],
      canary: true,
    });
    expect(cleared.causes).toEqual([]);
    expect(cleared.state.consecutive.t1).toEqual({ sourceEmpty: 0, transient: 0 });

    const first = advance({ state: cleared.state, ran: [ran("t1", 3), ran("t2")] });
    expect(first.causes).toEqual([]);
    const second = advance({ state: first.state, ran: [ran("t1", 3), ran("t2")] });
    expect(second.causes).toEqual([]);
    const third = advance({ state: second.state, ran: [ran("t1", 3), ran("t2")] });
    expect(third.causes).toEqual(["source-empty:t1"]);
  });

  /* ---------- the volume cut, which is a separate state machine ---------- */

  /**
   * G-19: AT `MAX_CANARY_RUNS` THE RUN IS FULL, AND THE ALARM STANDS.
   *
   * THE MUTATION IS CLEARING `state.alarm` ON EXPIRY, under which `state.alarm` is `{}` where
   * the cause is expected -- the expiry would become a SECOND recovery mechanism racing the
   * clean-probe count, which is the design this one was rejected in favour of. The expiry flips
   * ONLY the volume cut; the cause is cleared only by CANARY_CLEAN_PROBES clean measurements.
   */
  it("G-19: the expiry run is full and leaves the cause latched", () => {
    const state = fresh({
      canaryRuns: MAX_CANARY_RUNS,
      alarm: { "source-empty:t4": { runs: 52, cleanProbes: 0 } },
    });
    const watchList = Array.from({ length: 9 }, (_value, index) => `t${index}`);

    const plan = selectProbe(state, watchList);
    expect(plan.expired).toBe(true);
    expect(plan.canary).toBe(false);
    expect(plan.indices).toHaveLength(9);

    const result = advance({
      state,
      watchList,
      ran: watchList.map((targetId) => ran(targetId, targetId === "t4" ? 3 : 0)),
      canary: false,
      expired: true,
    });

    expect(result.causes).toEqual(["source-empty:t4"]);
    expect(result.state.canaryRuns).toBe(0);
  });

  it("G-19b: one run below the bound is still a probe", () => {
    const plan = selectProbe(
      fresh({
        canaryRuns: MAX_CANARY_RUNS - 1,
        alarm: { "source-empty:t4": { runs: 51, cleanProbes: 0 } },
      }),
      Array.from({ length: 9 }, (_value, index) => `t${index}`),
    );

    expect(plan.expired).toBe(false);
    expect(plan.canary).toBe(true);
    // TWO targets, not one: the cause's own target plus one topped up from watch-list order.
    // A ONE-target probe cannot measure a pair, which is the whole reason CANARY_TARGETS is 2.
    expect(plan.indices).toEqual([0, 4]);
  });

  /**
   * G-20: A `refused:*` CAUSE NEVER EXPIRES.
   *
   * THE MUTATION IS DROPPING THE EXEMPTION, under which the run goes FULL at
   * `canaryRuns = MAX_CANARY_RUNS` with a refusal latched -- NINE REQUESTS INTO AN ACTIVE
   * REFUSAL. That is invariant 5's case: Facebook has refused this IP, and losing it is not
   * recoverable by backing off afterwards, so staying low is the entire point.
   *
   * THE SECOND ROW IS WHAT STOPS THE EXEMPTION BEING WRITTEN TOO WIDE: with a `source-empty`
   * cause and the same counter the run IS full, so the exemption is about `refused:` and not
   * about "any cause".
   */
  it.each<[string, string, boolean]>([
    ["refused:t4", "refused:t4", false],
    ["source-empty:t4", "source-empty:t4", true],
  ])("G-20: at the bound with %s latched, expired is %s", (_label, cause, expired) => {
    const plan = selectProbe(
      fresh({ canaryRuns: MAX_CANARY_RUNS, alarm: { [cause]: { runs: 52, cleanProbes: 0 } } }),
      Array.from({ length: 9 }, (_value, index) => `t${index}`),
    );

    expect(plan.expired).toBe(expired);
    expect(plan.canary).toBe(!expired);
  });

  it("G-20b: a refusal beside an ordinary cause still exempts the whole run", () => {
    const plan = selectProbe(
      fresh({
        canaryRuns: MAX_CANARY_RUNS,
        alarm: {
          "refused:t4": { runs: 52, cleanProbes: 0 },
          "source-empty:t7": { runs: 52, cleanProbes: 0 },
        },
      }),
      Array.from({ length: 9 }, (_value, index) => `t${index}`),
    );

    expect(plan.expired).toBe(false);
    expect(plan.canary).toBe(true);
  });

  /**
   * G-19d: THE BOUND'S POSITION, AT LITERAL RUN COUNTS.
   *
   * THIS ROW EXISTS BECAUSE EVERY OTHER TEST OF THE EXPIRY WAS SELF-FULFILLING, AND THAT WAS
   * MEASURED RATHER THAN SUSPECTED. G-19, G-19b, G-19c, G-20 and runTargets' L-27 all seed
   * `canaryRuns` as `MAX_CANARY_RUNS` or `MAX_CANARY_RUNS - 1` -- so moving the constant moves
   * the input with it and every one of them stays green. `MAX_CANARY_RUNS = 480` turned exactly
   * ONE test red out of 132: the literal pin below. A pin is a record of the value, not a
   * measurement of where the boundary SITS.
   *
   * THAT GAP IS THE EXPENSIVE ONE ON THIS PARTICULAR CONSTANT. Its entire derivation is that the
   * probe re-asks the same question every run while a FULL run is the measurement
   * OVERLAP_ALARM_FRACTION's Leg 2 needs -- 48 buys one full run per day for 9 requests per 49
   * runs. An edit to 480 silently turns that into one full run per TEN days, which is the
   * "discovered days later" failure the whole guard shape was chosen to avoid, and the 36-pair
   * matrix the threshold is re-derived from stops arriving.
   *
   * THE THREE ROWS ARE LITERALS ON PURPOSE and they pin the comparison as `>=` rather than `>`:
   * 47 is still a probe, 48 is the full run, 49 is too. A constant moved in EITHER direction goes
   * red behaviourally -- 480 makes the 48 row read "not expired", 24 makes the 47 row read
   * "expired".
   */
  it.each<[string, number, boolean]>([
    ["47 runs, one below the bound", 47, false],
    ["48 runs, exactly at the bound", 48, true],
    ["49 runs, past it", 49, true],
  ])("G-19d: with the cut engaged for %s, expired is %s", (_label, canaryRuns, expired) => {
    const plan = selectProbe(
      fresh({
        canaryRuns,
        alarm: { "source-empty:t4": { runs: canaryRuns + 4, cleanProbes: 0 } },
      }),
      Array.from({ length: 9 }, (_value, index) => `t${index}`),
    );

    expect(plan.expired).toBe(expired);
    // THE CONSEQUENCE, NOT JUST THE FLAG: the expiry run searches all nine targets, which is the
    // measurement the probe suppresses. 48 probes plus this one full run is the 49-run cycle.
    expect(plan.canary).toBe(!expired);
    expect(plan.indices).toHaveLength(expired ? 9 : CANARY_TARGETS);
  });

  it("G-19c: canaryRuns counts probe runs, and a cleared alarm resets it", () => {
    const engaged = advance({
      state: fresh({ canaryRuns: 7, alarm: { "source-empty:t1": { runs: 9, cleanProbes: 0 } } }),
      watchList: ["t1", "t2"],
      ran: [ran("t1", 3)],
      canary: true,
    });
    expect(engaged.state.canaryRuns).toBe(8);

    const released = advance({
      state: fresh({
        canaryRuns: 7,
        alarm: { "source-empty:t1": { runs: 9, cleanProbes: CANARY_CLEAN_PROBES - 1 } },
      }),
      watchList: ["t1", "t2"],
      ran: [ran("t1")],
      canary: true,
    });
    expect(released.causes).toEqual([]);
    expect(released.state.canaryRuns).toBe(0);
  });

  /* ---------- the prune, which is load-bearing ---------- */

  /**
   * G-21: CAUSES ARE PRUNED WHEN ANY TARGET THEY NAME LEAVES THE WATCH LIST.
   *
   * THE MUTATION IS PRUNING `consecutive` ONLY, under which the cause survives naming a deleted
   * target -- AND THE PROBE SET IS THEN EMPTY. That is a run that makes zero requests, stores
   * nothing and exits 0: the guard turns into the silent stop it was designed not to be.
   * `watch_targets` has no `enabled` column (verified: `no such column`), so DELETING a row is
   * the only way to pause a search and this case is ordinary rather than exotic.
   */
  it("G-21: a cause naming a deleted target is dropped, and half a feed pair takes the pair", () => {
    const result = advance({
      state: fresh({
        consecutive: { gone: { sourceEmpty: 3, transient: 0 }, kept: { sourceEmpty: 0, transient: 0 } },
        alarm: {
          "source-empty:gone": { runs: 9, cleanProbes: 0 },
          "feed-overlap:kept+gone": { runs: 9, cleanProbes: 0 },
          "source-empty:kept": { runs: 9, cleanProbes: 0 },
        },
      }),
      watchList: ["kept"],
      ran: [ran("kept", 3)],
    });

    expect(result.causes).toEqual(["source-empty:kept"]);
    expect(result.state.consecutive).toEqual({ kept: { sourceEmpty: 1, transient: 0 } });
  });

  /** G-15: `consecutive` is pruned too -- ten keys after a nine-target run is a leak. */
  it("G-15: consecutive is pruned to the watch list", () => {
    const result = advance({
      state: fresh({
        consecutive: Object.fromEntries(
          Array.from({ length: 10 }, (_value, index) => [
            `t${index}`,
            { sourceEmpty: 1, transient: 0 },
          ]),
        ),
      }),
      watchList: Array.from({ length: 9 }, (_value, index) => `t${index}`),
      ran: Array.from({ length: 9 }, (_value, index) => ran(`t${index}`)),
    });

    expect(Object.keys(result.state.consecutive)).toHaveLength(9);
    expect(result.state.consecutive.t9).toBeUndefined();
  });

  /* ---------- the probe set ---------- */

  /**
   * G-22: THE PROBE NEVER SPLITS A `feed-overlap` CAUSE AND NEVER EXCEEDS `CANARY_TARGETS`.
   *
   * THE MUTATION IS GREEDY-FILLING BY TARGET instead of by cause, which produces a probe of `{a}`
   * alone when a single-target cause sorts first -- and half a pair is UNMEASURABLE, so the feed
   * cause could never clear. The alarm would be permanent for a reason that has nothing to do
   * with Facebook.
   *
   * The sorted cause list here is `[feed-overlap:a+b, source-empty:z]`. Filling by target would
   * take a, then b, then stop at the cap having split nothing -- so the mutation has to be driven
   * from a cursor where the SINGLE-target cause comes first, which is `probe: 1`.
   */
  it("G-22: a single-target cause first leaves the pair uncredited, not half-probed", () => {
    const state = fresh({
      probe: 1,
      alarm: {
        "feed-overlap:a+b": { runs: 9, cleanProbes: 0 },
        "source-empty:z": { runs: 9, cleanProbes: 0 },
      },
    });

    /**
     * `probe: 1` starts at `source-empty:z`, which takes one slot; the pair needs two and does
     * not fit, so the CAUSE FILL skips it whole. The top-up then adds position 0 for volume
     * parity, so `a` does run -- and THE DISTINCTION THAT MATTERS is that running half a pair
     * is not the same as crediting it. The claim is no longer "the probe never contains half a
     * pair" (the top-up can put one there) but "half a pair never earns the pair anything",
     * which is the property that keeps the cause clearable only by a real measurement.
     */
    const plan = selectProbe(state, ["a", "b", "z"]);
    expect(plan.indices).toEqual([0, 2]);
    expect(plan.indices).toHaveLength(CANARY_TARGETS);
    expect(plan.canary).toBe(true);

    // THE PROPERTY: that run gives the feed cause no credit at all, however often it repeats.
    let credited = state;
    for (let index = 0; index < CANARY_CLEAN_PROBES + 2; index += 1) {
      const result = advance({
        state: credited,
        watchList: ["a", "b", "z"],
        ran: [ran("a", 0, { ids: ids("a", 24) }), ran("z", 0, { ids: ids("z", 24) })],
        canary: true,
      });
      credited = result.state;
      expect(result.causes).toContain("feed-overlap:a+b");
    }
    expect(credited.alarm["feed-overlap:a+b"].cleanProbes).toBe(0);

    // ...and the next run's cursor reaches the pair, which then fits exactly and IS measurable.
    const next = selectProbe({ ...state, probe: plan.nextProbe }, ["a", "b", "z"]);
    expect(next.indices).toEqual([0, 1]);
  });

  /**
   * G-22e: THE PROBE IS ALWAYS EXACTLY `CANARY_TARGETS` WHEN IT CLAIMS TO BE A PROBE.
   *
   * THIS IS THE PROPERTY THE PAGE'S SENTENCE RESTS ON, asserted here rather than assumed there.
   * `CollectionStatusPanel` renders "reduced to {CANARY_TARGETS} of {targets}" -- a literal
   * numerator against a number from the wire -- and that is only honest if the code really runs
   * `CANARY_TARGETS` whenever `canary` is true. Before the top-up it ran ONE for a single-target
   * cause and the page said two.
   *
   * It holds by construction: the top-up fills to `min(CANARY_TARGETS, length)`, and `canary`
   * requires that to be strictly less than `length`, which forces it to be `CANARY_TARGETS`.
   * Driven over watch lists from 1 to 9 and over one, two and three latched causes.
   */
  it("G-22e: whenever canary is true, the probe is exactly CANARY_TARGETS targets", () => {
    let probes = 0;
    for (let size = 1; size <= 9; size += 1) {
      const watchList = Array.from({ length: size }, (_value, index) => `t${index}`);
      const causeSets: RunState["alarm"][] = [
        { "source-empty:t0": { runs: 9, cleanProbes: 0 } },
        { "source-empty:t0": { runs: 9, cleanProbes: 0 }, "transient:t0": { runs: 9, cleanProbes: 0 } },
        { [`source-empty:t${size - 1}`]: { runs: 9, cleanProbes: 0 } },
        { [`feed-overlap:t0+t${size - 1}`]: { runs: 9, cleanProbes: 0 } },
      ];

      for (const alarm of causeSets) {
        for (let probe = 0; probe < 4; probe += 1) {
          const plan = selectProbe(fresh({ alarm, probe }), watchList);
          if (!plan.canary) continue;
          probes += 1;
          expect(plan.indices).toHaveLength(CANARY_TARGETS);
          expect(plan.indices.length).toBeLessThan(watchList.length);
          expect(new Set(plan.indices).size).toBe(plan.indices.length);
        }
      }
    }

    // Non-vacuity: the loop really produced probes rather than skipping every case.
    expect(probes).toBeGreaterThan(20);
  });

  it("G-22b: a feed cause alone fills the probe exactly, and the cap is 2", () => {
    const plan = selectProbe(
      fresh({ alarm: { "feed-overlap:a+b": { runs: 9, cleanProbes: 0 } } }),
      ["a", "b", "c", "d"],
    );

    expect(plan.indices).toEqual([0, 1]);
    expect(plan.indices).toHaveLength(CANARY_TARGETS);
    expect(CANARY_TARGETS).toBe(2);
  });

  it("G-22c: no alarm is a full run with canary false and the cursor at 0", () => {
    const plan = selectProbe(fresh(), ["a", "b", "c"]);

    expect(plan).toEqual({ indices: [0, 1, 2], canary: false, expired: false, nextProbe: 0 });
  });

  /**
   * G-22d: THE CURSOR ADVANCES BY ONE CAUSE PER RUN, so every cause is re-measured within as
   * many runs as there are causes. The nine-single-cause case is the wholesale failure: nine
   * causes, two measured per run, and this asserts that over nine runs every target is probed
   * at least once rather than the first few repeatedly.
   */
  it("G-22d: with nine single-target causes every target is probed within nine runs", () => {
    const watchList = Array.from({ length: 9 }, (_value, index) => `t${index}`);
    const alarm = Object.fromEntries(
      watchList.map((targetId) => [`source-empty:${targetId}`, { runs: 9, cleanProbes: 0 }]),
    );

    const probed = new Set<number>();
    let probe = 0;
    for (let index = 0; index < 9; index += 1) {
      const plan = selectProbe(fresh({ alarm, probe }), watchList);
      expect(plan.indices).toHaveLength(2);
      for (const position of plan.indices) probed.add(position);
      probe = plan.nextProbe;
    }

    expect([...probed].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // ...and the cursor came all the way round.
    expect(probe).toBe(0);
  });

  /* ---------- the file ---------- */

  /**
   * G-14: `parseRunState` IS FRESH FOR EVERY UNUSABLE SHAPE.
   *
   * THE MUTATION IS `JSON.parse(raw) as RunState`, which is wrong in two directions at once:
   * `Object.entries(undefined)` throws a TypeError out of the one process this repo insists must
   * not throw, and the `version`-less row LATCHES THE GUARD FROM GARBAGE -- `{"alarm":{...}}`
   * would pin the collector at 2 of 9 off a file anything could have written.
   */
  it.each<[string, string | null]>([
    ["absent", null],
    ["empty", ""],
    ["whitespace", "   \n"],
    ["the literal null", "null"],
    ["an empty object", "{}"],
    ["an array", "[]"],
    ["invalid JSON", "{not json"],
    ["version 0", '{"version":0,"consecutive":{},"alarm":{},"probe":0,"canaryRuns":0}'],
    ["a string consecutive", '{"version":1,"consecutive":"x","alarm":{},"probe":0,"canaryRuns":0}'],
    ["an array alarm", '{"version":1,"consecutive":{},"alarm":[],"probe":0,"canaryRuns":0}'],
    ["a fractional probe", '{"version":1,"consecutive":{},"alarm":{},"probe":0.5,"canaryRuns":0}'],
    ["a negative canaryRuns", '{"version":1,"consecutive":{},"alarm":{},"probe":0,"canaryRuns":-1}'],
    [
      "a counter that is a string",
      '{"version":1,"consecutive":{"t1":{"sourceEmpty":"3","transient":0}},"alarm":{},"probe":0,"canaryRuns":0}',
    ],
    [
      "a latch with no cleanProbes",
      '{"version":1,"consecutive":{},"alarm":{"source-empty:t1":{"runs":4}},"probe":0,"canaryRuns":0}',
    ],
    [
      "a cause with no target",
      '{"version":1,"consecutive":{},"alarm":{"source-empty:":{"runs":4,"cleanProbes":0}},"probe":0,"canaryRuns":0}',
    ],
    [
      "a cause with no colon",
      '{"version":1,"consecutive":{},"alarm":{"whatever":{"runs":4,"cleanProbes":0}},"probe":0,"canaryRuns":0}',
    ],
  ])("G-14: %s parses as a fresh state", (_label, raw) => {
    expect(parseRunState(raw)).toEqual({
      version: 1,
      consecutive: {},
      alarm: {},
      probe: 0,
      canaryRuns: 0,
    });
  });

  it("G-14b: a real state file round-trips, field for field", () => {
    const state: RunState = {
      version: 1,
      consecutive: { "gpu-rtx": { sourceEmpty: 2, transient: 0 } },
      alarm: { "feed-overlap:gpu-radeon+gpu-rtx": { runs: 6, cleanProbes: 1 } },
      probe: 3,
      canaryRuns: 11,
    };

    expect(parseRunState(serializeRunState(state))).toEqual(state);
  });

  /**
   * G-14c: A FRESH STATE IS A FULL RUN, NOT A PROBE. Defaulting to the probe would pin a
   * FIRST-EVER run -- the case where the file does not exist yet, which is every new install --
   * at 2 of 9 searches.
   */
  it("G-14c: a fresh state plans a full run", () => {
    const plan = selectProbe(parseRunState(null), ["a", "b", "c"]);

    expect(plan.canary).toBe(false);
    expect(plan.indices).toEqual([0, 1, 2]);
  });

  /**
   * G-26: A REFUSAL IS CREDITED BY AN EXIT 0 ANYWHERE IN THE RUN, BECAUSE A REFUSAL IS OF THE IP.
   *
   * The stuck case is literal: `t0` refused once and then quiet for good (exit 3). Before the
   * fix `refused:t0` waited for `t0` itself to exit 0, which never came, and a refusal never
   * expires: 199 of 200 runs cut. The mutation is dropping the IP-wide credit.
   */
  it("G-26: a target refused once and then quiet for good does not pin the cut", () => {
    const watchList = Array.from({ length: 9 }, (_value, index) => `t${index}`);
    const result = simulate(watchList, 200, (targetId, run) =>
      targetId !== "t0"
        ? ran(targetId)
        : run === 0
          ? ran("t0", 5, { reason: IMMEDIATE_REFUSAL_REASONS[0] })
          : ran("t0", 3),
    );

    expect(result.state.alarm["refused:t0"]).toBeUndefined();
    expect(result.cut).toBe(CANARY_CLEAN_PROBES);
  });

  /**
   * G-26b: THE CREDIT'S EDGES. Each row is the input one wrong version of the rule gets wrong:
   * no exit 0 anywhere (credit from nothing), another target refused in the same run (the IP is
   * still refused), and a cause that is not a refusal (the credit written for every cause).
   */
  it.each<[string, string, TargetRun[], number]>([
    ["an exit 0 elsewhere credits a refusal", "refused:a", [ran("a", 3), ran("b")], 1],
    ["no exit 0 anywhere does not", "refused:a", [ran("a", 3), ran("b", 3)], 0],
    [
      "a refusal elsewhere in the run does not",
      "refused:a",
      [ran("a", 3), ran("b"), ran("c", 5, { reason: IMMEDIATE_REFUSAL_REASONS[0] })],
      0,
    ],
    ["it does not credit a transient cause", "transient:a", [ran("a", 2), ran("b")], 0],
  ])("G-26b: %s", (_label, cause, runs, cleanProbes) => {
    const result = advance({
      state: fresh({ alarm: { [cause]: { runs: 3, cleanProbes: 0 } } }),
      watchList: ["a", "b", "c", "d"],
      ran: runs,
      canary: true,
    });

    expect(result.state.alarm[cause].cleanProbes).toBe(cleanProbes);
  });

  /**
   * G-27: ONE QUIET QUERY BESIDE HEALTHY ONES KEEPS ITS ALARM AND CUTS NOTHING; EVERY TARGET
   * EMPTY STILL CUTS. The second half is what the alarm exists for (a wholesale page-marker
   * change empties every target), so it is what stops the fix being "source-empty never cuts".
   * Before the fix the first case cut 193 of 200 runs. The mutation is dropping the `quiet`
   * filter in `selectProbe`.
   */
  it("G-27: one empty target beside eight healthy ones is alarmed but not cut", () => {
    const watchList = Array.from({ length: 9 }, (_value, index) => `t${index}`);
    const result = simulate(watchList, 200, (targetId) => ran(targetId, targetId === "t0" ? 3 : 0));

    expect(result.state.alarm["source-empty:t0"]).toMatchObject({ quiet: true, cleanProbes: 0 });
    expect(result.cut).toBe(0);
    expect(result.requests).toBe(200 * 9);
  });

  it("G-27b: every target empty is still cut", () => {
    const watchList = Array.from({ length: 9 }, (_value, index) => `t${index}`);
    const result = simulate(watchList, 200, (targetId) => ran(targetId, 3));

    expect(result.state.alarm["source-empty:t0"].quiet).toBeUndefined();
    // 3 full runs to latch, then 197 runs of 48 cut + 1 expiry: 197 = 4 x 49 + 1, so 193.
    expect(result.cut).toBe(193);
  });

  /**
   * G-27c: `quiet` IS RE-DECIDED, BOTH WAYS. A quiet cause whose next empty run has no healthy
   * neighbour stops being quiet, so a page-marker change that arrives after one query went
   * quiet still engages the cut.
   */
  it("G-27c: quiet is set by a healthy neighbour and cleared without one", () => {
    const watchList = ["a", "b", "c"];
    const quiet = advance({
      state: fresh({ consecutive: { a: { sourceEmpty: 2, transient: 0 } } }),
      watchList,
      ran: [ran("a", 3), ran("b"), ran("c")],
    });
    expect(quiet.state.alarm["source-empty:a"]).toEqual({ runs: 1, cleanProbes: 0, quiet: true });
    expect(selectProbe(quiet.state, watchList).canary).toBe(false);

    const loud = advance({ state: quiet.state, watchList, ran: [ran("a", 3), ran("b", 3), ran("c", 4)] });
    expect(loud.state.alarm["source-empty:a"]).toEqual({ runs: 2, cleanProbes: 0 });
    expect(selectProbe(loud.state, watchList).canary).toBe(true);
  });

  /** G-14d: `quiet` survives the file, and anything but `true` there makes the file fresh. */
  it("G-14d: a quiet latch round-trips, and a non-true quiet is refused", () => {
    const state: RunState = {
      version: 1,
      consecutive: {},
      alarm: { "source-empty:t1": { runs: 4, cleanProbes: 0, quiet: true } },
      probe: 0,
      canaryRuns: 0,
    };
    expect(parseRunState(serializeRunState(state))).toEqual(state);
    expect(
      parseRunState(
        '{"version":1,"consecutive":{},"alarm":{"source-empty:t1":{"runs":4,"cleanProbes":0,"quiet":false}},"probe":0,"canaryRuns":0}',
      ).alarm,
    ).toEqual({});
  });

  /** The shipped numbers, in the one place they are written down as values. */
  it("the shipped thresholds are 3, 0.80, 12, 2, 2 and 48", () => {
    expect(CONSECUTIVE_ALARM_RUNS).toBe(3);
    expect(OVERLAP_ALARM_FRACTION).toBe(0.8);
    expect(OVERLAP_MIN_DENOMINATOR).toBe(12);
    expect(CANARY_TARGETS).toBe(2);
    expect(CANARY_CLEAN_PROBES).toBe(2);
    expect(MAX_CANARY_RUNS).toBe(48);
  });
});
