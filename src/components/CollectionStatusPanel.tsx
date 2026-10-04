import type { CollectionStatus } from "../types";

/**
 * THE COLLECTOR'S STATUS, ON THE PAGE. THE USER'S CHOSEN NOTIFICATION CHANNEL IS "JUST THE WEB
 * PAGE" -- no email, no push -- SO THIS PANEL IS THE ALERT, not a convenience beside one.
 *
 * READ THE HISTORY BEFORE CHANGING ANYTHING HERE. A monitoring panel was deleted from this app
 * WHOLESALE, and the reason was not the panel: NOTHING WROTE THE VALUE IT DISPLAYED. The
 * Start/Stop buttons that were its only writers were a fiction -- the browser never started
 * collection, a launchd cron does -- so once they went, the panel could answer exactly one thing
 * forever: "Not running / Stopped / Next scan --", beside a sentence promising a 30-minute
 * collector. A widget that can only say "no" to "is anything collecting?" is a worse lie than the
 * buttons were.
 *
 * SO THE TWO RULES THIS FILE EXISTS UNDER, both structural rather than careful:
 *
 *   1. THE WRITER AND THE READER SHIP IN THE SAME COMMIT. `collector/runTargets.ts` posts one
 *      health report per run line, through `POST /api/collector-health`, into a singleton D1 row,
 *      which `GET /api/status` serves. There is no state here the collector does not write.
 *   2. NOTHING IS RENDERED THAT THE WRITER DOES NOT WRITE. With `collector: null` -- nothing has
 *      ever reported -- this panel says SO, in words. It never says "Stopped", which is the
 *      string the old panel was deleted for. P-4 is the guard and its mutation is rendering it.
 *
 * THE HEADLINE IS THE TIMESTAMP, NOT THE WORD. The 45-minute staleness bound was measured across
 * a 12 h 46 m closed lid on AC -- 26 of 26 expected runs fired, max gap 30.1 min -- so `stale` is
 * a real signal and not an everyday nuisance; but the untested case is a lid closed ON BATTERY,
 * where launchd coalesces the missed windows. Leading with "last reported 14:38, 12 minutes ago"
 * means the user can judge that case themselves whatever word the badge carries.
 */

/**
 * THE ONE NUMBER THE PANEL NEEDS AND THE WIRE DOES NOT CARRY.
 *
 * WHY IT IS NOT ON THE WIRE. The run line deliberately has NO `ran` field and no `attempted`
 * field -- `collector/runTargets.ts`'s docstring forbids adding one, because it would make "how
 * many ran" the headline number and invite a later edit to redefine `targets` to match, which is
 * exactly the redefinition that makes a dropped target unrepresentable. So the page derives the
 * "2 of 9" sentence from `targets` (which IS on the wire) and this constant.
 *
 * WHY IT IS DUPLICATED RATHER THAN IMPORTED. `collector/runState.ts` is the authority and holds
 * the derivation; it cannot be imported here, because `tsconfig.collector.json` compiles the
 * collector with `.ts`-extension imports and Node types and `tsconfig.app.json` compiles this
 * with neither -- the same wall that keeps `worker/storage/schema.test.ts` from importing
 * `parseMarket` (see S7c's note). THE DUPLICATION IS THEREFORE STATED, NOT HIDDEN: if the
 * collector's CANARY_TARGETS changes, this changes with it, and the panel's sentence is the only
 * thing that would be wrong.
 *
 * IT IS NOT EXPORTED, and that is deliberate rather than incidental: this file's only export is
 * the component, so `react-refresh/only-export-components` has nothing to complain about and
 * the slice adds no tenth file to a frozen nine-file list. Both values are reached only through
 * rendering, which is how the panel's own suite asserts them.
 */
const CANARY_TARGETS = 2;

/**
 * EVERY CAUSE THE SERVER CAN SEND, IN THE USER'S WORDS. The server sends machine strings
 * (`exit-code:6`, `feed-overlap:a+b`) and this is the only place they become English.
 *
 * THE DEFAULT IS THE RAW STRING, NEVER SILENCE. A cause this function does not recognise is a
 * cause a newer collector added, and showing `whatever-it-said` is strictly better than showing
 * "Degraded" with no reason -- which is precisely the failure mode the deleted panel had. P-3
 * and P-7 are the guards: a bare "Degraded" with no cause fails both.
 */
