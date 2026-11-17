import type { CollectionStatus, NotificationCounts } from "../types";

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
 * WHAT EACH EXIT CODE MEANS, in the words of `collector/run.ts`'s table, so the panel says who must
 * act rather than a bare number. An unlisted code falls back to "The last run exited N.", because
 * a newer collector may exit with a code this page has never heard of. P-7.
 *
 * THE CODE IS THE RUN'S WORST ACROSS ALL TARGETS (`worstExitCode`, collector/runTargets.ts), so
 * every sentence must stay true in a MIXED run: one search's 4 does not mean nothing was saved.
 * 5 and 6 can also come from the collector's own watch-list read, before any search ran, so they
 * name "a call to the server" / "a request", not only a search or an upload. A missing env
 * variable never reaches here -- it exits before any health report -- so 2 is a bad setting or
 * search entry inside the run.
 */
const EXIT_WORDS: Record<string, string> = {
  "2": "A search could not be run because of a bad setting or search entry. Someone needs to look.",
  "3": "A search came back empty.",
  "4": "A search’s page changed shape, so that search saved nothing. Someone needs to look.",
  "5": "A search, or a call to the server, failed. The next run will retry; if this keeps showing, the server may be down.",
  "6": "The server refused a request from the collector, or could not save some listings. Someone needs to look.",
};

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
  if (cause === "status-unreadable") return "The collector’s status could not be read.";

  const colon = cause.indexOf(":");
  const kind = colon === -1 ? cause : cause.slice(0, colon);
  const rest = colon === -1 ? "" : cause.slice(colon + 1);

  if (kind === "exit-code") return EXIT_WORDS[rest] ?? `The last run exited ${rest}.`;
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
  // THE OPERATOR'S OWN STOP, and it has a writer: `POST /api/monitoring/stop` sets the row the
  // collector and the monitoring runs both honour. That is what makes it different from the
  // deleted panel's "Stopped", which nothing wrote (P-4 still guards that case).
  stopped: "Stopped",
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

/**
 * THE COUNTS, for `on` and `webhook-rejected` only. `sent24h` is a ROLLING 24-hour window
 * (worker/notify/status.ts), so the sentence says "in the last 24 hours", never "today".
 * `pending` and `failed` appear only when non-zero: without them a sender that has stalled
 * (rows piling up PENDING) or is being refused (FAILED) reads exactly like a quiet day.
 */
const countsPhrase = (counts: NotificationCounts): string => {
  let phrase = `${counts.sent24h} sent in the last 24 hours, ${counts.deliveryUnknown} delivery unknown`;
  if (counts.pending > 0) phrase += `, ${counts.pending} pending`;
  if (counts.failed > 0) phrase += `, ${counts.failed} failed`;
  return phrase;
};

/**
 * THE DISCORD ALERT LINE, ONE SENTENCE PER STATE. The counts are built INSIDE the two branches
 * that show them, never before the switch: review D found that a count built up front threw for
 * an inert state carrying an unprintable value, and the TypeError unmounted the app. The client
 * rebuilds the field as well (`marketplaceClient.ts`); this is the second half.
 */
const alertLine = (notifications: NonNullable<CollectionStatus["notifications"]>): string => {
  switch (notifications.state) {
    case "unconfigured":
      return "Discord alerts: not configured";
    case "invalid-url":
      return "Discord alerts: webhook URL invalid";
    case "off":
      return "Discord alerts: off (webhook ready)";
    case "on":
      return "sent24h" in notifications
        ? `Discord alerts: on, ${countsPhrase(notifications)}`
        : "Discord alerts: on (counts unavailable)";
    case "webhook-rejected":
      return "sent24h" in notifications
        ? `Discord alerts: webhook rejected, replace the secret. ${countsPhrase(notifications)}`
        : "Discord alerts: webhook rejected, replace the secret";
    case "unreadable":
      return "Discord alerts: status unreadable";
  }
};

export interface MonitoringNotice {
  /** `status` for a confirmation, `alert` for a refusal or a failure. */
  kind: "status" | "alert";
  text: string;
}

