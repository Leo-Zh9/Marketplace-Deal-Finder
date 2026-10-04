/**
 * CROSS-RUN STATE AND THE WITHIN-RUN FEED CHECK. PURE: no filesystem, no network, no clock.
 * `collector/main.ts` supplies the two I/O seams (`readState`, `writeState`) and
 * `collector/runTargets.ts` calls everything here; nothing in this file can do I/O, so every
 * line of it is reachable from a unit test.
 *
 * WHY THIS FILE EXISTS AT ALL. `collector/parseSearchPage.ts` names the gap verbatim -- "the
 * residual defence is an alarm on N consecutive empty runs, which needs cross-run state" -- and
 * `collector/run.ts` names the second: "A REPEATED EXIT 5 ACROSS RUNS IS A PERSISTENT
 * SERVER-SIDE FAILURE". Before this file, `grep -rniE "backoff|consecutive|circuit|cooldown"`
 * over `collector/` and `scripts/` returned exactly one hit: the admission above. There was no
 * cross-run state anywhere.
 *
 * AND WHY IT ALSO DOES THE *WITHIN*-RUN CHECK, which is the condition that was actually
 * MEASURED. Three live searches with DIFFERENT queries (`rtx 4060`, `rtx 3060`, `rtx 3070`)
 * returned the IDENTICAL three matched listings and the IDENTICAL bucket counts after ~17 live
 * requests in ~17 minutes. EVERY ONE OF THOSE RUNS WOULD HAVE EXITED 0: the page parsed, 24
 * listings were extracted, the POST succeeded. One run drives nine targets with nine DIFFERENT
 * queries, so substantial listing-id overlap BETWEEN DIFFERENT QUERIES in the same run is a
 * generic feed, and it needs no cross-run state at all.
 *
 * THE STATE LIVES IN A LOCAL FILE, NOT IN D1, AND THE REASON IS SHARP. Exit 5's documented
 * meaning explicitly INCLUDES "the POST failed with 5xx or a network error", so a counter kept
 * in D1 could not increment during the outage it exists to detect. The file is read BEFORE any
 * network call, so a hung GET cannot strand the decision either.
 *
 * NOTHING HERE CHANGES AN EXIT CODE. The exit codes are "the operator's only signal" and launchd
 * reads `LastExitStatus`; an alarm ADDS a signal (the run line's `alarms`, the health row, the
 * page) and never redefines 0/2/3/4/5/6. There is no seventh code.
 */

import { EXIT_CONTRACT, EXIT_OK, EXIT_SOURCE_EMPTY, EXIT_TRANSIENT } from "./run.ts";

/**
 * N = 3 CONSECUTIVE RUNS AT ONE TARGET, for condition 1 (exit 3) and condition 2 (exit 5) alike.
 *
 * AGAINST THE REAL HISTORY: ZERO FIRINGS. 460 target-runs mined from
 * `~/Library/Logs/marketplace-collector.log` over 24.7 h: 456x0, 1x3, 1x5, 1x6, and the LONGEST
 * RUN OF ANY NON-ZERO EXIT AT ANY SINGLE TARGET IS 1, for all three codes -- `mobo-toronto` at
 * 03:05:19Z, `psu-toronto` at 20:36:21Z, `gpu-radeon` at 21:02:08Z. Three is two runs of margin
 * beyond the longest anomaly ever observed.
 *
 * At a base rate p = 1/450 per code per target-run and 432 opportunities/day: N=2 gives 2.1e-3
 * false alarms/day (a 1.3-year MTBF, for a guard that cuts 78 % of volume), N=3 gives 4.7e-6
 * (578 years), N=4 gives 1.1e-8. N COSTS ONLY DETECTION LATENCY -- 3 runs is 90 minutes, 4 is
 * 120 -- against a failure whose signature is "SOURCE_EMPTY forever", so 4 buys nothing worth
 * 30 minutes. REJECTED: N=2, because that MTBF rests on an independence assumption already
 * known to be wrong (one bad page affects every target in the run).
 *
 * ENABLING CONDITION, because the figure is not unconditional: one 24.7 h window, one market,
 * one set of nine queries, 100 % schedule coverage. DIRECTION OF ERROR IS BENIGN -- a Mac that
 * sleeps produces FEWER runs, not more non-zero codes, so the base rate is not inflated by the
 * coverage. The sample size is the real limit.
 *
 * BOTH CONDITIONS SHARE N on purpose: their measured histories are identical (one isolated
 * occurrence each) and `run.ts` treats a repeat of either identically.
 */
export const CONSECUTIVE_ALARM_RUNS = 3;

/**
 * THE TWO `reason` VALUES THAT LATCH ON THE FIRST OCCURRENCE, INSIDE CONDITION 2's COUNTER.
 *
 * Both mean Facebook has refused THIS IP and neither has a benign reading. At N=3 the collector
 * makes 27 FURTHER REQUESTS OVER 90 MINUTES INTO AN ACTIVE REFUSAL -- which is how a soft
 * throttle becomes the hard block that `collector/types.ts` records as unrecoverable (measured:
 * identical code, two egress points, one minute apart -- 10 listings from a residential IP, 0
 * listings and a login wall at HTTP 200 from Cloudflare). Losing the residential IP is not
 * recoverable by backing off afterwards, so this is the one place the margin goes on the other
 * side.
 *
 * AGAINST THE REAL HISTORY: ZERO FIRINGS. 460 target-runs, zero 429s, zero blocked redirects.
 * The single exit 5 in the log is a POST failure (`state:"SUCCESS", reason:"ok",
 * httpStatus:null`), which `reason` separates cleanly from both of these.
 *
 * `refused:*` IS ALSO THE ONE CAUSE EXEMPT FROM THE VOLUME-CUT EXPIRY. See MAX_CANARY_RUNS.
 */
