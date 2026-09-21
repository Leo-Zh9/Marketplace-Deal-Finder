// @vitest-environment node

/**
 * The Cron handler, and the link between the deployed configuration and the code.
 *
 * S3 is the test that closes what used to be a runbook-only check. A Cron trigger and a
 * Workflow binding are the one part of this phase that can be wrong in a way NOTHING
 * notices: a renamed class or a changed cron still deploys, still fires daily, and does
 * nothing at all. It costs 3ms, runs offline and spawns no subprocess.
 */

import { unstable_readConfig } from "wrangler";
import * as entry from "../index";
import { CLEANUP_CRON, handleScheduled, type ScheduledEnvironment } from "./scheduled";
import type { CleanupParams } from "./runCleanup";

const T = 1_800_000_000;

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

/** Records every create; `params` is captured exactly as the handler passed it. */
const recordingEnvironment = () => {
  const created: Array<CleanupParams | undefined> = [];
  const environment = {
    DB: null,
    CLEANUP_WORKFLOW: {
      create: (options?: { params?: CleanupParams }) => {
        created.push(options?.params);
        return Promise.resolve({ id: "instance-1" });
      },
    },
  } as unknown as ScheduledEnvironment;
  return { environment, created };
};

describe("the cleanup Cron handler", () => {
  // S1. The millisecond remainder is the whole point of the fixture: at a round
  // scheduledTime, Math.floor, Math.round and Math.ceil all agree and the test proves
  // nothing. `999` separates them.
  it("S1: the configured cron starts exactly one instance, with `now` in epoch SECONDS", async () => {
    const { environment, created } = recordingEnvironment();

    const result = await handleScheduled(controller(CLEANUP_CRON, T * 1000 + 999), environment);

    expect(result).toEqual({ started: "instance-1" });
    expect(created).toEqual([{ now: T }]);
  });

  it("S2: an unrelated cron starts nothing and never touches the binding", async () => {
    const environment = {
      DB: null,
      CLEANUP_WORKFLOW: {
        create: () => {
          throw new Error("CLEANUP_WORKFLOW.create must not be called");
        },
      },
    } as unknown as ScheduledEnvironment;

    await expect(
      handleScheduled(controller("*/30 * * * *", T * 1000), environment),
    ).resolves.toEqual({ started: null });
  });

  /**
   * S3. Three links in one assertion chain, each of which fails silently in production:
   * the cron string wrangler deploys vs. the one the handler matches; the class_name the
   * binding names vs. what the entry module actually exports; and whether the entry has a
   * `scheduled` export at all.
   */
  it("S3: the deployed config names the cron, and a class the entry module exports", () => {
    const config: DeployedConfig = unstable_readConfig({ config: "wrangler.jsonc" });

    // Found BY BINDING, never workflows[0]: 3E-b adds a second Workflow to this list.
    const workflow = config.workflows.find((bound) => bound.binding === "CLEANUP_WORKFLOW");
    expect(workflow).toBeDefined();

    expect(config.triggers.crons).toContain(CLEANUP_CRON);
    expect(Object.keys(entry)).toContain(workflow!.class_name);
    expect(typeof entry.default.scheduled).toBe("function");
  });
});
