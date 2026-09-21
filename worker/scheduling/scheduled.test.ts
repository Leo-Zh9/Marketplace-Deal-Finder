// @vitest-environment node

/**
 * The Cron handler, and the link between the deployed configuration and the code.
 *
 * S3 is the test that closes what used to be a runbook-only check. A Cron trigger and a
 * Workflow binding are the one part of this phase that can be wrong in a way NOTHING
 * notices: a renamed class or a changed cron still deploys, still fires daily, and does
 * nothing at all. It costs 3ms, runs offline and spawns no subprocess.
 *
 * TWO CRONS NOW, AND THE TWO PAYLOADS ARE BYTE-IDENTICAL `{ now }`. Routing is discriminated
 * ONLY by which binding's `create` was called, so every routing test here asserts BOTH
 * recorders: an assertion on one alone is equally satisfied by a handler that fires neither.
 */

import { unstable_readConfig } from "wrangler";
import * as entry from "../index";
import {
  CLEANUP_CRON,
  MONITOR_CRON,
  handleScheduled,
  type ScheduledEnvironment,
} from "./scheduled";
import type { CleanupParams } from "./runCleanup";
import type { MonitorParams } from "./runMonitor";

const T = 1_800_000_000;
/** A second instant, so the two routing tests share no parameter. */
const T_MONITOR = 1_710_000_000;

/**
 * The slice of wrangler's parsed config this test depends on. Named explicitly because
 * `unstable_readConfig` resolves to `any` under tsconfig.worker.json, and an untyped
 * `config.workflows.find(...)` would silently accept a renamed field.
 */
interface DeployedConfig {
  triggers: { crons: string[] };
  workflows: Array<{ binding: string; class_name: string }>;
}

const controller = (cron: string, scheduledTime: number): ScheduledController => ({
  cron,
  scheduledTime,
  noRetry: () => {},
});

/**
 * ONE RECORDER PER BINDING; `params` is captured exactly as the handler passed it, and the
 * instance ids differ so "started" names WHICH workflow started rather than merely that one
 * did. A crossed pair -- monitoring's cron reaching CLEANUP_WORKFLOW -- runs cleanup 48 times
 * a day with nothing in production to notice.
 */
const recordingEnvironment = () => {
  const cleanup: Array<CleanupParams | undefined> = [];
  const monitor: Array<MonitorParams | undefined> = [];
  const environment = {
    DB: null,
    CLEANUP_WORKFLOW: {
      create: (options?: { params?: CleanupParams }) => {
        cleanup.push(options?.params);
        return Promise.resolve({ id: "cleanup-instance" });
      },
    },
    MONITOR_WORKFLOW: {
      create: (options?: { params?: MonitorParams }) => {
        monitor.push(options?.params);
        return Promise.resolve({ id: "monitor-instance" });
      },
    },
  } as unknown as ScheduledEnvironment;
  return { environment, cleanup, monitor };
};

describe("the cleanup Cron handler", () => {
  // S1. The millisecond remainder is the whole point of the fixture: at a round
  // scheduledTime, Math.floor, Math.round and Math.ceil all agree and the test proves
  // nothing. `999` separates them.
  it("S1: the cleanup cron starts exactly one cleanup instance, with `now` in epoch SECONDS", async () => {
    const { environment, cleanup, monitor } = recordingEnvironment();

    const result = await handleScheduled(controller(CLEANUP_CRON, T * 1000 + 999), environment);

    expect(result).toEqual({ started: "cleanup-instance" });
    expect(cleanup).toEqual([{ now: T }]);
    expect(monitor).toEqual([]);
  });

  // S1b. The same three properties for the second trigger. `499` and S1's `999` separate
  // Math.floor from Math.round in opposite directions, so a rounding change dies in one of the
  // two whichever way it goes.
  it("S1b: the monitoring cron starts exactly one monitor instance, and never the cleanup one", async () => {
    const { environment, cleanup, monitor } = recordingEnvironment();

    const result = await handleScheduled(
      controller(MONITOR_CRON, T_MONITOR * 1000 + 499),
      environment,
    );

    expect(result).toEqual({ started: "monitor-instance" });
    expect(monitor).toEqual([{ now: T_MONITOR }]);
    expect(cleanup).toEqual([]);
  });

  // S2. The unrelated cron used to be the monitoring one; it is a real trigger now, so it was
  // retargeted. Leaving it would have silently stopped testing the guard.
  it("S2: an unrelated cron starts nothing and never touches either binding", async () => {
    const environment = {
      DB: null,
      CLEANUP_WORKFLOW: {
        create: () => {
          throw new Error("CLEANUP_WORKFLOW.create must not be called");
        },
      },
      MONITOR_WORKFLOW: {
        create: () => {
          throw new Error("MONITOR_WORKFLOW.create must not be called");
        },
      },
    } as unknown as ScheduledEnvironment;

    await expect(
      handleScheduled(controller("13 4 * * *", T * 1000), environment),
    ).resolves.toEqual({ started: null });
  });

  /**
   * S3. Three links in one assertion chain, each of which fails silently in production:
   * the cron string wrangler deploys vs. the one the handler matches; the class_name the
   * binding names vs. what the entry module actually exports; and whether the entry has a
   * `scheduled` export at all.
   */
  it("S3: the deployed config names both crons, and classes the entry module exports", () => {
    const config: DeployedConfig = unstable_readConfig({ config: "wrangler.jsonc" });

    // Found BY BINDING, never workflows[0]: there are two Workflows in this list now, and the
    // order in the file is not a contract.
    for (const [binding, cron] of [
      ["CLEANUP_WORKFLOW", CLEANUP_CRON],
      ["MONITOR_WORKFLOW", MONITOR_CRON],
    ] as const) {
      const workflow = config.workflows.find((bound) => bound.binding === binding);
      expect(workflow).toBeDefined();
      expect(config.triggers.crons).toContain(cron);
      // wrangler binds a Workflow to a class exported FROM THE MAIN ENTRY. A missing
      // re-export deploys a cron that fires every 30 minutes and does nothing.
      expect(Object.keys(entry)).toContain(workflow!.class_name);
    }
    // THE UNRELATED-CRON LITERAL MUST STAY UNRELATED. "*/30 * * * *" was three files' "cron
    // that matches nothing" until this phase made it a real trigger, and every one of those
    // guards would have gone vacuous in silence. "13 4 * * *" replaced it in scheduled.test.ts
    // S2, cleanupWorkflow.test.ts H1 and monitorWorkflow.test.ts W1; this is the one line that
    // stops the same thing happening again.
    expect(config.triggers.crons).not.toContain("13 4 * * *");

    // ...and the two must not be the same class, which `toContain` alone would allow.
    expect(config.workflows.find((b) => b.binding === "CLEANUP_WORKFLOW")!.class_name).not.toBe(
      config.workflows.find((b) => b.binding === "MONITOR_WORKFLOW")!.class_name,
    );
    expect(typeof entry.default.scheduled).toBe("function");
  });
});