export const IMMEDIATE_REFUSAL_REASONS: readonly string[] = ["rate-limited", "blocked-redirect"];

/**
 * 0.80 -- THE OVERLAP COEFFICIENT AT WHICH TWO DIFFERENT QUERIES ARE CALLED ONE FEED.
 *
 * LEG 1, THE LEGITIMATE CEILING. Ten pairs measured live this session at n=24: 0.000, 0.208,
 * 0.208, 0.250, 0.292, 0.292, 0.458, 0.500, 0.583, 0.625. The degradation event: 1.000, three
 * times. THERE IS NO MEASUREMENT ANYWHERE IN (0.625, 1.000), so the only non-arbitrary choice
 * is the midpoint of the measured gap: (0.625 + 1.000)/2 = 0.8125, which at the pinned
 * denominator rounds to the nearest achievable count -- 0.8125 x 24 = 19.5 -> 20/24 = 0.8333 --
 * i.e. a constant of 0.80.
 *
 * LEG 2, THE NINE PRODUCTION PAIRS, MEASURED READ-ONLY. `worker/storage/recordSightings.ts`'s
 * classification SELECT is `WHERE l.source = ?1 AND l.listing_id IN (...)` with NO market_key
 * and NO component_type, and a row absent from `listings` is reported NEW -- so
 * `received(T) - NEW(T)` is exactly `|ids(T) n store|`, and for any EARLIER target E in the same
 * run `shared(E,T) <= received(T) - NEW(T)`. Every pair has a later member, so each target's
 * tightest bound covers every pair behind it: 1+2+...+8 = all 36. Using a target's bound only in
 * runs where every earlier target had exitCode 0, httpStatus 200, FAILED 0 and
 * stored === received === posted, ALL 36 PAIRS ARE BOUNDED AT OR BELOW 0.750, and `ryzen`/`cpu`
 * -- the pair with the most obvious synonymy risk -- at 1 shared listing in 24 (0.042).
 *
 * HONESTY LABEL, AND IT IS NARROWER THAN THE RESULT SOUNDS. Leg 2 is an UPPER bound and it is
 * uninformative when the table is warm (NEW = 0 gives a bound of 1.00, on 19-34 of ~52 runs per
 * target). Proving runs per pair range 1-18, and the two loosest bounds rest on a SINGLE run
 * each -- but both of those are CROSS-type. All four SAME-type pairs, which is where legitimate
 * overlap actually lives, rest on 3, 6, 6 and 13 independent runs. The claim is "every
 * production pair has been measured below the trip point", not "always below".
 *
 * MARGINS AT THE OBSERVED DENOMINATORS: n=24 trips at >=20 shared (0.833) and is silent at 19
 * (0.792); n=25 trips at >=20 (0.800) and is silent at 19 (0.760). A legitimate pair must gain
 * 5 shared listings (+33 %) over the measured ceiling to trip; a feed must differ by 5 of 24
 * (21 %) between two queries to escape.
 *
 * ONE RUN LATCHES, NOT TWO. The dominant false-positive mode is a STRUCTURALLY synonymous pair,
 * which recurs every run -- a second run filters nothing and costs 9 further requests into a
 * possible throttle.
 */
export const OVERLAP_ALARM_FRACTION = 0.8;

/**
 * 12 -- THE DENOMINATOR BELOW WHICH THE OVERLAP RULE REFUSES TO EVALUATE AT ALL.
 *
 * THE DEFECT THIS CLOSES IS A COUNT GENERALISED AS A FRACTION. OVERLAP_ALARM_FRACTION was
 * derived from a COUNT (20) at n~24; applied as a fraction it reaches denominators the baseline
 * never measured, and at min = 5 it trips at 4 shared -- and 4 of 5 on a thin day is market
 * behaviour, not a feed. That is the expensive direction of error.
 *
 * DERIVATION. Scale the measured ceiling: legitimate overlap <= 0.625n, the trip point is
 * ceil(0.80n), so the margin is 0.175n listings. The rule is meaningful only while the trip
 * point sits at least TWO listings above the scaled ceiling: 0.175n >= 2 -> n >= 12
 * (0.175 x 12 = 2.1; at n=12 the rule needs 10 of 12). At n=6 the margin is 1.05 -- one listing
 * -- which is not enough to tell a feed from a quiet market.
 *
 * AGAINST THE REAL HISTORY: IT WOULD HAVE EXCLUDED NOTHING AND CHANGED NOTHING. The `parsed`
 * values observed over 460 target-runs are ONLY 0, 24 and 25. NO DENOMINATOR BETWEEN 1 AND 23
 * HAS EVER BEEN OBSERVED, so every value below 24 is extrapolation -- which is exactly why the
 * rule must REFUSE to evaluate there rather than guess. G-17 (unit) and E-4 (process) are the
 * guards; E-4 also asserts the `overlap` line itself, so the process layer witnesses that the
 * computation RAN and that THE FLOOR, not an absent feature, declined to alarm.
 */
export const OVERLAP_MIN_DENOMINATOR = 12;

/**
 * 2 TARGETS PER PROBE RUN -- a 78 % volume reduction (2 x 48 = 96/day against 432).
 *
 * 2, NOT 1, AND THE REASON IS THE DETECTOR ITSELF: one target makes condition 3 unmeasurable,
 * so a `feed-overlap` cause could latch and then never be able to prove it should clear. 2 is
 * the minimum that keeps the detector alive while the guard is engaged.
 *
 * INVARIANT 5 (request volume to Facebook must never increase) HOLDS BY CONSTRUCTION, not by
 * arithmetic: the probe set is a strict SUBSET of the watch list, so the run makes strictly
 * fewer requests. L-18 asserts it as a property over every case rather than as a comment.
 */
