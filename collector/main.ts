/**
 * The wiring, and ONLY the wiring: read the environment, call `runAllTargets`, exit.
 *
 * NO TEST COVERS THIS FILE, and that is stated rather than hidden. Every line of LOGIC it
 * touches lives in `runTargets.ts`, `watchTargets.ts` and `run.ts` and is tested there against
 * injected seams; what is left here is `process.env`, `readFile`, `console.log`, `process.exit`
 * and the live `fetch`, none of which can be exercised without a network or a process fork.
 * `npm run e2e:local` does run this file end to end with COLLECTOR_HTML_FILE set, so the wiring
 * is exercised by the gate even though no unit test reaches it.
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

import { readFile } from "node:fs/promises";
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

const exitCode = await runAllTargets(
  {
    process: processConfig,
    // THE IMPORTED CONSTANT, NEVER A LITERAL. See the header.
    delayMs: optionalInteger("COLLECTOR_TARGET_DELAY_MS", TARGET_DELAY_MS),
  },
  {
    fetchTargets: fetchWatchTargets,
    run: (config) => run(config, { readHtmlFile: (path: string) => readFile(path, "utf8") }),
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
