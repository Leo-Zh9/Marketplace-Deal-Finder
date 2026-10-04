/**
 * The wiring, and ONLY the wiring: read the environment, call `runAllTargets`, exit.
 *
 * NO TEST COVERS THIS FILE, and that is stated rather than hidden. Every line of LOGIC it
 * touches lives in `runTargets.ts`, `runState.ts`, `watchTargets.ts` and `run.ts` and is tested
 * there against injected seams; what is left here is `process.env`, `readFile`, `writeFile`,
 * `chmod`, `rename`, `console.log`, `process.exit` and the live `fetch`, none of which can be
 * exercised without a network or a process fork. `npm run e2e:local` does run this file end to
 * end with COLLECTOR_HTML_FILE set, so the wiring is exercised by the gate even though no unit
 * test reaches it.
 *
 * THE STATE FILE'S PATH AND MODE ARE THE NEWEST VALUES ON THAT LIST, and the gate is the ONLY
 * thing that can see either. `readState` and `writeState` are supplied from here, so a unit test
 * injecting them is blind to which FILE a real run touches -- which is exactly the shape of the
 * throttle hole below. E-1 asserts the real process writes the path the gate names, and §R5 of
 * the plan records why that is correctness rather than tidiness: without it the gate's
 * deliberately identical fixtures would latch the operator's production guard.
 *
 * `setTimeout` USED TO BE ON THAT LIST AND IT DID NOT BELONG THERE. It is exercisable with
 * neither a network nor a fork, and while it sat inline below, replacing it with
 * `() => Promise.resolve()` left 156 unit tests and 79 gate assertions green with the throttle
 * between searches gone. It is now `realSleep`, imported from runTargets.ts and unit-tested.
 * THE LESSON GENERALISES: a dependency supplied here is only as good as what observes it, so
 * anything that is mechanism rather than plumbing belongs behind the seam, not in this file.
 *
 * THE ONE PRODUCTION VALUE NO UNIT TEST REACHES IS THE THROTTLE FALLBACK. Unit tests inject
 * `sleep` and never read the environment, so the only coverage of "what delay does a real run
 * actually use" is the gate's TWO rows: `COLLECTOR_TARGET_DELAY_MS` UNSET must report
 * `"delayMs":60000`, and set to `0` must report `"delayMs":0`. Neither alone is enough -- with
 * the variable unset a TYPO'D NAME also reports 60000, and the `0` row alone would pass with a
 * literal `0` fallback here. THE FALLBACK BELOW MUST STAY THE IMPORTED `TARGET_DELAY_MS`; a
 * literal here is the defect those two rows exist to catch, and the first row's variable must be
 * left UNSET rather than set to 60000.
 *
 * WHAT MOVED OUT OF HERE, AND IT MUST NOT COME BACK: the per-target environment variables
 * (COLLECTOR_COMPONENT_TYPE, COLLECTOR_LOCATION, COLLECTOR_QUERY, COLLECTOR_LATITUDE,
 * COLLECTOR_LONGITUDE, COLLECTOR_RADIUS_KM). Those values now come from the server, over HTTP,
 * on the collector credential. Orchestration leaking back into this file is the thing to watch
 * for in review.
 *
 * Run it with `npm run collect`. Node 24 runs a .ts entry with .ts-extension imports and no
 * flag; that is measured, and it is why there is no build step for the collector.
 */

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { postRunHealth } from "./postRunHealth.ts";
import { EXIT_CONFIG, run } from "./run.ts";
import { realSleep, runAllTargets, TARGET_DELAY_MS, type ProcessConfig } from "./runTargets.ts";
import { SPEC_RESULT_LIMIT } from "./types.ts";
import { fetchWatchTargets } from "./watchTargets.ts";


const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`collector: ${name} is required and is not set`);
    process.exit(EXIT_CONFIG);
  }
  return value.trim();
};

const optionalInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    console.error(`collector: ${name} must be an integer`);
    process.exit(EXIT_CONFIG);
  }
  return value;
};

// DEFAULTS EXIST ONLY WHERE A WRONG VALUE CANNOT CORRUPT DATA. `source` has none: it scopes every
// stored row, and a silent default would write into the wrong name. The component type, the
// coordinates and the radius are no longer read here at all -- they are the server's to say.
const processConfig: ProcessConfig = {
  apiBase: required("COLLECTOR_API_BASE").replace(/\/+$/, ""),
  token: required("COLLECTOR_TOKEN"),
  source: process.env.COLLECTOR_SOURCE?.trim() || "facebook-marketplace",
  limit: optionalInteger("COLLECTOR_LIMIT", SPEC_RESULT_LIMIT),
  daysSinceListed: optionalInteger("COLLECTOR_DAYS_SINCE_LISTED", 7),
  htmlFile: process.env.COLLECTOR_HTML_FILE?.trim() || null,
  dryRun: (process.env.COLLECTOR_DRY_RUN ?? "") !== "",
};