export const CANARY_TARGETS = 2;

/**
 * 2 CONSECUTIVE CLEAN RE-MEASUREMENTS OF A CAUSE clear that cause.
 *
 * 2x the longest anomaly ever observed (1 run). REJECTED: 1, because a single clean probe could
 * be the same coin-flip that produced a 1-run anomaly. REJECTED: 3, because that is 90 minutes
 * of needless reduction for a third identical answer.
 *
 * THE ASYMMETRY WITH CONSECUTIVE_ALARM_RUNS = 3 IS DERIVED, NOT ARBITRARY. Latching is
 * expensive -- it cuts 78 % of collection -- and clearing is cheap: it restores collection, and
 * if the fault persists the next full run re-latches within 3 runs for conditions 1 and 2, or
 * within ONE run for condition 3. The margin belongs on the expensive side.
 */
export const CANARY_CLEAN_PROBES = 2;

/**
 * 48 -- THE BOUND ON THE VOLUME CUT, AFTER WHICH ONE FULL RUN HAPPENS ANYWAY.
 *
 * THE DERIVATION IS NOT "an escape hatch after a day". The probe re-asks the SAME question every
 * run, so a 49th identical answer is not new information -- A FULL RUN IS, because it
 * re-measures all nine targets and all 36 pairs, and that is precisely the data
 * OVERLAP_ALARM_FRACTION's Leg 2 is derived from. So the expiry is THE SCHEDULED RE-ARRIVAL OF
 * THE MEASUREMENT THE PROBE SUPPRESSES, and it costs 9 requests per 49 runs.
 *
 * It also answers the circularity charge against Leg 2 directly: the 36-pair matrix keeps
 * arriving (~252 pair-observations/week) instead of stopping the moment the guard fires.
 *
 * THE ALARM AND THE VOLUME CUT ARE SEPARATE STATE MACHINES, AND THAT SEPARATION IS WHAT MAKES
 * THIS NOT A SECOND RECOVERY MECHANISM RACING THE FIRST. `alarm` is cleared ONLY by
 * CANARY_CLEAN_PROBES clean re-measurements of the cause itself; the expiry flips ONLY `canary`
 * and leaves the alarm raised on the page. And the full run the expiry produces is the BEST
 * POSSIBLE probe, so a clean measurement counts whether it came from a probe or from a full run.
 *
 * ONE EXEMPTION: A `refused:*` CAUSE NEVER EXPIRES. That is invariant 5's case -- Facebook has
 * refused this IP -- where staying low is the entire point, and 9 requests into an active
 * refusal is the thing IMMEDIATE_REFUSAL_REASONS exists to stop. The consequence is named
 * rather than hidden: `refused:*` is a terminal state with no automatic escape, the page says so
 * continuously, and `rm ~/.marketplace-collector-state.json` is the override.
 *
 * NOT MEASURED. Stated as a policy constant derived from the measurement it protects, not from
 * the log.
 *
 * VOLUME, ALL FOUR REGIMES: clear 432/day; latched with the probe engaged <=96 (-78 %); latched
 * with the expiry cycling (48 probes + 1 full per 49 runs) ~105/24.5 h (-76 %); `refused:*`
 * latched <=96 indefinitely (-78 %).
 */
export const MAX_CANARY_RUNS = 48;

/**
 * THE CROSS-RUN STATE, AND EVERY FIELD IS HERE BECAUSE SOMETHING WOULD BREAK WITHOUT IT.
 */
export interface RunState {
  version: 1;
  /**
   * PER TARGET, NEVER PER RUN, AND THAT IS NOT A STYLE CHOICE. `worstExitCode` folds a run to
   * ONE code, so a run-level counter lets `mobo-toronto` be empty for a hundred runs while
   * another target's occasional 5 resets it. The real log shows THREE different non-zero codes
   * at THREE different targets in 52 runs -- exactly that interleaving. G-3 and G-4 are the
   * guards, and G-4 drives `advanceState` from `worstExitCode` to prove it.
   *
   * PRUNED to the current watch list on every run that ran targets.
   */
  consecutive: Record<string, { sourceEmpty: number; transient: number }>;
  /**
   * KEYED BY CAUSE STRING; `{}` when clear.
   *
   * PRUNED IN THE SAME PASS AS `consecutive`, and the prune is LOAD-BEARING rather than tidy: a
   * cause is dropped when ANY target it names is absent from the watch list, because it can no
   * longer be re-measured -- and a latched cause whose targets are gone yields an EMPTY PROBE
   * SET, which is a run that makes zero requests, stores nothing and exits 0. `watch_targets`
   * has no `enabled` column (verified: `no such column`), so the only way to pause one search is
   * to DELETE its row, which is why this case is ordinary rather than exotic. G-21 and E-5.
   *
   * `runs` counts runs that ran targets since the cause latched, so the page's N grows.
   * `cleanProbes` counts CONSECUTIVE clean re-measurements OF THIS CAUSE.
   */
  alarm: Record<string, { runs: number; cleanProbes: number }>;
  /**
   * A rotating start index over the SORTED CAUSE LIST. NOT over the watch list: the probe is not
   * sampling, it is a specific question ("is `mobo-toronto` still empty?", "do `radeon` and
   * `rtx` still return the same page?").
   */
  probe: number;
  /** Consecutive runs the volume cut has been engaged. 0 when it is not. */
  canaryRuns: number;
}

