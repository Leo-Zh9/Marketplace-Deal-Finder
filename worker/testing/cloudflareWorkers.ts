/**
 * Node-side stub for the workerd-only `cloudflare:workers` module, wired in by
 * `test.alias` in vite.config.ts and nowhere else -- the frontend build, `tsc` and eslint
 * never see it.
 *
 * It exists because wrangler requires a Workflow class to be exported from the MAIN ENTRY,
 * and `worker/index.test.ts` imports that entry in a Node environment. Without the alias
 * every test that touches `worker/index.ts` dies with
 * `Cannot find package 'cloudflare:workers'`.
 *
 * It is a base class with no behaviour, and that is deliberate: `cleanupWorkflow.ts` holds
 * no logic, so nothing a Node test can reach runs against this stub instead of the real
 * runtime. The real class is exercised inside workerd by cleanupWorkflow.test.ts.
 */
export class WorkflowEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
