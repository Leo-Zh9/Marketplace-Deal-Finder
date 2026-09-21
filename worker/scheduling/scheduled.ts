/**
 * The Cron entry point. TWO triggers, two Workflows, and an explicit match for each.
 *
 * CLOUDFLARE CRON IS UTC, with no timezone field and no DST. The spec asks for local noon;
 * no fixed expression is local noon year-round. 17:00 UTC is pinned to EST (UTC-5) for an
 * ASSUMED America/Toronto operator -- an inference, not a fact, and named as one here, in
 * wrangler.jsonc and in docs/phase-3e-scheduling.md. It fires at 12:00 local in winter and
 * 13:00 local in summer; EST is the choice that makes the drift always later, never earlier
 * into the morning.
 *
 * THE MONITORING CRON IS UTC-AGNOSTIC: every 30 minutes is every 30 minutes everywhere. The
 * two collide once a day at 17:00, which the spec's expressions make unavoidable and which
 * docs/phase-3e-monitoring.md names rather than hides.
 */

import type { CleanupParams } from "./runCleanup";
import type { MonitorParams } from "./runMonitor";

export const CLEANUP_CRON = "0 17 * * *";
export const MONITOR_CRON = "*/30 * * * *";

export interface ScheduledEnvironment {
  DB: D1Database;
  CLEANUP_WORKFLOW: Workflow<CleanupParams>;
  MONITOR_WORKFLOW: Workflow<MonitorParams>;
}

export const handleScheduled = async (
  controller: ScheduledController,
  environment: ScheduledEnvironment,
): Promise<{ started: string | null }> => {
  // scheduledTime is MILLISECONDS; `now` is seconds. Getting this wrong makes cleanup's cutoff
  // `now_ms - 604800`, which is still in the future by every row's reckoning, so the first run
  // would delete the entire table -- and it makes monitoring's `now` fail its own epoch-seconds
  // band, which is the loud failure of the two.
  const now = Math.floor(controller.scheduledTime / 1000);

  // MATCHED EXPLICITLY, never assumed and never defaulted. The two payloads are byte-identical
  // `{ now }`, so routing is discriminated ONLY by which binding's `create` was called: a
  // crossed pair would run cleanup 48 times a day, or monitoring once, with nothing to notice.
  if (controller.cron === CLEANUP_CRON) {
    const instance = await environment.CLEANUP_WORKFLOW.create({ params: { now } });
    return { started: instance.id };
  }
  if (controller.cron === MONITOR_CRON) {
    const instance = await environment.MONITOR_WORKFLOW.create({ params: { now } });
    return { started: instance.id };
  }
  return { started: null };
};