/** The ids one target parsed, with the exit code and reason the run reported for it. */
export interface TargetRun {
  targetId: string;
  exitCode: number;
  /** `run()`'s reported `reason`, or null when the target produced no summary at all. */
  reason: string | null;
  /** `run()`'s `listingIds`: every id the page yielded, or empty on a non-SUCCESS path. */
  ids: readonly string[];
  /**
   * THE SEARCH TEXT, AND IT IS HERE FOR EXACTLY ONE REASON: two watch rows can carry the SAME
   * query under DIFFERENT component types, and `buildSearchUrl` does not read the component type
   * -- so those two targets make the IDENTICAL request and must overlap 1.000 by construction.
   * Without this field the pair trips every single run and can never clear, which is a permanent
   * volume cut with the page blaming a generic feed for what is a duplicate configuration. It is
   * `""` for a row that failed validation, and two empty strings are never treated as equal.
   */
  query: string;
}

/**
 * The worst measurable pair in one run. `of` is `min(|A|,|B|)`, which is the coefficient's
 * denominator -- NOT the union, and that is a ruling: Jaccard reports 0.71 for the observation
 * the coefficient reports as 0.833, so the whole measured baseline (expressed as `n/24`) would
 * need re-deriving against it.
 */
export interface PairOverlap {
  a: string;
  b: string;
  shared: number;
  of: number;
}