/**
 * THE CROSS-RUN STATE FILE, AND IT IS PROTECTED BY ITS MODE AND ITS LOCATION, NOT BY .gitignore.
 *
 * It lives in $HOME beside `~/.marketplace-collector.env`, which is protected the same way and
 * for the same reason: a file inside the repository is one `git add -A` away from being
 * committed, and `.gitignore` is a convention that a `-f` overrides. Nothing in it is a secret
 * today -- target ids, counters and cause strings -- but it IS the guard's memory, so a
 * world-writable copy is a way to turn the guard off or to pin it on.
 *
 * `COLLECTOR_STATE_FILE` EXISTS FOR THE GATE, AND THAT IS CORRECTNESS RATHER THAN TIDINESS.
 * `scripts/e2e-local.sh` runs `node collector/main.ts` directly; without an override it would
 * write the file the operator's real launchd collector reads, and the gate's deliberately
 * identical fixtures would LATCH THE PRODUCTION GUARD. E-1 is the only layer that can see that.
 */
const STATE_FILE =
  process.env.COLLECTOR_STATE_FILE?.trim() || join(homedir(), ".marketplace-collector-state.json");

/**
 * ABSENT IS `null`, NOT A THROW, AND IT IS THE NORMAL CASE: there is no state file until the
 * first run writes one. Every other read error is also `null`, because `runAllTargets` treats
 * both the same way -- a fresh state at FULL volume -- and a read that threw out of here would
 * take the whole run with it over a file that is an optimisation, not a prerequisite.
 */
const readState = async (): Promise<string | null> => {
  try {
    return await readFile(STATE_FILE, "utf8");
  } catch {
    return null;
  }
};

/**
 * TEMP + `rename`, AND THE `chmod` IS NOT REDUNDANT.
 *
 * `rename` within one filesystem is atomic, so a process killed mid-write leaves the PREVIOUS
 * state rather than a truncated file that `parseRunState` would have to treat as fresh -- which
 * would silently clear a latched guard on an unlucky kill.
 *
 * `writeFile`'s `mode` OPTION APPLIES ONLY WHEN THE FILE IS CREATED. A temp file left behind by
 * an earlier crash is opened for truncation, not creation, so its existing mode survives and the
 * `mode` option is a no-op. The explicit `chmod` is what makes 0600 unconditional, and it runs
 * BEFORE the rename so the file is never visible at its final path with a wider mode.
 */
const writeState = async (serialized: string): Promise<void> => {
  const temporary = `${STATE_FILE}.tmp`;
  await writeFile(temporary, serialized, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, STATE_FILE);
};

const exitCode = await runAllTargets(
  {
    process: processConfig,
    // THE IMPORTED CONSTANT, NEVER A LITERAL. See the header.
    delayMs: optionalInteger("COLLECTOR_TARGET_DELAY_MS", TARGET_DELAY_MS),
  },
  {
    fetchTargets: fetchWatchTargets,
    run: (config) => run(config, { readHtmlFile: (path: string) => readFile(path, "utf8") }),
    readState,
    writeState,
    // ONE REPORT PER RUN LINE, on the SAME credential the listings POST and the watch-list GET
    // already use. The report carries no clock: the server stamps `reported_at` itself, so a
    // laptop whose clock is wrong cannot report itself permanently fresh.
    postHealth: (report) =>
      postRunHealth({ apiBase: processConfig.apiBase, token: processConfig.token, report }),
    // THE REAL SLEEP IS IMPORTED, NEVER WRITTEN HERE. Inline, it was a `setTimeout` call in the
    // one file no test reaches: replacing it with `() => Promise.resolve()` left the unit suite
    // and the whole gate green while the throttle was gone. `realSleep` is unit-tested (L-14) and
    // the gate now asserts the WALL TIME of a real multi-target run.
    sleep: realSleep,
    // ONE LINE OF JSON PER TARGET AND ONE FOR THE RUN, machine-readable, on stdout. The e2e gate
    // greps them, and so does the launchd wrapper.
    log: (line: string) => console.log(line),
  },
);

process.exit(exitCode);
