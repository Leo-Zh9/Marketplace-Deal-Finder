/**
 * The Cron entry point. One trigger, one Workflow instance, nothing else.
 *
 * CLOUDFLARE CRON IS UTC, with no timezone field and no DST. The spec asks for local noon;
 * no fixed expression is local noon year-round. 17:00 UTC is pinned to EST (UTC-5) for an
 * ASSUMED America/Toronto operator -- an inference, not a fact, and named as one here, in
 * wrangler.jsonc and in docs/phase-3e-scheduling.md. It fires at 12:00 local in winter and
 * 13:00 local in summer; EST is the choice that makes the drift always later, never earlier
 * into the morning.
 */

import type { CleanupParams } from "./runCleanup";

export const CLEANUP_CRON = "0 17 * * *";

export interface ScheduledEnvironment {
  DB: D1Database;
  CLEANUP_WORKFLOW: Workflow<CleanupParams>;
}

export const handleScheduled = async (
  controller: ScheduledController,
  environment: ScheduledEnvironment,
): Promise<{ started: string | null }> => {
  // Matched explicitly rather than assumed. 3E-b adds a second cron to the same handler,
  // and an unmatched trigger must not start a cleanup.
  if (controller.cron !== CLEANUP_CRON) return { started: null };

  // scheduledTime is MILLISECONDS; `now` is seconds. Getting this wrong makes the cutoff
  // `now_ms - 604800`, which is still in the future by every row's reckoning, so the first
  // run would delete the entire table.
  const instance = await environment.CLEANUP_WORKFLOW.create({
    params: { now: Math.floor(controller.scheduledTime / 1000) },
  });
  return { started: instance.id };
};