export interface CollectionStatusPanelProps {
  /** `null` means the read itself failed or has not finished. */
  status: CollectionStatus | null;
  pending: boolean;
  /** Start/Stop. With no handler the button is not rendered. */
  onToggleMonitoring?: (next: "start" | "stop") => void;
  /** A Start/Stop request is in flight: the button is disabled and its label is unchanged. */
  monitoringPending?: boolean;
  monitoringNotice?: MonitoringNotice | null;
}

export function CollectionStatusPanel({
  status,
  pending,
  onToggleMonitoring,
  monitoringPending = false,
  monitoringNotice = null,
}: CollectionStatusPanelProps) {
  /**
   * THE LABEL COMES FROM THE SERVER'S ROW AND NOTHING ELSE. No optimistic flip: a Stop that failed
   * must not leave a "Start monitoring" button over a collector that is still running. With no
   * `monitoring` on the wire (an older Worker, or a read the Worker could not make) there is no
   * button, because there is no true label for it.
   */
  const monitoring = status?.monitoring ?? null;
  const running = monitoring?.state === "running";

  return (
    <section className="collection-panel" aria-labelledby="collection-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Collection</p>
          <h2 id="collection-heading">Is anything collecting?</h2>
        </div>
        {monitoring !== null && onToggleMonitoring !== undefined && (
          <button
            className={running ? "secondary-button" : "primary-button"}
            disabled={monitoringPending}
            type="button"
            onClick={() => onToggleMonitoring(running ? "stop" : "start")}
          >
            {running ? "Stop monitoring" : "Start monitoring"}
          </button>
        )}
      </div>

      {/*
        * TWO LIVE REGIONS, MOUNTED WITH THE BUTTON AND BEFORE ANY CLICK, AND ONLY THEIR TEXT
        * CHANGES. A region inserted together with its text is often not announced at all, because
        * the screen reader starts watching it after the change. A refusal goes in the alert region,
        * a confirmation in the polite one. With no button there is nothing to announce, so no
        * regions either -- and the page's other alert/status regions stay the only ones.
        */}
      {monitoring !== null && onToggleMonitoring !== undefined && (
        <>
          <p className="collection-notice" role="alert">
            {monitoringNotice?.kind === "alert" ? monitoringNotice.text : ""}
          </p>
          <p className="collection-notice" role="status">
            {monitoringNotice?.kind === "status" ? monitoringNotice.text : ""}
          </p>
        </>
      )}

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
            {/*
              * "NEVER REPORTED" ONLY WHEN THE SERVER COULD LOOK. A `status-unreadable` cause means
              * the row could not be read at all, and saying no run has reported would be false;
              * the cause list below says what is true instead. P-13.
              */}
            {status.collector === null ? (
              status.causes.includes("status-unreadable") ? null : (
                <p className="collection-timestamp">No collector run has reported yet.</p>
              )
            ) : (
              <p className="collection-timestamp">
                Last reported {clockTime(status.reportedAt)}, {agePhrase(status.ageMinutes)}.
              </p>
            )}
          </div>

          {monitoring?.state === "stopped" && (
            <p className="collection-stopped">
              Stopped at {clockTime(monitoring.changedAt)}. The collector skips its runs and no
              alerts are sent until you start it.
            </p>
          )}

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
          {/*
            * NOT WHILE STOPPED: nothing runs, so "reduced to 2 of 9 per run" describes runs that
            * are not happening.
            */}
          {status.collector?.canary === true && status.status !== "stopped" && (
            <p className="collection-reduced">
              Collection is reduced to {CANARY_TARGETS} of {status.collector.targets} searches per
              run while this is unresolved. It will go back on its own once the cause measures
              clean.
            </p>
          )}

          {/*
            * ABSENT MEANS AN API WORKER OLDER THAN THE NOTIFICATIONS BACKEND, AND IT RENDERS
            * NOTHING. Saying "not configured" there would be a claim the Worker never made.
            */}
          {status.notifications !== undefined && (
            <p className="collection-alerts">{alertLine(status.notifications)}</p>
          )}
        </>
      )}
    </section>
  );
}
