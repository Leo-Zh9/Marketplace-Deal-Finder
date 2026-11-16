// @vitest-environment node

/**
 * THE SCRIPT AS THE OPERATOR RUNS IT: plain `node`, a real file, a real process. This is the only
 * layer that sees the resolve hook -- the Worker's extensionless imports load under vitest's
 * bundler whether or not the hook works, so a unit test of `replay.ts` alone is blind to it.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["scripts/replay-normalization.ts", ...args], {
    cwd: root,
    encoding: "utf8",
  });

describe("scripts/replay-normalization.ts", () => {
  it("replays a wrangler --json export under plain node and prints all four sections", () => {
    const result = run("worker/normalize/testing/d1ListingsExport.json");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rows replayed: 10 of 11");
    expect(result.stdout).toContain("(a) reasons at this commit");
    expect(result.stdout).toContain("  stored 3\n  commit 3\n");
    expect(result.stdout).toContain("(c) stored vs this commit: 5 rows differ");
    expect(result.stdout).toContain("(d) unkeyed components: 5");
  });

  it("exits 2 with a usage line when no file is given, and 2 on input that is not an export", () => {
    const usage = run();
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage:");

    const bad = run("package.json");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("replay:");
  });
});