const describeCause = (cause: string): string => {
  if (cause === "dry-run") {
    return "COLLECTOR_DRY_RUN is set, so the collector is searching and storing nothing.";
  }
  if (cause === "fixture") {
    return "COLLECTOR_HTML_FILE is set, so the collector is reading a saved page instead of Facebook.";
  }
  if (cause === "incomplete") return "Not every search finished.";
  if (cause === "canary") return "A guard is latched, so only some of your searches ran.";
  if (cause === "canary-expired") {
    return "The reduced schedule ran its course, so this run searched everything once to re-measure.";
  }
  if (cause === "alarms-unreadable") {
    return "The stored alarm list could not be read, so there may be an alarm this page is not showing.";
  }
  if (cause === "guard-blind") {
    return "The collector could not save its own guard state, so the next run will not remember this one.";
  }

  const colon = cause.indexOf(":");
  const kind = colon === -1 ? cause : cause.slice(0, colon);
  const rest = colon === -1 ? "" : cause.slice(colon + 1);

  if (kind === "exit-code") return `The last run exited ${rest}.`;
  if (kind === "source-empty") {
    return `“${rest}” has come back with no results several runs in a row. Facebook may have changed the page.`;
  }
  if (kind === "transient") return `“${rest}” has failed several runs in a row.`;
  if (kind === "refused") {
    return `Facebook refused “${rest}”. The collector has cut back and will not speed up on its own.`;
  }
  if (kind === "feed-overlap") {
    const [a, b] = rest.split("+");
    return `“${a}” and “${b}” returned the same listings, which means a generic feed rather than two searches.`;
  }

  return cause;
};

const BADGE_WORDS: Record<CollectionStatus["status"], string> = {
  ok: "Collecting",
  stale: "No recent run",
  degraded: "Degraded",
  unknown: "Unknown",
};

/** "14:38" in the viewer's own zone, from unix SECONDS. */
const clockTime = (reportedAt: number): string =>
  new Date(reportedAt * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

const agePhrase = (ageMinutes: number): string => {
  if (ageMinutes <= 0) return "just now";
  if (ageMinutes === 1) return "1 minute ago";
  if (ageMinutes < 90) return `${ageMinutes} minutes ago`;
  return `${Math.round(ageMinutes / 60)} hours ago`;
};

export interface CollectionStatusPanelProps {
  /** `null` means the read itself failed or has not finished. */
  status: CollectionStatus | null;
  pending: boolean;
}

export function CollectionStatusPanel({ status, pending }: CollectionStatusPanelProps) {
  return (
    <section className="collection-panel" aria-labelledby="collection-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Collection</p>
          <h2 id="collection-heading">Is anything collecting?</h2>
        </div>
      </div>

      {status === null ? (
        <p className="muted-copy">
          {pending
            ? "Reading the collector’s status…"
            : "The collector’s status could not be read. The searches above are unaffected."}
        </p>
      ) : (
        <>
          <div className="collection-status">
            <span className={`collection-badge collection-badge--${status.status}`}>
              {BADGE_WORDS[status.status]}
            </span>
            {/*
              * THE TIMESTAMP IS THE HEADLINE AND IT IS RENDERED BEFORE ANY CAUSE. P-1's mutation
              * is rendering the badge alone, whose failure shape is a page that says "Degraded"
              * with no way to tell a run from five minutes ago from one from last Tuesday.
              */}
            {status.collector === null ? (
              <p className="collection-timestamp">No collector run has reported yet.</p>
            ) : (
              <p className="collection-timestamp">
                Last reported {clockTime(status.reportedAt)}, {agePhrase(status.ageMinutes)}.
              </p>
            )}
          </div>

          {status.causes.length > 0 && (
            <ul className="collection-causes">
              {status.causes.map((cause) => (
                <li key={cause}>{describeCause(cause)}</li>
              ))}
            </ul>
          )}

          {/*
            * THE COUNTS COME FROM THE WIRE, NEVER FROM A LITERAL "9". P-8's mutation is
            * hardcoding "all 9 searches", whose failure shape is a three-target watch list
            * reading "instead of all 9" -- a number the user never configured, on the one panel
            * they are meant to trust about what is running.
            *
            * IT IS RENDERED ONLY WHEN THE CUT IS ACTUALLY ENGAGED. An alarm can be latched while
            * the run was FULL (the bounded expiry does exactly that once a day), and claiming a
            * reduction that did not happen is the same class of lie as the deleted panel's.
            */}
          {status.collector?.canary === true && (
            <p className="collection-reduced">
              Collection is reduced to {CANARY_TARGETS} of {status.collector.targets} searches per
              run while this is unresolved. It will go back on its own once the cause measures
              clean.
            </p>
          )}
        </>
      )}
    </section>
  );
}