const freshState = (): RunState => ({
  version: 1,
  consecutive: {},
  alarm: {},
  probe: 0,
  canaryRuns: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const counter = (value: unknown): { sourceEmpty: number; transient: number } | null => {
  if (!isRecord(value)) return null;
  const sourceEmpty = value.sourceEmpty;
  const transient = value.transient;
  if (!Number.isInteger(sourceEmpty) || !Number.isInteger(transient)) return null;
  if ((sourceEmpty as number) < 0 || (transient as number) < 0) return null;
  return { sourceEmpty: sourceEmpty as number, transient: transient as number };
};

const latch = (value: unknown): { runs: number; cleanProbes: number } | null => {
  if (!isRecord(value)) return null;
  const runs = value.runs;
  const cleanProbes = value.cleanProbes;
  if (!Number.isInteger(runs) || !Number.isInteger(cleanProbes)) return null;
  if ((runs as number) < 0 || (cleanProbes as number) < 0) return null;
  return { runs: runs as number, cleanProbes: cleanProbes as number };
};

/**
 * THE FOUR CAUSE KINDS, AND THE TARGETS EACH ONE NAMES.
 *
 *   source-empty:<t>        transient:<t>        refused:<t>        feed-overlap:<a>+<b>
 *
 * HONEST LIMIT ON THE ENCODING, stated because it is cheap to overstate. `watch_targets.target_id`
 * is TEXT whose only CHECK is `length > 0`, so a target id containing `:` or `+` would be parsed
 * back wrongly here. THE FAILURE DIRECTION IS THE SAFE ONE AND THAT IS WHY NO ESCAPING IS ADDED:
 * the names this returns are intersected with the current watch list before anything is done with
 * them, so a mis-split cause names targets that are not in the list and the prune DROPS it. The
 * guard degrades to "never latches for that target", never to "probes the wrong target". Every
 * production id is `[a-z0-9-]+`.
 */
const causeTargets = (cause: string): string[] => {
  const colon = cause.indexOf(":");
  if (colon === -1) return [];
  const kind = cause.slice(0, colon);
  const rest = cause.slice(colon + 1);
  if (rest === "") return [];
  return kind === "feed-overlap" ? rest.split("+") : [rest];
};

/**
 * AN UNREADABLE, ABSENT, EMPTY OR GARBAGE STATE FILE IS A FRESH STATE, AND THE RUN THEN PROCEEDS
 * AT FULL VOLUME.
 *
 * `JSON.parse(raw) as RunState` is the obvious implementation and it is wrong in two directions
 * at once: `Object.entries(undefined)` throws a TypeError out of the one process that must not
 * throw, and a file that happens to parse as `{"alarm":{"source-empty:x":{...}}}` with no
 * `version` would let garbage LATCH the guard. Every shape below is checked.
 *
 * FRESH MEANS FULL VOLUME, NOT A PROBE, and that ruling is the reason this returns a whole state
 * rather than a partial: defaulting to the probe would pin a first-ever run -- the normal case,
 * where the file does not exist yet -- at 2 of 9 searches. L-22 is the guard at the process
 * layer and G-14 at the unit layer.
 */
export const parseRunState = (raw: string | null): RunState => {
  if (raw === null || raw.trim() === "") return freshState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshState();
  }

  if (!isRecord(parsed)) return freshState();
  if (parsed.version !== 1) return freshState();
  if (!isRecord(parsed.consecutive) || !isRecord(parsed.alarm)) return freshState();
  if (!Number.isInteger(parsed.probe) || (parsed.probe as number) < 0) return freshState();
  if (!Number.isInteger(parsed.canaryRuns) || (parsed.canaryRuns as number) < 0) {
    return freshState();
  }

  // A SINGLE BAD ENTRY MAKES THE WHOLE STATE FRESH rather than being dropped on its own. Half a
  // state is the worst of both: it keeps a latch whose counter it threw away, so the cause can
  // never be re-measured out of existence. Fresh is recoverable in CONSECUTIVE_ALARM_RUNS runs.
  const consecutive: RunState["consecutive"] = {};
  for (const [targetId, value] of Object.entries(parsed.consecutive)) {
    const parsedCounter = counter(value);
    if (parsedCounter === null) return freshState();
    consecutive[targetId] = parsedCounter;
  }

  const alarm: RunState["alarm"] = {};
  for (const [cause, value] of Object.entries(parsed.alarm)) {
    const parsedLatch = latch(value);
    if (parsedLatch === null) return freshState();
    // A cause nothing can parse into targets could never be probed and never cleared, so it
    // would pin the collector at 2 of 9 forever. Refuse the file instead.
    if (causeTargets(cause).length === 0) return freshState();
    alarm[cause] = parsedLatch;
  }

  return {
    version: 1,
    consecutive,
    alarm,
    probe: parsed.probe as number,
    canaryRuns: parsed.canaryRuns as number,
  };
};

/** The file's bytes. Two spaces, so an operator who opens it can read it. */
export const serializeRunState = (state: RunState): string => JSON.stringify(state, null, 2);

/**
 * THE WORST MEASURABLE PAIR IN ONE RUN, BY OVERLAP COEFFICIENT -- and it is computed over every
 * pair with two non-empty id sets, WITHOUT applying OVERLAP_MIN_DENOMINATOR.
 *
 * THE FLOOR IS DELIBERATELY NOT APPLIED HERE, and the reason is that this value is LOGGED on
 * every run line. Filtering thin denominators out of the measurement would hide exactly the days
 * the floor exists to be honest about, and `OVERLAP_ALARM_FRACTION`'s Leg 2 has to stay
 * re-derivable from production. The floor belongs to the TRIP decision in `advanceState`, where
 * G-17 kills it; E-4 asserts the logged value at 6/6 on a 6-listing fixture, which is the
 * process layer's only positive witness that the computation ran at all.
 *
 * EMPTY ID SETS ARE EXCLUDED, and that is a ruling with two named failure modes: `0/0` is `NaN`,
 * which never trips and never says why, or -- if an implementation reaches for a guard -- `1`,
 * which trips always. Two SOURCE_EMPTY targets are not a feed. G-10.
 *
 * TIES GO TO WATCH-LIST ORDER, which is `ORDER BY target_id` from
 * `worker/api/watchTargets.ts:57`, documented there as what makes the run order deterministic.
 * A global feed makes all 36 pairs 1.000, so without a tie rule the reported pair would be
 * whatever the comparison happened to do.
 */
export const maxPairOverlap = (ran: readonly TargetRun[]): PairOverlap | null => {
  let best: PairOverlap | null = null;

  for (let i = 0; i < ran.length; i += 1) {
    for (let j = i + 1; j < ran.length; j += 1) {
      const a = ran[i];
      const b = ran[j];
      // TWO ROWS WITH THE SAME QUERY ARE NOT A PAIR, THEY ARE ONE SEARCH RUN TWICE.
      // `collector/searchUrl.ts`'s `buildSearchUrl` reads the query, the location, the limit, the
      // radius and the day window -- NOT the component type -- so `('gpu','rtx')` and
      // `('cpu','rtx')` fetch the same URL and their id sets are identical by construction. The
      // overlap would be 1.000 on every run, so the cause would latch immediately and could
      // never be re-measured clean: a permanent 78 % cut explained to the operator as a generic
      // feed. The real fault is two watch rows that should be one, and nothing here can say so.
      // `""` is excluded because an unvalidated row has no query to compare and two broken rows
      // are not the same search.
      if (a.query !== "" && a.query === b.query) continue;
      const left = new Set(a.ids);
      const right = new Set(b.ids);
      if (left.size === 0 || right.size === 0) continue;

      let shared = 0;
      for (const id of left) if (right.has(id)) shared += 1;
      const of = Math.min(left.size, right.size);

      // STRICTLY GREATER, so the FIRST pair in watch-list order wins a tie.
      if (best === null || shared / of > best.shared / best.of) {
        best = { a: a.targetId, b: b.targetId, shared, of };
      }
    }
  }

  return best;
};

/** Whether a measured pair is a feed: both the floor and the fraction, in one place. */
const trips = (overlap: PairOverlap | null): overlap is PairOverlap =>
  overlap !== null &&
  overlap.of >= OVERLAP_MIN_DENOMINATOR &&
  overlap.shared / overlap.of >= OVERLAP_ALARM_FRACTION;

export interface ProbePlan {
  /** Positions in the watch list to run, ascending. Every position when `canary` is false. */
  indices: number[];
  /**
   * TRUE ONLY ON A STRICT REDUCTION. An empty probe set, or one equal to the whole watch list,
   * is a FULL run reported as `canary:false` -- which is what makes "the panel claims a
   * reduction that did not happen" and "the probe collects nothing" both UNREPRESENTABLE rather
   * than merely unlikely. L-26 and E-5.
   */
  canary: boolean;
  /** The volume cut hit MAX_CANARY_RUNS, so this run is full BECAUSE OF THAT. */
  expired: boolean;
  /** The cursor to persist. */
  nextProbe: number;
}

/**
 * THE GUARD'S SHAPE: A CAUSE-DIRECTED PROBE WITH A BOUNDED VOLUME CUT. NEVER A FULL STOP.
 *
 * WHY NOT A FULL STOP, which is what "fail closed" usually means. Stopping collection is
 * INDISTINGUISHABLE FROM A BROKEN CRON and would be discovered days later -- which is exactly
 * how this project already shipped "evaluation is running" while 498 cron runs did nothing. A
 * 2-target probe keeps a heartbeat that can detect RECOVERY, which a stop cannot.
 * REJECTED: alarm without backoff, because condition 3's likeliest cause is throttling and
 * invariant 5 makes that loss unrecoverable.
 *
 * WHY CAUSE-DIRECTED RATHER THAN A ROTATION OVER THE WATCH LIST. A rotation oscillates: suppose
 * `mobo-toronto` latches, the rotation probes two cpu targets, the clean count reaches its
 * threshold, the alarm clears -- AND `mobo-toronto` NEVER RAN. The guard then delivers neither
 * the volume cut nor a stable alarm, and starves the very data its own threshold is derived
 * from. A probe is not sampling and is not trying to cover; it asks the latched cause's own
 * question.
 *
 * THE CURSOR ADVANCES BY ONE CAUSE PER RUN, MEASURED CONSEQUENCE STATED: with k single-target
 * causes and CANARY_TARGETS = 2, each run measures causes `start` and `start+1`, so every cause
 * is re-measured at least once within k runs (4.5 h at k=9) and the one at `start+1` is measured
 * twice. A cursor step of 2 would halve that, and is NOT used: a step of 1 means two consecutive
 * runs share a cause, so CANARY_CLEAN_PROBES can be satisfied by consecutive runs rather than
 * needing the cursor to come all the way round.
 *
 * NEVER SPLITS A CAUSE. A `feed-overlap:a+b` probe that ran only `a` could never measure the
 * pair, so the cause could never clear -- the alarm would be permanent for a reason that has
 * nothing to do with Facebook. The fill is BY CAUSE, and a cause that does not fit is skipped
 * whole. G-22.
 */
export const selectProbe = (state: RunState, watchList: readonly string[]): ProbePlan => {
  const every = watchList.map((_id, index) => index);
  const causes = Object.keys(state.alarm).sort();

  if (causes.length === 0) {
    return { indices: every, canary: false, expired: false, nextProbe: 0 };
  }

  // THE EXEMPTION IS CHECKED BEFORE THE BOUND, NOT AFTER. `refused:*` means Facebook has refused
  // this IP; a full run there is 9 requests into an active refusal, which is the one thing
  // invariant 5 says is not recoverable by backing off afterwards. G-20.
  const refusalLatched = causes.some((cause) => cause.startsWith("refused:"));
  if (!refusalLatched && state.canaryRuns >= MAX_CANARY_RUNS) {
    return { indices: every, canary: false, expired: true, nextProbe: state.probe % causes.length };
  }

  const start = state.probe % causes.length;
  const picked = new Set<number>();

  for (let step = 0; step < causes.length; step += 1) {
    const cause = causes[(start + step) % causes.length];
    const positions = causeTargets(cause).map((targetId) => watchList.indexOf(targetId));
    // A cause naming a target the watch list no longer holds is unprobeable. `advanceState`
    // prunes it, so this is the belt to that braces -- and it must SKIP, never pick -1.
    if (positions.some((position) => position < 0)) continue;

    const candidate = new Set([...picked, ...positions]);
    if (candidate.size <= CANARY_TARGETS) {
      for (const position of candidate) picked.add(position);
    }
  }

  /**
   * THE TOP-UP, AND IT IS WHAT MAKES `CANARY_TARGETS = 2` MEAN WHAT IT SAYS.
   *
   * THE DEFECT WITHOUT IT: filling by cause and stopping at the cap means ONE single-target cause
   * yields a ONE-target probe. That is the commonest alarm there is -- a single
   * `source-empty:<t>` -- and a one-target run makes condition 3 UNMEASURABLE, which is the
   * exact defect `CANARY_TARGETS = 2` was chosen to prevent: "one target makes condition 3
   * unmeasurable, so a feed alarm could latch and never prove it should clear". The guard would
   * have been disarming its own strongest detector precisely while engaged. It also made the
   * page's "2 of N" sentence false, since the code delivered 1.
   *
   * THE FILL IS FROM WATCH-LIST ORDER, which is `ORDER BY target_id` and therefore deterministic.
   * The topped-up targets are VOLUME PARITY, NOT EVIDENCE: `advanceState` credits a cause only
   * when that cause's own targets ran and produced positive evidence, so a filler that happens to
   * be half of some other latched pair earns that pair nothing (G-12 is the pin).
   *
   * `min(CANARY_TARGETS, watchList.length)` NEVER EXCEEDS THE LIST, so volume still only ever
   * REDUCES: `canary` below stays a STRICT-subset test, and a 2-target watch list with one cause
   * latched tops up to 2, fails that test, and runs FULL -- no claimed reduction that did not
   * happen. It also makes the panel's numerator exact rather than approximate: whenever `canary`
   * is true, `indices.length === CANARY_TARGETS`, which G-22e asserts as a property.
   */
  const probeSize = Math.min(CANARY_TARGETS, watchList.length);
  if (picked.size > 0) {
    for (let position = 0; position < watchList.length && picked.size < probeSize; position += 1) {
      picked.add(position);
    }
  }

  const canary = picked.size > 0 && picked.size < watchList.length;

  return {
    indices: canary ? [...picked].sort((left, right) => left - right) : every,
    canary,
    expired: false,
    nextProbe: (start + 1) % causes.length,
  };
};

export interface AdvanceInput {
  state: RunState;
  /** The watch list the server returned this run, in order. Both maps are pruned to it. */
  watchList: readonly string[];
  /** The targets that actually RAN, in order. */
  ran: readonly TargetRun[];
  /** `ProbePlan.canary` -- decided from the PERSISTED LATCH, never from how many ran. */
  canary: boolean;
  /** `ProbePlan.expired`. */
  expired: boolean;
  /** `ProbePlan.nextProbe`. */
  nextProbe: number;
}

export interface AdvanceResult {
  state: RunState;
  /** The latched causes, sorted. The caller adds the non-latching reports. */
  causes: string[];
  /** The worst measurable pair, logged on every run so the threshold stays re-derivable. */
  overlap: PairOverlap | null;
}

/**
 * ONE RUN'S EVIDENCE, FOLDED INTO THE NEXT RUN'S STATE.
 *
 * A CAUSE CLEARS ONLY WHEN ITS OWN CAUSE IS RE-MEASURED CLEAN:
 *
 *   cause                | measured iff                               | clean iff
 *   ---------------------|--------------------------------------------|---------------------------
 *   source-empty:t       | t ran AND t's exit is 0 or 6               | t's exit is not 3
 *   transient:t          | t ran AND t's exit is 0 or 6               | t's exit is not 5
 *   refused:t            | t ran AND t's exit is 0 or 6               | not (exit 5 with a refusal)
 *   feed-overlap:a+b     | both ran, both non-empty, min >= the floor | coefficient < the fraction
 *
 * "MEASURED" IS POSITIVE EVIDENCE, NOT THE ABSENCE OF THE CAUSE'S OWN CODE. Exit 0 and exit 6
 * are the only per-target codes that prove the page was fetched and parsed; 2, 3, 4 and 5
 * measured nothing about the condition in question. The cause's own code is DIRTY (it resets the
 * clean count); everything else is simply NOT MEASURED. See the long note at the predicate for
 * the two failures a pure negation produced.
 *
 * MEASURED AND CLEAN -> cleanProbes += 1, and at CANARY_CLEAN_PROBES the cause is DROPPED.
 * MEASURED AND DIRTY -> cleanProbes := 0.
 * NOT MEASURED       -> UNCHANGED. No evidence, no credit: a 1-target probe must not clear a
 *                       feed cause it structurally could not measure (G-12).
 *
 * CLEARING A CAUSE ALSO RESETS THAT TARGET'S `consecutive` COUNTERS, AND THAT IS A RULING THE
 * OSCILLATION FORCES. Without it a cleared cause re-latches on the very next dirty full run --
 * a period-3 cycle (9 -> 2 -> 2 -> 9 -> ...) that delivers neither the cut nor a stable alarm.
 * With it, re-latching costs CONSECUTIVE_ALARM_RUNS full runs of fresh evidence. G-16.
 *
 * EXACTLY ONE `feed-overlap` CAUSE IS EVER RECORDED -- the worst pair, ties by watch-list order.
 * A GLOBAL feed trips all 36 pairs, and recording all of them would make the cause set the whole
 * watch list and the clear condition 36 independent probes (~72 runs). One cause is one probe,
 * and if the feed persists the probe re-arms it next run. HONEST LIMIT: if the worst pair
 * recovers while another still feeds, the alarm clears and the next full run re-latches on the
 * new worst pair -- one run of full volume lost to a correct detection. G-18.
 *
 * THIS FUNCTION IS NEVER CALLED ON A WHOLE-RUN FAILURE, and `runTargets.ts` writes no state at
 * all on those paths. No targets ran, so there is no evidence: `consecutive` must not reset (a
 * config error would launder a real streak), `cleanProbes` must not advance, and `canaryRuns`
 * must not advance because no requests were made. NOT WRITING makes all three structural rather
 * than careful. L-25.
 */
export const advanceState = (input: AdvanceInput): AdvanceResult => {
  const { state, watchList, ran } = input;
  const inWatchList = new Set(watchList);

  // THE PRUNE, BOTH MAPS, IN ONE PASS. See `RunState.alarm` for why it is load-bearing.
  const consecutive: RunState["consecutive"] = {};
  for (const [targetId, value] of Object.entries(state.consecutive)) {
    if (inWatchList.has(targetId)) consecutive[targetId] = { ...value };
  }
  const alarm: RunState["alarm"] = {};
  for (const [cause, value] of Object.entries(state.alarm)) {
    const targets = causeTargets(cause);
    if (targets.length > 0 && targets.every((targetId) => inWatchList.has(targetId))) {
      alarm[cause] = { ...value };
    }
  }

  const byTarget = new Map(ran.map((target) => [target.targetId, target]));
  const refused = (target: TargetRun): boolean =>
    target.exitCode === EXIT_TRANSIENT &&
    target.reason !== null &&
    IMMEDIATE_REFUSAL_REASONS.includes(target.reason);

  // THE COUNTERS, FROM THIS RUN'S EXITS. Any other code RESETS the counter it is not: a target
  // empty on runs 1, 3 and 5 is not a target that has been empty for three runs (G-2).
  for (const target of ran) {
    if (!inWatchList.has(target.targetId)) continue;
    const current = consecutive[target.targetId] ?? { sourceEmpty: 0, transient: 0 };
    consecutive[target.targetId] = {
      sourceEmpty: target.exitCode === EXIT_SOURCE_EMPTY ? current.sourceEmpty + 1 : 0,
      transient: target.exitCode === EXIT_TRANSIENT ? current.transient + 1 : 0,
    };
  }

  const overlap = maxPairOverlap(ran);
  const feedTripped = trips(overlap);

  // EXISTING CAUSES, AGAINST THIS RUN'S EVIDENCE. Evaluated against the pre-drop snapshot, so
  // one cause clearing cannot change what another cause measures in the same run.
  const dropped: string[] = [];
  for (const [cause, value] of Object.entries(alarm)) {
    value.runs += 1;

    const targets = causeTargets(cause);
    const runTargets = targets.map((targetId) => byTarget.get(targetId));
    if (runTargets.some((target) => target === undefined)) continue;
    const present = runTargets as TargetRun[];

    if (cause.startsWith("feed-overlap:")) {
      // POSITIVE EVIDENCE, and this branch always required it: both pages must have been fetched
      // and parsed (non-empty id sets) and the denominator must clear the floor. The same
      // predicate the trip uses, so "clean" and "tripped" cannot disagree about what was
      // measurable. A probe of a pair whose page came back empty measures nothing.
      const pair = maxPairOverlap(present);
      if (pair === null || pair.of < OVERLAP_MIN_DENOMINATOR) continue;
      if (pair.shared / pair.of >= OVERLAP_ALARM_FRACTION) {
        value.cleanProbes = 0;
        continue;
      }
    } else {
      /**
       * DIRTY FIRST, THEN POSITIVE EVIDENCE -- AND THE ORDER OF THESE TWO CHECKS IS THE WHOLE
       * FIX. Dirty has to reset `cleanProbes` even though a dirty code is never positive
       * evidence of recovery, so it cannot be folded into the `measured` test.
       */
      const target = present[0];
      const dirty = cause.startsWith("source-empty:")
        ? target.exitCode === EXIT_SOURCE_EMPTY
        : cause.startsWith("transient:")
          ? target.exitCode === EXIT_TRANSIENT
          : refused(target);

      if (dirty) {
        value.cleanProbes = 0;
        continue;
      }

      /**
       * A CLEAN PROBE NEEDS POSITIVE EVIDENCE THAT THE SOURCE WAS MEASURED, NOT MERELY THE
       * ABSENCE OF THE CAUSE'S OWN EXIT CODE. THIS WAS A PURE NEGATION AND IT DEFEATED THE GUARD
       * IN THE ONE CASE INVARIANT 5 CALLS UNRECOVERABLE.
       *
       * MEASURED, both halves:
       *
       *   `refused:a` latched, then two exit-4 runs -> `causes: []`. A PROVIDER_FAILURE measured
       *   nothing -- the page changed shape and nothing was posted -- yet under a negation it was
       *   not an exit 5 with a refusal reason, so it counted as a clean probe. Facebook
       *   escalating a 429 into a login wall (exit 4, `blocked-redirect` is a 3xx but a
       *   checkpoint page is a 200 of the wrong shape) therefore CLEARED the latch two runs
       *   later and the collector went back to 9 requests per run into an active refusal.
       *
       *   A target alternating 3,3,3,5,5 forever held the latch on only 40 % of runs -- 232
       *   requests over 40 runs against a 360 baseline -- because each condition treated the
       *   OTHER condition's failure as evidence of its own recovery. That is the period-cycle
       *   this file's own header says the design was chosen to avoid, reintroduced by the clean
       *   predicate rather than by the latch.
       *
       * SO THE RULE IS THE ONE THE `feed-overlap` BRANCH ABOVE ALREADY FOLLOWED: only a run that
       * really fetched and parsed the page is a measurement. EXIT_OK is one. EXIT_CONTRACT is
       * one too, and that is not a loophole: at a target it is reachable ONLY after
       * `classifyParsedPage` returned SUCCESS (`collector/run.ts` branches to it from the POST's
       * 4xx and from `FAILED > 0`, both below the SUCCESS gate), so the SOURCE was measured and
       * only the Worker write failed. Every other code -- 2 the row was unusable, 3 the cause's
       * own signature, 4 the page changed shape, 5 either the cause's own signature or a POST
       * failure that says nothing about Facebook -- is NOT MEASURED: no credit, no reset.
       */
      if (target.exitCode !== EXIT_OK && target.exitCode !== EXIT_CONTRACT) continue;
    }

    value.cleanProbes += 1;
    if (value.cleanProbes >= CANARY_CLEAN_PROBES) dropped.push(cause);
  }

  // NEW LATCHES. `raise` never touches a cause the loop above has already updated this run.
  const raise = (cause: string): void => {
    if (alarm[cause] === undefined) alarm[cause] = { runs: 1, cleanProbes: 0 };
  };
  for (const target of ran) {
    if (!inWatchList.has(target.targetId)) continue;
    const current = consecutive[target.targetId];
    if (current === undefined) continue;
    if (current.sourceEmpty >= CONSECUTIVE_ALARM_RUNS) raise(`source-empty:${target.targetId}`);
    if (current.transient >= CONSECUTIVE_ALARM_RUNS) raise(`transient:${target.targetId}`);
    if (refused(target)) raise(`refused:${target.targetId}`);
  }
  if (feedTripped) raise(`feed-overlap:${overlap.a}+${overlap.b}`);

  // THE DROPS, AND THE COUNTER RESET THEY CARRY. Applied last so that a reset cannot suppress a
  // latch decided above -- which cannot happen anyway, because dropping needs a CLEAN
  // measurement and latching needs a DIRTY one, and this ordering makes that structural.
  for (const cause of dropped) {
    delete alarm[cause];
    for (const targetId of causeTargets(cause)) {
      if (consecutive[targetId] !== undefined) {
        consecutive[targetId] = { sourceEmpty: 0, transient: 0 };
      }
    }
  }

  const causes = Object.keys(alarm).sort();

  /**
   * THE VOLUME CUT'S OWN COUNTER, AND IT IS SEPARATE FROM THE ALARM.
   *
   * The expiry resets it to 0 and LEAVES THE ALARM RAISED (G-19): the alarm is cleared only by
   * clean probes, so the full run the expiry produces is a measurement, not a pardon. A full run
   * that engaged no cut has nothing to count, and a cleared alarm means the cut is over.
   */
  const canaryRuns = input.expired || causes.length === 0 ? 0 : input.canary ? state.canaryRuns + 1 : 0;

  return {
    state: {
      version: 1,
      consecutive,
      alarm,
      probe: input.nextProbe,
      canaryRuns,
    },
    causes,
    overlap,
  };
};
