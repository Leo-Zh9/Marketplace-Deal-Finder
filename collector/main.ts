/**
 * The wiring, and ONLY the wiring: read the environment, call `run`, print one line, exit.
 *
 * NO TEST COVERS THIS FILE, and that is stated rather than hidden. Every line of LOGIC it
 * touches lives in `run.ts` and is tested there against injected seams; what is left here is
 * `process.env`, `readFile`, `process.exit` and the live `fetch`, none of which can be exercised
 * without a network or a process fork. `npm run e2e:local` does run this file end to end with
 * COLLECTOR_HTML_FILE set, so the wiring is exercised by the gate even though no unit test
 * reaches it.
 *
 * Run it with `npm run collect`. Node 24 runs a .ts entry with .ts-extension imports and no
 * flag; that is measured, and it is why there is no build step for the collector.
 */

import { readFile } from "node:fs/promises";
import { run, type CollectorConfig } from "./run.ts";
import { SPEC_RESULT_LIMIT } from "./types.ts";

const EXIT_CONFIG = 2;

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`collector: ${name} is required and is not set`);
    process.exit(EXIT_CONFIG);
  }
  return value.trim();
};

const requiredNumber = (name: string): number => {
  const value = Number(required(name));
  if (!Number.isFinite(value)) {
    console.error(`collector: ${name} must be a number`);
    process.exit(EXIT_CONFIG);
  }
  return value;
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

// DEFAULTS EXIST ONLY WHERE A WRONG VALUE CANNOT CORRUPT DATA. `source`, the component type,
// the coordinates and the radius have none: every one of them scopes a stored row or an
// aggregate, and a silent default would write into the wrong market under the wrong name.
const config: CollectorConfig = {
  apiBase: required("COLLECTOR_API_BASE").replace(/\/+$/, ""),
  token: required("COLLECTOR_TOKEN"),
  source: process.env.COLLECTOR_SOURCE?.trim() || "facebook-marketplace",
  componentType: required("COLLECTOR_COMPONENT_TYPE"),
  location: required("COLLECTOR_LOCATION"),
  query: required("COLLECTOR_QUERY"),
  latitude: requiredNumber("COLLECTOR_LATITUDE"),
  longitude: requiredNumber("COLLECTOR_LONGITUDE"),
  radiusKm: requiredNumber("COLLECTOR_RADIUS_KM"),
  limit: optionalInteger("COLLECTOR_LIMIT", SPEC_RESULT_LIMIT),
  daysSinceListed: optionalInteger("COLLECTOR_DAYS_SINCE_LISTED", 7),
  htmlFile: process.env.COLLECTOR_HTML_FILE?.trim() || null,
  dryRun: (process.env.COLLECTOR_DRY_RUN ?? "") !== "",
};

const { exitCode, summary } = await run(config, {
  readHtmlFile: (path: string) => readFile(path, "utf8"),
});

// ONE LINE, machine-readable, on stdout. The e2e gate greps it, and so can a launchd wrapper.
console.log(JSON.stringify(summary));
process.exit(exitCode);
