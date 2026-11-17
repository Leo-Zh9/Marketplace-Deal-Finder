import { MAX_WATCH_TARGETS } from "./validation";

/**
 * The 409 WATCH_BUDGET_FULL sentence. The numbers come from the Worker; a missing one is left out
 * rather than guessed.
 */
export const budgetFullMessage = (details: Record<string, unknown>): string => {
  const used = typeof details.used === "number" ? details.used : null;
  const maximum = typeof details.maximum === "number" ? details.maximum : MAX_WATCH_TARGETS;
  const yours = typeof details.yours === "number" ? details.yours : null;
  const head =
    used === null
      ? `All ${maximum} shared searches are in use`
      : `${used} of ${maximum} shared searches in use${yours === null ? "" : ` (${yours} yours)`}`;
  return `${head}. Nothing was saved: remove one of your searches, or search an area someone else already searches, and save again.`;
};
