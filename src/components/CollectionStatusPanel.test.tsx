import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionStatusPanel } from "./CollectionStatusPanel";
import type { CollectionStatus } from "../types";

/**
 * EVERY ROW HERE IS ABOUT ONE QUESTION: can this panel say something the collector did not
 * report, or stay silent about something it did?
 *
 * The app deleted its predecessor because nothing wrote the value it displayed, so the panel that
 * replaces it is tested from the wire inwards: each row builds the body `GET /api/status` really
 * answers and asserts what the user reads.
 */

const reportedAt = 1_800_000_000;

const status = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  status: "ok",
  causes: [],
  reportedAt,
  ageMinutes: 12,
  collector: {
    exitCode: 0,
    complete: true,
    canary: false,
    dryRun: false,
    fixture: false,
    targets: 9,
    alarms: [],
  },
  ...over,
});

/** The clock string the panel will render, computed the same way it does, in the test's zone. */
const expectedClock = new Date(reportedAt * 1000).toLocaleTimeString(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

describe("the collection status panel", () => {
  /**
   * P-1: `ok` RENDERS THE BADGE **AND** THE TIMESTAMP AND THE RELATIVE AGE.
   *
   * THE MUTATION IS RENDERING THE BADGE ALONE, whose failure shape is a page that says
   * "Collecting" with no way to tell a run from twelve minutes ago from one from last Tuesday.
   * The timestamp is the HEADLINE deliberately: the 45-minute staleness bound survived a 12 h
   * 46 m closed lid on AC in testing (26 of 26 expected runs fired, max gap 30.1 min), but the
   * untested case is a lid closed ON BATTERY, where launchd coalesces the missed windows -- so
   * the user has to be able to judge that case themselves whatever word the badge carries.
   */
  it("P-1: ok shows the badge, the clock time and the relative age", () => {
    render(<CollectionStatusPanel status={status()} pending={false} />);

    expect(screen.getByText("Collecting")).toBeInTheDocument();
    expect(
      screen.getByText(`Last reported ${expectedClock}, 12 minutes ago.`),
    ).toBeInTheDocument();
  });

  it("P-1b: the four badge words are distinct and none of them is an error", () => {
    for (const [state, word] of [
      ["ok", "Collecting"],
      ["stale", "No recent run"],
      ["degraded", "Degraded"],
      ["unknown", "Unknown"],
    ] as const) {
      const { unmount } = render(
        <CollectionStatusPanel status={status({ status: state })} pending={false} />,
      );
      expect(screen.getByText(word)).toBeInTheDocument();
      unmount();
    }
  });

  /**
   * P-2: A FEED ALARM NAMES BOTH TARGETS AND THE REDUCED COUNT.
   *
   * THE MUTATION IS RENDERING `alarms.length` -- "1 alarm" -- which is the shortest thing that
   * looks like it works and tells the operator nothing they can act on. The pair's NAMES are
   * what sends them to the two searches that are returning the same page.
   *
   * THE COUNT IS THE OTHER HALF AND IT COMES FROM THE WIRE. `targets` is the count the SERVER
   * returned, so a 3-target watch list reads "2 of 3" -- see P-8.
   */
  it("P-2: a feed alarm names both targets and the reduced coverage", () => {
    render(
      <CollectionStatusPanel
        status={status({
          status: "degraded",
          causes: ["canary", "feed-overlap:gpu-radeon+gpu-rtx"],
          collector: { ...status().collector!, complete: false, canary: true },
        })}
        pending={false}
      />,
    );

    const cause = screen.getByText(/returned the same listings/);
    expect(cause).toHaveTextContent("gpu-radeon");
    expect(cause).toHaveTextContent("gpu-rtx");
    expect(screen.getByText(/reduced to 2 of 9 searches per run/)).toBeInTheDocument();
  });

  /**
   * P-3: `degraded` WITH `dryRun` NAMES THE DRY RUN. INVARIANT 3, ON THE PAGE.
   *
   * THE MUTATION IS DROPPING THE BRANCH, which leaves a bare "Degraded" with no cause -- exactly
   * the deleted panel's failure mode, a widget that says something is wrong and cannot say what.
   * And the variable's NAME is in the sentence on purpose: `COLLECTOR_DRY_RUN` is the thing the
   * operator has to unset, and it is in a launchd environment file they will not think to open.
   */
  it("P-3: a dry run names COLLECTOR_DRY_RUN", () => {
    render(
      <CollectionStatusPanel
        status={status({
          status: "degraded",
          causes: ["dry-run"],
          collector: { ...status().collector!, dryRun: true },
        })}
        pending={false}
      />,
    );

    expect(screen.getByText(/COLLECTOR_DRY_RUN is set/)).toBeInTheDocument();
    expect(screen.getByText(/storing nothing/)).toBeInTheDocument();
  });

  it("P-3b: a fixture run names COLLECTOR_HTML_FILE", () => {
    render(
      <CollectionStatusPanel
        status={status({
          status: "degraded",
          causes: ["fixture"],
          collector: { ...status().collector!, fixture: true },
        })}
        pending={false}
      />,
    );

    expect(screen.getByText(/COLLECTOR_HTML_FILE is set/)).toBeInTheDocument();
  });

  /**
   * P-7: `degraded` WITH A NON-ZERO EXIT NAMES THE CODE.
   *
   * THE MUTATION IS DROPPING THE BRANCH, and this is the one case a persistent-exit-6 deploy
   * produces: every run punctual, every run exiting 6, NOTHING stored. The exit code is what
   * sends the operator to `collector/run.ts`'s table, which says who must act for each number.
   */
  it.each<[number, string]>([
    [2, "The last run exited 2."],
    [3, "The last run exited 3."],
    [6, "The last run exited 6."],
  ])("P-7: exit code %i is named in words", (exitCode, sentence) => {
    render(
      <CollectionStatusPanel
        status={status({
          status: "degraded",
          causes: [`exit-code:${exitCode}`],
          collector: { ...status().collector!, exitCode },
        })}
        pending={false}
      />,
    );

    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  /**
   * P-8: THE REDUCED-COVERAGE SENTENCE IS DERIVED FROM THE REPORTED COUNTS, NEVER FROM A LITERAL.
   *
   * THE MUTATION IS HARDCODING "all 9 searches", whose failure shape is a THREE-target watch list
   * reading "instead of all 9" -- a number the user never configured, on the one panel they are
   * meant to trust about what is running. Nine is production's count today and the cap, which is
   * exactly why it is the tempting literal.
   *
   * THE NUMERATOR IS A LITERAL CONSTANT AND THAT IS ONLY HONEST BECAUSE OF A PROPERTY PROVED
   * ELSEWHERE. This panel renders `CANARY_TARGETS` against a `targets` count from the wire, so it
   * is right only if the collector really runs `CANARY_TARGETS` whenever it reports `canary:true`.
   * It did NOT before the probe top-up -- a single-target cause produced a ONE-target probe while
   * the page said two -- and `collector/runState.test.ts` G-22e now asserts
   * `indices.length === CANARY_TARGETS` over every watch-list size from 1 to 9 and four cause
   * shapes. The alternative was putting the real count on the wire, which R4 forbids: no `ran`
   * field, on the line or over HTTP.
   */
  it("P-8: a three-target watch list reads 2 of 3, not 2 of 9", () => {
    render(
      <CollectionStatusPanel
        status={status({
          status: "degraded",
          causes: ["canary", "source-empty:a-target"],
          collector: { ...status().collector!, complete: false, canary: true, targets: 3 },
        })}
        pending={false}
      />,
    );

    expect(screen.getByText(/reduced to 2 of 3 searches per run/)).toBeInTheDocument();
    expect(screen.queryByText(/of 9/)).not.toBeInTheDocument();
  });

  /**
   * P-8b: AN ALARM WITH NO CUT ENGAGED CLAIMS NO REDUCTION. The bounded expiry produces exactly
   * this once a day: the cause is still latched and the run was FULL. Claiming a reduction that
   * did not happen is the same class of lie as the deleted panel's.
   */
  it("P-8b: a latched cause on a FULL run shows no reduction sentence", () => {
    render(
      <CollectionStatusPanel
        status={status({
          status: "degraded",
          causes: ["canary-expired", "source-empty:a-target"],
          collector: { ...status().collector!, canary: false },
        })}
        pending={false}
      />,
    );

    expect(screen.queryByText(/reduced to/)).not.toBeInTheDocument();
    expect(screen.getByText(/searched everything once to re-measure/)).toBeInTheDocument();
  });

  /**
   * P-4: NOTHING REPORTED YET SAYS SO, IN WORDS. IT NEVER SAYS "Stopped".
   *
   * THE MUTATION IS RENDERING "Stopped", AND THAT STRING IS WHAT THE OLD PANEL WAS DELETED FOR:
   * it read "Not running / Stopped / Next scan --" FOREVER, because nothing wrote the value it
   * displayed, beside a line promising a 30-minute collector. The assertion is on the absence of
   * that exact word as well as the presence of the sentence, because a panel that renders both
   * would pass a presence-only test.
   */
  it("P-4: collector null says no run has reported yet, and never Stopped", () => {
    render(
      <CollectionStatusPanel
        status={status({ status: "unknown", causes: [], reportedAt: 0, ageMinutes: 0, collector: null })}
        pending={false}
      />,
    );

    expect(screen.getByText("No collector run has reported yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not running/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Next scan/)).not.toBeInTheDocument();
  });

  /**
   * P-9: A READ THAT FAILED SAYS SO, AND SAYS THE SEARCHES ARE UNAFFECTED.
   *
   * The second half matters because of what the page's OTHER failed read means: a failed
   * `GET /api/watch` disables Save, for a measured reason. A user who reads "could not be read"
   * here and assumes the same thing would stop saving searches over a badge.
   */
  it("P-9: a failed read says so, and says the searches are unaffected", () => {
    render(<CollectionStatusPanel status={null} pending={false} />);

    expect(screen.getByText(/status could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/searches above are unaffected/)).toBeInTheDocument();
  });

  it("P-9b: before the read resolves it says it is reading, not that it failed", () => {
    render(<CollectionStatusPanel status={null} pending={true} />);

    expect(screen.getByText(/Reading the collector/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });

  /**
   * P-10: AN UNRECOGNISED CAUSE IS SHOWN VERBATIM, NOT SWALLOWED.
   *
   * A cause this build does not know is a cause a NEWER collector added -- the two halves deploy
   * separately, the collector on a laptop and the Worker on Cloudflare. Showing the raw string is
   * strictly better than showing "Degraded" with nothing under it, which is the deleted panel's
   * failure mode reached by a different road.
   */
  it("P-10: a cause this build does not know is rendered as-is", () => {
    render(
      <CollectionStatusPanel
        status={status({ status: "degraded", causes: ["something-new:42"] })}
        pending={false}
      />,
    );

    expect(screen.getByText("something-new:42")).toBeInTheDocument();
  });

  /**
   * P-12: EVERY CAUSE KIND THE SERVER CAN SEND HAS ENGLISH, AND THIS TABLE EXISTS BECAUSE FIVE
   * MUTATIONS SURVIVED WITHOUT IT.
   *
   * Deleting the `transient`, `refused`, `source-empty`, `guard-blind` or `incomplete`/`canary`
   * branch left the whole panel suite GREEN -- because each one falls through to the raw-string
   * default, so the page still renders something and only a test that asserts the ENGLISH can
   * see the difference. The page is the user's ONLY notification channel: a badge reading
   * "Degraded" over the literal `transient:gpu-rtx` is the deleted panel's failure mode wearing
   * a machine string.
   *
   * THE TARGET NAME IS ASSERTED ON EVERY PER-TARGET CAUSE, because the name is the actionable
   * part -- it is which of the user's nine searches to go and look at.
   */
  it.each<[string, RegExp, string | null]>([
    ["dry-run", /COLLECTOR_DRY_RUN is set/, null],
    ["fixture", /COLLECTOR_HTML_FILE is set/, null],
    ["incomplete", /Not every search finished/, null],
    ["canary", /only some of your searches ran/, null],
    ["canary-expired", /searched everything once to re-measure/, null],
    ["guard-blind", /could not save its own guard state/, null],
    ["alarms-unreadable", /stored alarm list could not be read/, null],
    ["exit-code:4", /The last run exited 4\./, null],
    ["source-empty:mobo-toronto", /no results several runs in a row/, "mobo-toronto"],
    ["transient:gpu-rtx", /has failed several runs in a row/, "gpu-rtx"],
    ["refused:storage-ssd", /Facebook refused/, "storage-ssd"],
    ["feed-overlap:cpu-ryzen+cpu-toronto", /returned the same listings/, "cpu-ryzen"],
  ])("P-12: the cause %s is rendered in English", (cause, sentence, named) => {
    render(
      <CollectionStatusPanel
        status={status({ status: "degraded", causes: [cause] })}
        pending={false}
      />,
    );

    const rendered = screen.getByText(sentence);
    expect(rendered).toBeInTheDocument();
    if (named !== null) expect(rendered).toHaveTextContent(named);
    // ...and the RAW machine string is never what the user reads.
    expect(screen.queryByText(cause)).not.toBeInTheDocument();
  });

  /**
   * P-11: THE AGE PHRASING, ACROSS ALL FOUR BRANCHES. The 0 and 1 rows were added because
   * deleting the "just now" branch survived: with only the 12-minute and 400-minute rows, a run
   * reported seconds ago read "0 minutes ago", which is not wrong enough to notice and not right.
   */
  it.each<[number, RegExp]>([
    [0, /just now/],
    [1, /1 minute ago\./],
    [12, /12 minutes ago\./],
    [89, /89 minutes ago\./],
    [400, /7 hours ago/],
  ])("P-11: an age of %i minutes reads correctly", (ageMinutes, phrase) => {
    render(
      <CollectionStatusPanel status={status({ ageMinutes })} pending={false} />,
    );

    expect(screen.getByText(phrase)).toBeInTheDocument();
  });
});

/**
 * THE DISCORD ALERT LINE. Each row builds the `notifications` value the client hands the panel
 * and asserts the exact sentence the user reads.
 */
describe("the Discord alert line", () => {
  // `pending` and `failed` are 0 here, so the N-1 sentences are the quiet-day ones. N-4 sets them.
  const COUNTS = { pending: 0, sent24h: 3, deliveryUnknown: 1, failed: 0, lastSentAt: 1_800_000_000 };

  /**
   * N-1: EVERY STATE HAS ITS OWN SENTENCE. The mutation is collapsing any one branch -- the
   * likeliest is a default that reads every unknown as "not configured" -- and the row for that
   * state fails on its exact text. `off` is the label docs/phase-4-notifications.md promises the
   * user after `secret put`.
   */
  it.each<[string, NonNullable<CollectionStatus["notifications"]>, string]>([
    ["unconfigured", { state: "unconfigured" }, "Discord alerts: not configured"],
    ["invalid-url", { state: "invalid-url" }, "Discord alerts: webhook URL invalid"],
    ["off", { state: "off" }, "Discord alerts: off (webhook ready)"],
    ["on", { state: "on", ...COUNTS }, "Discord alerts: on, 3 sent in the last 24 hours, 1 delivery unknown"],
    [
      "webhook-rejected",
      { state: "webhook-rejected", ...COUNTS },
      "Discord alerts: webhook rejected, replace the secret. 3 sent in the last 24 hours, 1 delivery unknown",
    ],
    // The Worker's own answer when its table read fails: on, with no counts to show.
    ["on, counts unavailable", { state: "on" }, "Discord alerts: on (counts unavailable)"],
    ["unreadable", { state: "unreadable" }, "Discord alerts: status unreadable"],
  ])("N-1: %s reads as its own sentence", (_state, notifications, sentence) => {
    render(<CollectionStatusPanel status={status({ notifications })} pending={false} />);

    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  /**
   * N-2: ABSENT RENDERS NO LINE, AND THE REST OF THE PANEL IS UNTOUCHED. An API Worker older
   * than the notifications backend sends no field. The mutation is rendering a sentence for it
   * ("not configured", or "unreadable"): a claim that Worker never made.
   */
  it("N-2: an absent field renders no alert line, and the badge and timestamp still render", () => {
    render(<CollectionStatusPanel status={status()} pending={false} />);

    expect(screen.queryByText(/Discord alerts/)).not.toBeInTheDocument();
    expect(screen.getByText("Collecting")).toBeInTheDocument();
    expect(screen.getByText(`Last reported ${expectedClock}, 12 minutes ago.`)).toBeInTheDocument();
  });

  /**
   * N-3: COUNTS ONLY FOR `on` AND `webhook-rejected`. The Worker sends counts for no other state;
   * the mutation is rendering them whenever they are present, and an inert state that arrived
   * with counts attached would then report sends from a switch that is off.
   */
  it.each([["unconfigured"], ["invalid-url"], ["off"]] as const)(
    "N-3: %s with counts attached still reads as its state alone",
    (state) => {
      const notifications = { state, ...COUNTS } as unknown as CollectionStatus["notifications"];
      render(<CollectionStatusPanel status={status({ notifications })} pending={false} />);

      expect(screen.getByText(/^Discord alerts: /)).not.toHaveTextContent(/sent|delivery/);
    },
  );

  /**
   * N-4: `pending` AND `failed` SHOW WHEN NON-ZERO, ON BOTH COUNTED STATES. Review D: without
   * them a sender that has stalled (rows piling up PENDING) or is being refused (FAILED) reads
   * exactly like a quiet day. The mutations are dropping either phrase, which fails its own rows,
   * and showing either at zero, which fails the both-zero row.
   */
  it.each<[string, NonNullable<CollectionStatus["notifications"]>, string]>([
    // 1, NOT A LARGER NUMBER, in the two single-count rows: the first pending or failed alert must
    // show, so a threshold mutated from `> 0` to `> 1` has to fail here.
    ["on, pending only", { state: "on", ...COUNTS, pending: 1 }, "Discord alerts: on, 3 sent in the last 24 hours, 1 delivery unknown, 1 pending"],
    ["on, failed only", { state: "on", ...COUNTS, failed: 1 }, "Discord alerts: on, 3 sent in the last 24 hours, 1 delivery unknown, 1 failed"],
    ["on, both", { state: "on", ...COUNTS, pending: 2, failed: 4 }, "Discord alerts: on, 3 sent in the last 24 hours, 1 delivery unknown, 2 pending, 4 failed"],
    ["on, both zero", { state: "on", ...COUNTS }, "Discord alerts: on, 3 sent in the last 24 hours, 1 delivery unknown"],
    [
      "webhook-rejected, pending only",
      { state: "webhook-rejected", ...COUNTS, pending: 2 },
      "Discord alerts: webhook rejected, replace the secret. 3 sent in the last 24 hours, 1 delivery unknown, 2 pending",
    ],
    [
      "webhook-rejected, failed only",
      { state: "webhook-rejected", ...COUNTS, failed: 4 },
      "Discord alerts: webhook rejected, replace the secret. 3 sent in the last 24 hours, 1 delivery unknown, 4 failed",
    ],
  ])("N-4: %s", (_label, notifications, sentence) => {
    render(<CollectionStatusPanel status={status({ notifications })} pending={false} />);

    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  /**
   * N-5: A COUNT THAT CANNOT BE PRINTED, ON A STATE THAT DOES NOT SHOW COUNTS, DOES NOT THROW.
   * Review D's body. The mutation is building the counts string before the switch: then the
   * template literal throws a TypeError for `off`, and with no error boundary the app unmounts.
   * The client rebuilds the field too (C-n4); this row is the panel's own half.
   */
  it("N-5: off carrying an unprintable count still renders its line", () => {
    const notifications = {
      state: "off",
      sent24h: { toString: null, valueOf: null },
    } as unknown as CollectionStatus["notifications"];
    render(<CollectionStatusPanel status={status({ notifications })} pending={false} />);

    expect(screen.getByText("Discord alerts: off (webhook ready)")).toBeInTheDocument();
  });
});

describe("the Start/Stop control", () => {
  const changedAt = 1_800_000_420;
  const changedClock = new Date(changedAt * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const running = status({ monitoring: { state: "running", changedAt: 0 } });
  const stopped = status({
    status: "stopped",
    causes: [],
    monitoring: { state: "stopped", changedAt },
  });

  /**
   * P-m1: STOPPED READS STOPPED, SAYS WHEN AND WHAT IT MEANS, AND OFFERS START. The timestamp line
   * stays: the user can still see when the last run was. Kills: labelling from anything but
   * `monitoring.state`, and dropping the explanatory line.
   */
  it("P-m1: stopped shows the badge, the stop time and a Start button that asks to start", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<CollectionStatusPanel status={stopped} pending={false} onToggleMonitoring={onToggle} />);

    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(
      screen.getByText(
        `Stopped at ${changedClock}. The collector skips its runs and no alerts are sent until you start it.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(`Last reported ${expectedClock}, 12 minutes ago.`)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Start monitoring" });
    expect(button).toHaveClass("primary-button");

    await user.click(button);
    expect(onToggle).toHaveBeenCalledWith("start");
  });

  it("P-m2: running offers Stop as a secondary button and shows no stopped line", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<CollectionStatusPanel status={running} pending={false} onToggleMonitoring={onToggle} />);

    const button = screen.getByRole("button", { name: "Stop monitoring" });
    expect(button).toHaveClass("secondary-button");
    expect(screen.queryByText(/Stopped at/)).not.toBeInTheDocument();
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument();

    await user.click(button);
    expect(onToggle).toHaveBeenCalledWith("stop");
  });

  /**
   * P-m3: NO FIELD, NO BUTTON. An older Worker sends none and a failed read sends null; neither
   * says which label is true. Kills: defaulting a missing field to running ("Stop monitoring"
   * over a Worker that has no Stop route).
   */
  it.each<[string, CollectionStatus]>([
    ["absent (an older Worker)", status()],
    ["null (the Worker could not read it)", status({ monitoring: null })],
  ])("P-m3: monitoring %s renders no Start/Stop button", (_label, body) => {
    render(<CollectionStatusPanel status={body} pending={false} onToggleMonitoring={vi.fn()} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("P-m4: a request in flight disables the button and leaves its label alone", () => {
    render(
      <CollectionStatusPanel
        status={running}
        pending={false}
        onToggleMonitoring={vi.fn()}
        monitoringPending
      />,
    );

    expect(screen.getByRole("button", { name: "Stop monitoring" })).toBeDisabled();
  });

  /**
   * P-m5: ONE ALERT REGION AND ONE STATUS REGION, BOTH IN THE DOCUMENT BEFORE ANY NOTICE, AND THE
   * SAME TWO NODES CARRY EVERY LATER TEXT. Kills: mounting a region together with its text (it is
   * absent before the notice, and a new node after it), which many screen readers never announce.
   */
  it("P-m5: the live regions exist before a notice, and only their text changes", () => {
    const { rerender } = render(
      <CollectionStatusPanel status={stopped} pending={false} onToggleMonitoring={vi.fn()} />,
    );
    const alertRegion = screen.getByRole("alert");
    const statusRegion = screen.getByRole("status");
    expect(alertRegion).toHaveTextContent("");
    expect(statusRegion).toHaveTextContent("");

    rerender(
      <CollectionStatusPanel
        status={stopped}
        pending={false}
        onToggleMonitoring={vi.fn()}
        monitoringNotice={{ kind: "alert", text: "Save a deal rule before starting monitoring." }}
      />,
    );
    expect(screen.getByRole("alert")).toBe(alertRegion);
    expect(alertRegion).toHaveTextContent("Save a deal rule before starting monitoring.");

    rerender(
      <CollectionStatusPanel
        status={running}
        pending={false}
        onToggleMonitoring={vi.fn()}
        monitoringNotice={{ kind: "status", text: "Started. Your collector picks this up on its next run." }}
      />,
    );
    expect(screen.getByRole("status")).toBe(statusRegion);
    expect(statusRegion).toHaveTextContent("Started. Your collector picks this up on its next run.");
    expect(alertRegion).toHaveTextContent("");
  });

  /**
   * P-m6: A STOPPED INSTALL WITH A LATCHED CANARY DOES NOT CLAIM REDUCED RUNS. Paired: the same
   * collector row while running does show the sentence. Kills: dropping the stopped guard.
   */
  it("P-m6: the reduced-coverage sentence is hidden while stopped", () => {
    const canary = { ...status().collector!, canary: true, complete: false };
    const { unmount } = render(
      <CollectionStatusPanel
        status={status({ status: "degraded", causes: ["canary"], collector: canary, monitoring: { state: "running", changedAt: 0 } })}
        pending={false}
      />,
    );
    expect(screen.getByText(/Collection is reduced to 2 of 9 searches/)).toBeInTheDocument();
    unmount();

    render(
      <CollectionStatusPanel
        status={status({ status: "stopped", causes: [], collector: canary, monitoring: { state: "stopped", changedAt } })}
        pending={false}
      />,
    );
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText(/Collection is reduced/)).not.toBeInTheDocument();
  });
});
