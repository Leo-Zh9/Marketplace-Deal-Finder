// @vitest-environment node

/**
 * The launchd schedule -- the plist template and the wrapper, driven from the suite.
 *
 * IT LIVES IN collector/ RATHER THAN scripts/ FOR A CONCRETE REASON: `tsconfig.collector.json`
 * is the only project that includes Node types, and nothing typechecks a `scripts/*.ts` at all.
 * A test file there would be linted and never typechecked.
 *
 * NOTHING HERE INSTALLS ANYTHING. No `launchctl load`, no `launchctl bootstrap`, no write to
 * ~/Library/LaunchAgents. The plist is rendered into a temporary directory and linted; the
 * wrapper is run against a temporary repo whose `collector/main.ts` is a stub.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const templatePath = join(
  repoRoot,
  "scripts/launchd/com.marketplace-deal-finder.collector.plist.template",
);
const wrapperPath = join(repoRoot, "scripts/collector-run.sh");

let workspace!: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "collector-schedule-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const renderPlist = (): string => {
  const rendered = readFileSync(templatePath, "utf8")
    .replaceAll("__REPO__", "/Users/example/Marketplace-Deal-Finder")
    .replaceAll("__HOME__", "/Users/example");
  const path = join(workspace, "rendered.plist");
  writeFileSync(path, rendered);
  return path;
};

describe("the launchd schedule", () => {
  /**
   * D-1: launchd IGNORES A MALFORMED PLIST IN SILENCE -- the job simply never runs and nothing
   * says why. `plutil -lint` is the only thing that turns an XML typo into a failure.
   */
  it("D-1: the rendered plist passes plutil -lint", () => {
    const path = renderPlist();
    const output = execFileSync("/usr/bin/plutil", ["-lint", path], { encoding: "utf8" });
    expect(output).toContain("OK");

    // The placeholders really are gone -- a template shipped as-is would lint and never run.
    const rendered = readFileSync(path, "utf8");
    expect(rendered).not.toContain("__REPO__");
    expect(rendered).not.toContain("__HOME__");
  });

  /**
   * D-2: `StartCalendarInterval`, NEVER `StartInterval`, and on a Mac that sleeps these are not
   * equivalent. man launchd.plist: StartInterval -- "If the system is asleep during the time of
   * the next scheduled interval firing, THAT INTERVAL WILL BE MISSED"; StartCalendarInterval --
   * "Unlike cron which skips job invocations when the computer is asleep, LAUNCHD WILL START THE
   * JOB THE NEXT TIME THE COMPUTER WAKES UP."
   *
   * The absence assertion is the load-bearing half: swapping the key is the mutation that
   * silently loses a window, and a test that only read StartCalendarInterval would pass with
   * BOTH keys present.
   */
  it("D-2: it fires at :00 and :30 through StartCalendarInterval, and StartInterval is absent", () => {
    const path = renderPlist();
    const json = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }),
    ) as Record<string, unknown>;

    expect(json.StartCalendarInterval).toEqual([{ Minute: 0 }, { Minute: 30 }]);
    expect(Object.hasOwn(json, "StartInterval")).toBe(false);
    expect(json.Label).toBe("com.marketplace-deal-finder.collector");
    expect(json.ProgramArguments).toEqual([
      "/Users/example/Marketplace-Deal-Finder/scripts/collector-run.sh",
    ]);
    // "speculative job launches have an adverse effect on system-boot and user-login scenarios".
    expect(json.RunAtLoad).toBe(false);
    // A secret in a world-readable file is what the wrapper's env file exists to avoid.
    expect(Object.hasOwn(json, "EnvironmentVariables")).toBe(false);
  });

  /**
   * D-3: the wrapper EXITS WITH THE COLLECTOR'S CODE and TIMESTAMPS EVERY LINE.
   *
   * The exit code is the operator's only signal and launchd records it as `last exit code`; an
   * unconditional `exit 0` would report every failure as a success. The timestamp is what makes
   * a MISSED SCHEDULE WINDOW VISIBLE: coverage equals uptime on a Mac that sleeps, so a skipped
   * window can only be seen as a gap in a timestamped file.
   */
  const stubRepo = (script: string): string => {
    const root = mkdtempSync(join(tmpdir(), "collector-repo-"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "collector"));
    cpSync(wrapperPath, join(root, "scripts/collector-run.sh"));
    chmodSync(join(root, "scripts/collector-run.sh"), 0o755);
    writeFileSync(join(root, "collector/main.ts"), script);
    writeFileSync(join(root, "env"), "COLLECTOR_API_BASE=http://127.0.0.1:8787\n");
    chmodSync(join(root, "env"), 0o600);
    return root;
  };

  const runWrapper = (root: string) => {
    try {
      const stdout = execFileSync(join(root, "scripts/collector-run.sh"), [], {
        encoding: "utf8",
        env: { ...process.env, COLLECTOR_ENV_FILE: join(root, "env") },
      });
      return { status: 0, stdout };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? -1, stdout: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  it.each<[number]>([[0], [3], [6]])(
    "D-3: the wrapper exits with the collector's own code %i",
    (code) => {
      const root = stubRepo(
        `console.log(JSON.stringify({ kind: "run", exitCode: ${code} }));\nprocess.exit(${code});\n`,
      );
      try {
        expect(runWrapper(root).status).toBe(code);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("D-3: every emitted line is prefixed with an ISO-8601 UTC timestamp", () => {
    const root = stubRepo(
      'console.log("first");\nconsole.error("second");\nconsole.log("third");\nprocess.exit(4);\n',
    );
    try {
      const { status, stdout } = runWrapper(root);
      expect(status).toBe(4);

      const lines = stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /);
      }
      // The content survives the stamping -- a filter that dropped stderr would lose the
      // collector's own diagnostics.
      expect(stdout).toContain(" first");
      expect(stdout).toContain(" second");
      expect(stdout).toContain(" third");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * D-4: the env file guard, and it is NOT tidiness -- it is the reason there is a wrapper at
   * all. Files in ~/Library/LaunchAgents are world-readable, so the token lives in a 600 file
   * instead. A guard that warned and continued would leave a readable secret in place forever.
   */
  it("D-4: a missing or world-readable env file is refused, loudly, with exit 2", () => {
    const root = stubRepo('console.log("ran");\nprocess.exit(0);\n');
    try {
      chmodSync(join(root, "env"), 0o644);
      const loose = runWrapper(root);
      expect(loose.status).toBe(2);
      expect(loose.stdout).toContain("must be mode 600");
      expect(loose.stdout).not.toContain("ran");

      rmSync(join(root, "env"));
      const missing = runWrapper(root);
      expect(missing.status).toBe(2);
      expect(missing.stdout).toContain("does not exist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
