/**
 * The second of the two modules that import the platform at runtime, and therefore one a Node
 * test cannot import without the vitest alias in vite.config.ts.
 *
 * IT CONTAINS NO LOGIC ON PURPOSE, for the same reason `cleanupWorkflow.ts` contains none:
 * everything testable is in runMonitor.ts, so the stub the alias substitutes in Node can never
 * hide a behavioural bug -- there is no behaviour here to hide. `monitorWorkflow.test.ts`
 * drives this class for real, inside workerd, through the bundled entry.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { runMonitor, type MonitorParams, type MonitorRun } from "./runMonitor";

export interface MonitorEnvironment {
  DB: D1Database;
}

export class MonitorWorkflow extends WorkflowEntrypoint<MonitorEnvironment, MonitorParams> {
  override async run(
    event: Readonly<WorkflowEvent<MonitorParams>>,
    step: WorkflowStep,
  ): Promise<MonitorRun> {
    // No fifth argument. Production never tunes: every knob is a module constant.
    //
    // `event.instanceId` is the fencing token, and it is the platform's, not the payload's: it
    // is stable across a step retry and an instance replay -- which is exactly what makes the
    // lock re-entrant for its own run -- and a hand-written `wrangler workflows trigger` gets
    // its own fresh instance id rather than a chance to choose one.
    return runMonitor(this.env.DB, step, event.payload, event.instanceId);
  }
}
