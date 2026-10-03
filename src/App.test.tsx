import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { AuthenticatedIdentity } from "./auth/authTypes";
import { componentById } from "./data/catalog";
import type { Listing } from "./types";
import type { WatchWire, WireSettings } from "./services/marketplaceClient";

const wireListing = (over: Partial<Listing> = {}): Listing => ({
  source: "facebook-marketplace",
  listingId: "915010494744438",
  componentType: "gpu",
  modelKey: "GeForce RTX 5080",
  variantKey: null,
  title: "ASUS ROG Astral RTX 5080",
  priceCents: 300000,
  location: "Toronto, ON",
  url: "https://www.facebook.com/marketplace/item/915010494744438",
  observedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  evaluation: { status: "DEAL", averagePriceCents: 420000, discountPercent: 28.57 },
  ...over,
});

/** Explicit at every call site: each test says which identity it runs under. */
const noToken = async () => null;

const TORONTO = { slug: "toronto", latitude: 43.6532, longitude: -79.3832 };

/**
 * PRODUCTION, read with `wrangler d1 execute --remote` on 2026-10-02: nine rows, six component
 * types, nine FREE-TEXT queries this form cannot author, and the cap exactly spent. The
 * `selection` below is what `GET /api/watch` MEASURABLY answers for those rows.
 */
const LIVE_WATCH: WatchWire = {
  selection: {
    components: ["cpu", "gpu", "motherboard", "psu", "ram", "storage"],
    models: {
      cpu: { mode: "all", values: [], query: "ryzen" },
      gpu: { mode: "all", values: [], query: "radeon" },
      motherboard: { mode: "all", values: [], query: "motherboard" },
      psu: { mode: "all", values: [], query: "power supply" },
      ram: { mode: "all", values: [], query: "ddr4 ram" },
      storage: { mode: "all", values: [], query: "ssd" },
    },
    location: TORONTO,
    radiusKm: 25,
  },
  storedTargets: [
    { targetId: "cpu-ryzen", componentType: "cpu", query: "ryzen" },
    { targetId: "cpu-toronto", componentType: "cpu", query: "cpu" },
    { targetId: "gpu-radeon", componentType: "gpu", query: "radeon" },
    { targetId: "gpu-rtx", componentType: "gpu", query: "rtx" },
    { targetId: "gpu-toronto", componentType: "gpu", query: "graphics card" },
    { targetId: "mobo-toronto", componentType: "motherboard", query: "motherboard" },
    { targetId: "psu-toronto", componentType: "psu", query: "power supply" },
    { targetId: "ram-ddr4", componentType: "ram", query: "ddr4 ram" },
    { targetId: "storage-ssd", componentType: "storage", query: "ssd" },
  ],
  keptSearches: [
    { targetId: "cpu-toronto", componentType: "cpu", query: "cpu" },
    { targetId: "gpu-rtx", componentType: "gpu", query: "rtx" },
    { targetId: "gpu-toronto", componentType: "gpu", query: "graphics card" },
  ],
};

const EMPTY_WATCH: WatchWire = {
  selection: { components: [], models: {}, location: null, radiusKm: null },
  storedTargets: [],
  keptSearches: [],
};

interface Wire {
  watch?: WatchWire;
  /** What `PUT /api/watch` answers -- the server re-reads from D1, so it is not the request. */
  watchAfter?: WatchWire;
  /** A 200 whose body is not JSON, which is the only way the save fallback is reached. */
  watchPutRaw?: string;
  watchStatus?: number;
  settings?: WireSettings | null;
  settingsStatus?: number;
  settingsPutStatus?: number;
  verdicts?: { listings: Listing[]; truncated: boolean };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * THE REAL CLIENT AND THE REAL TRANSPORT RUN; ONLY THE WIRE IS STUBBED. The router answers the two
 * reads the page makes on mount and records every write, so the assertions below are about the body
 * `App` actually sends rather than about a re-implementation of it.
 */
const stubWire = (wire: Wire = {}) => {
  const calls: Call[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url: String(url), method, body });
      const path = String(url).split("?")[0];
      if (path === "/api/watch") {
        if (method === "PUT") {
          return wire.watchPutRaw === undefined
            ? reply(wire.watchAfter ?? wire.watch ?? EMPTY_WATCH)
            : new Response(wire.watchPutRaw, { status: 200 });
        }
        return wire.watchStatus !== undefined && wire.watchStatus !== 200
          ? reply({ error: { code: "WATCH_TARGETS_STORAGE_FAILED" } }, wire.watchStatus)
          : reply(wire.watch ?? EMPTY_WATCH);
      }
      if (path === "/api/settings") {
        if (method === "PUT") {
          return wire.settingsPutStatus !== undefined && wire.settingsPutStatus !== 200
            ? reply({ error: { code: "SETTINGS_STORAGE_FAILED" } }, wire.settingsPutStatus)
            : reply({ settings: wire.settings ?? null, changed: true });
        }
        return wire.settingsStatus !== undefined && wire.settingsStatus !== 200
          ? reply({ error: { code: "SETTINGS_STORAGE_FAILED" } }, wire.settingsStatus)
          : reply({ settings: wire.settings ?? null });
      }
      if (path === "/api/verdicts") {
        return reply(wire.verdicts ?? { listings: [], truncated: false });
      }
      throw new Error(`unexpected request: ${method} ${String(url)}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
};

const putTo = (calls: Call[], path: string) =>
  calls.find((call) => call.method === "PUT" && call.url === path);

/** The page is loaded when the budget line is on screen; Save is disabled until it is. */
const waitForLoad = (budget: string) => screen.findByText(budget);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Marketplace Deal Finder", () => {
  it("shows required-field errors when preview is submitted empty", async () => {
    const user = userEvent.setup();
    stubWire();
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(screen.getByText("Select at least one component.")).toBeInTheDocument();
    expect(screen.getByText("Choose a location.")).toBeInTheDocument();
    expect(
      screen.getByText("0 of 9 searches used — select a component to search."),
    ).toBeInTheDocument();
  });

  /**
   * LINK THREE OF THE TOKEN CHAIN, AND NOW ALSO THE SELECTION. The first version of this test
   * captured `calls[0][0]` and never looked at `calls[0][1]`, so `preview(settings, noToken)` left
   * the whole frontend suite green while production answered 401 on every preview forever.
   */
  it("previews the listings the server returns, asking the right path WITH the token and the selection", async () => {
    const user = userEvent.setup();
    const calls = stubWire({
      verdicts: {
        listings: [
          wireListing(),
          wireListing({ listingId: "cpu-1", componentType: "cpu", title: "Ryzen 7 9800X3D" }),
        ],
        truncated: false,
      },
    });
    render(<App getToken={async () => "tok-123"} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(
      await screen.findByRole("heading", { name: "ASUS ROG Astral RTX 5080" }),
    ).toBeInTheDocument();
    // THE SERVER FILTERS NOW: both rows it sent are shown, and the browser does not second-guess
    // the page it was given.
    expect(screen.getByText("2 results")).toBeInTheDocument();
    const preview = calls.find((call) => call.url.startsWith("/api/verdicts"));
    expect(preview?.url).toBe("/api/verdicts?all=%5B%22gpu%22%5D&pairs=%5B%5D");
    const headers = new Headers(
      (vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith("/api/verdicts")) ?? [])[1]
        ?.headers,
    );
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
  });

  it("shows a bounded page as bounded, a null price as unpriced, and every status", async () => {
    const user = userEvent.setup();
    stubWire({
      verdicts: {
        listings: [
          wireListing({ listingId: "a", evaluation: { status: "DEAL" } }),
          wireListing({ listingId: "b", evaluation: { status: "NOT_DEAL" } }),
          wireListing({ listingId: "c", evaluation: { status: "NEEDS_REVIEW" } }),
          wireListing({ listingId: "d", priceCents: null, evaluation: { status: "PENDING" } }),
        ],
        truncated: true,
      },
    });
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(await screen.findByText("4+ results")).toBeInTheDocument();
    expect(screen.getByText("No price listed")).toBeInTheDocument();
    for (const label of ["Deal", "Not a deal", "Needs review", "Pending"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("Waiting to be evaluated.")).toBeInTheDocument();
  });

  /**
   * A-dead: THE "nothing on this page matched" BRANCH IS GONE, AND THE CLIENT-SIDE FILTER WITH IT.
   * The branch was reachable ONLY because `listings` was the client-filtered array while
   * `truncated` came from the server; deleting the filter is what makes it unsatisfiable, and the
   * server-side `WHERE` is what makes the deletion correct. The correct mutation is to restore the
   * filter AND the branch together -- this fixture is a bounded page of a component the user is not
   * watching, which is exactly what used to be reported as empty.
   */
  it("A-dead: a bounded page of unwatched components is shown, not reported as nothing", async () => {
    const user = userEvent.setup();
    stubWire({
      verdicts: {
        listings: [
          wireListing({ listingId: "cpu-a", componentType: "cpu", modelKey: "Ryzen 9 9950X3D" }),
          wireListing({ listingId: "cpu-b", componentType: "cpu", modelKey: "Ryzen 7 9800X3D" }),
        ],
        truncated: true,
      },
    });
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(await screen.findByText("2+ results")).toBeInTheDocument();
    expect(screen.queryByText("Nothing on this page matched")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching listings found")).not.toBeInTheDocument();
  });

  it("keeps the ordinary empty state when the server sent nothing", async () => {
    const user = userEvent.setup();
    stubWire({ verdicts: { listings: [], truncated: false } });
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(await screen.findByText("No matching listings found")).toBeInTheDocument();
    expect(screen.getByText(/wait for the next collection run/)).toBeInTheDocument();
    expect(screen.getByText("0 results")).toBeInTheDocument();
  });

  /**
   * THE READER FOR `source`, ASSERTED WHERE THE KEY ACTUALLY IS. My first version of this test
   * built the key inside the test body and MEASURED as vacuous -- reverting `App.tsx` to
   * `key={listing.listingId}` left the whole frontend suite green, because the test was exercising
   * React rather than App.
   */
  it("keys the list on (source, listingId), so two sources cannot collide", async () => {
    const user = userEvent.setup();
    stubWire({
      verdicts: {
        listings: [
          wireListing({ source: "facebook-marketplace", listingId: "SAME", title: "from facebook" }),
          wireListing({ source: "ebay", listingId: "SAME", title: "from ebay" }),
        ],
        truncated: false,
      },
    });
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => errors.push(String(args[0])));
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(await screen.findByRole("heading", { name: "from facebook" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "from ebay" })).toBeInTheDocument();
    spy.mockRestore();
    expect(errors.filter((message) => message.includes("same key"))).toEqual([]);
  });

  it("infers the combined deal rule from two checked criteria", async () => {
    const user = userEvent.setup();
    stubWire();
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    const discount = screen.getByRole("checkbox", { name: /Minimum discount/i });
    const maximum = screen.getByRole("checkbox", { name: /Maximum price/i });

    expect(discount).toBeChecked();
    expect(maximum).not.toBeChecked();
    await user.click(maximum);
    expect(discount).toBeChecked();
    expect(maximum).toBeChecked();
    expect(screen.getByText("Maximum price (CAD)")).toBeInTheDocument();
  });

  it("finds small municipalities and postal codes", async () => {
    const user = userEvent.setup();
    stubWire();
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    const locationSearch = screen.getByLabelText("Search location");
    await user.type(locationSearch, "N0B");
    expect(screen.getByRole("button", { name: "St. Jacobs, ON" })).toBeInTheDocument();

    // THE FIVE STREET ADDRESSES ARE GONE. They were demo data on a type called MockLocation, and
    // giving them their city's slug would have run the SAME Facebook search at DIFFERENT
    // coordinates -- two `market_key` buckets for one market.
    await user.clear(locationSearch);
    await user.type(locationSearch, "200 University Avenue");
    expect(screen.queryByRole("button", { name: /200 University Avenue/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No prototype match yet/)).toBeInTheDocument();
  });

  it("shows the account bar only when an identity is supplied", async () => {
    const user = userEvent.setup();
    stubWire();
    const identity: AuthenticatedIdentity = {
      email: "owner@example.com",
      subject: "firebase-uid-1",
      expiresAt: 1_800_003_600,
      authenticationMethod: "firebase-google",
    };
    const onSignOut = vi.fn();

    const anonymous = render(<App getToken={noToken} />);
    expect(screen.queryByText("owner@example.com")).not.toBeInTheDocument();
    anonymous.unmount();

    const local = render(<App identity={identity} getToken={noToken} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    local.unmount();

    render(<App identity={identity} onSignOut={onSignOut} getToken={noToken} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE PANEL THAT DRIVES COLLECTION. Every row here renders the real `App` over the real
 * `marketplaceClient` and the real transport, and asserts the BODY THE PAGE SENDS.
 */
describe("the control panel", () => {
  /**
   * A-load: A FAILED READ COSTS THE WRITE, NOT JUST A BANNER. Seeding from `initialSettings` and
   * saving replaces nine live rows and appends a search revision that re-opens 348 evaluation
   * tasks, so one click on a 503 must not be able to do it.
   */
  it.each([
    ["the watch list read fails", { watchStatus: 503 }],
    ["the settings read fails", { settingsStatus: 503 }],
  ])("A-load: Save stays disabled when %s", async (_label, wire) => {
    const calls = stubWire({ ...wire, watch: LIVE_WATCH, settings: null });
    render(<App getToken={noToken} />);

    // The banner carries the transport's own message for a 503; what this row is about is that
    // the failure costs the WRITE.
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/);
    const save = screen.getByRole("button", { name: "Save searches" });
    expect(save).toBeDisabled();
    expect(screen.getByText("Reading your saved searches…")).toBeInTheDocument();
    expect(putTo(calls, "/api/watch")).toBeUndefined();
  });

  /**
   * A-prod: THE BROWSER HALF OF THE ROUND TRIP THAT MATTERS MOST. Production's nine rows load, Save
   * is pressed with nothing touched, and the body carries all six stored queries plus the three
   * kept ids -- so the write reproduces what is stored instead of replacing it. Drop the echo and
   * the body sends `cpu: "cpu"` for a row that holds `ryzen`; drop `preservedTargetIds` and three
   * rows the form cannot display are deleted.
   */
  it("A-prod: an untouched Save over production's nine rows echoes every query and kept id", async () => {
    const user = userEvent.setup();
    const calls = stubWire({
      watch: LIVE_WATCH,
      settings: { mode: "DISCOUNT", minimumDiscountPercent: 10, maximumPriceCents: null },
    });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());

    expect(putTo(calls, "/api/watch")?.body).toEqual({
      components: ["cpu", "gpu", "motherboard", "psu", "ram", "storage"],
      models: {
        cpu: { mode: "all", values: [], query: "ryzen" },
        gpu: { mode: "all", values: [], query: "radeon" },
        motherboard: { mode: "all", values: [], query: "motherboard" },
        psu: { mode: "all", values: [], query: "power supply" },
        ram: { mode: "all", values: [], query: "ddr4 ram" },
        storage: { mode: "all", values: [], query: "ssd" },
      },
      location: TORONTO,
      radiusKm: 25,
      preservedTargetIds: ["cpu-toronto", "gpu-rtx", "gpu-toronto"],
    });
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
  });

  /**
   * A-rule: THE SEED, AND IT IS THE HIGHEST-CONSEQUENCE LINE IN THE BROWSER HALF. Without it the
   * form holds 25%, Save PUTs unconditionally, 10 !== 25, a revision is appended and every one of
   * production's 348 evaluation tasks re-opens -- while the operator's threshold silently becomes a
   * number they never typed.
   */
  it("A-rule: a live DISCOUNT 10% is rendered, and an untouched Save sends 10", async () => {
    const user = userEvent.setup();
    const calls = stubWire({
      watch: LIVE_WATCH,
      settings: { mode: "DISCOUNT", minimumDiscountPercent: 10, maximumPriceCents: null, searchRevision: 1 },
    });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    expect(screen.getByLabelText<HTMLInputElement>("Minimum discount (%)").value).toBe("10");

    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/settings")).toBeDefined());
    expect(putTo(calls, "/api/settings")?.body).toEqual({
      mode: "DISCOUNT",
      minimumDiscountPercent: 10,
      maximumPriceCents: null,
    });
  });

  /**
   * A-budget: THE COUNT ON SCREEN IS THE COUNT THAT GETS REFUSED, and it includes the kept
   * searches. MEASURED CONSEQUENCE OF THE SYMMETRIC PRESERVATION RULE: deselecting a component does
   * NOT free a slot -- it converts a derived slot into a kept one -- so the over-budget copy says
   * REMOVE. Earlier copy said "deselect a component", which is measurably wrong advice.
   */
  it("A-budget: the line counts derived + kept, and the over-budget copy says remove", async () => {
    const user = userEvent.setup();
    stubWire({
      watch: {
        selection: {
          components: ["gpu"],
          models: { gpu: { mode: "all", values: [], query: "radeon" } },
          location: TORONTO,
          radiusKm: 25,
        },
        storedTargets: [
          { targetId: "gpu-radeon", componentType: "gpu", query: "radeon" },
          { targetId: "gpu-rtx", componentType: "gpu", query: "rtx" },
          { targetId: "legacy-ebay", componentType: "ebay", query: "gpu deals" },
        ],
        keptSearches: [
          { targetId: "gpu-rtx", componentType: "gpu", query: "rtx" },
          { targetId: "legacy-ebay", componentType: "ebay", query: "gpu deals" },
        ],
      },
      settings: null,
    });
    render(<App getToken={noToken} />);
    // 1 derived + 2 kept.
    await waitForLoad("3 of 9 searches used");

    // Narrowing gpu to 8 models: 8 derived + 2 kept = 10, and the broad `radeon` row joins the kept
    // list rather than being deleted -- which is why only Remove frees a slot.
    await user.click(screen.getByText("GPU models"));
    for (const model of componentById.gpu.models.slice(0, 8)) {
      await user.click(screen.getByRole("checkbox", { name: model }));
    }
    expect(await screen.findByText("11 of 9 searches used")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save searches" }));
    const alert = await screen.findByText(
      "11 of 9 searches used — remove a kept search or narrow fewer models.",
    );
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).not.toContain("deselect");

    // D-8: REMOVE IS THE ONE ACTION THE MESSAGE ASKS FOR, SO IT MUST ANSWER THE MESSAGE. Without
    // re-validating here the text stayed at "11 of 9" after the operator did exactly what it said,
    // which reads as "the only route out did not work".
    await user.click(screen.getByRole("button", { name: "Remove gpu-rtx" }));
    expect(
      await screen.findByText("10 of 9 searches used — remove a kept search or narrow fewer models."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove legacy-ebay" }));
    expect(screen.getByText("9 of 9 searches used")).toBeInTheDocument();
    expect(screen.queryByText(/remove a kept search/)).not.toBeInTheDocument();
  });

  /**
   * A-kept: THE ROWS ARE LISTED VERBATIM, THERE IS NO ACKNOWLEDGEMENT CHECKBOX, AND REMOVE IS WHAT
   * DELETES ONE. Nothing is destroyed by a save, so there is nothing to consent to -- and an
   * earlier consent gate MEASURABLY collected consent for rows that survive while saying nothing
   * about any that do not.
   */
  it("A-kept: kept rows are listed with a Remove, and removing one drops it from the save", async () => {
    const user = userEvent.setup();
    const calls = stubWire({ watch: LIVE_WATCH, settings: null });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    // THE STORED QUERY IS ON SCREEN. Production's rows are free-text queries the form cannot
    // author; a form that saves a query it never displayed is how one gets rewritten without the
    // operator ever seeing it.
    await user.click(screen.getByText("GPU models"));
    expect(screen.getByText(/Searches Facebook for “radeon”/)).toBeInTheDocument();

    const kept = screen.getByTestId("kept-searches");
    expect(kept).toHaveTextContent('cpu-toronto · cpu · “cpu”');
    expect(kept).toHaveTextContent('gpu-rtx · gpu · “rtx”');
    expect(kept).toHaveTextContent('gpu-toronto · gpu · “graphics card”');
    expect(kept).toHaveTextContent(/not editable here/);
    expect(screen.queryByRole("checkbox", { name: /understand|acknowledge|consent/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Remove gpu-rtx" }));
    expect(await screen.findByText("8 of 9 searches used")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());
    expect(
      (putTo(calls, "/api/watch")?.body as { preservedTargetIds: string[] }).preservedTargetIds,
    ).toEqual(["cpu-toronto", "gpu-toronto"]);
  });

  /**
   * A-first-click: FROM `all`, THE FIRST CLICK SELECTS THAT MODEL. The shipped branch expanded
   * `component.models` first, so one click produced 67 values -> 67 targets -> a budget of "67 of
   * 9" and a Save that could never succeed.
   */
  it("A-first-click: ticking one model of an all-models type reads 1 of 9, not 67 of 9", async () => {
    const user = userEvent.setup();
    stubWire();
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    expect(screen.getByText("1 of 9 searches used")).toBeInTheDocument();
    await user.click(screen.getByText("GPU models"));
    await user.click(screen.getByRole("checkbox", { name: "GeForce RTX 5090" }));

    expect(screen.getByText("1 of 9 searches used")).toBeInTheDocument();
    expect(screen.getByText("1 of 68 models")).toBeInTheDocument();
  });

  /**
   * A-all4: THE REACHABLE SEQUENCES THAT USED TO BRICK THE SAVE, AND WHAT THE WIRE CARRIES AFTER
   * THEM. `tick a type`, `Select all N models` from a narrowed state, and ticking every model one
   * at a time are the three `mode:"all"` transitions a user can actually perform; each one must end
   * with `values: []` on the wire.
   *
   * MEASURED, AND STATED BECAUSE IT CHANGES WHERE THE GUARD LIVES: restoring
   * `[...component.models]` at any ONE of those sites leaves this test green, because
   * `watchModelsFor` normalises the selection at the wire boundary -- one place rather than four.
   * The killing mutations for that invariant are in `marketplaceClient.test.ts` (pass
   * `selection.values` through) and here (restore the expand-then-remove first click); the
   * individual sites are no longer independently observable, which is the point of normalising
   * once.
   */
  it("A-all4: toggleComponent, the Select-all checkbox and a full re-selection all send values: []", async () => {
    const user = userEvent.setup();
    const calls = stubWire({
      // What the server answers after each save, re-read from D1: one broad case_fans row.
      watchAfter: {
        selection: {
          components: ["case_fans"],
          models: { case_fans: { mode: "all", values: [], query: "case fan" } },
          location: TORONTO,
          radiusKm: 25,
        },
        storedTargets: [
          { targetId: "case_fans-case-fan", componentType: "case_fan", query: "case fan" },
        ],
        keptSearches: [],
      },
    });
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    // SITE 1: toggleComponent.
    await user.click(screen.getByRole("checkbox", { name: /^Case Fans:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());
    expect((putTo(calls, "/api/watch")?.body as { models: unknown }).models).toEqual({
      case_fans: { mode: "all", values: [], query: "case fan" },
    });

    // SITE 2: the "Select all N models" checkbox, reached from a narrowed selection.
    await user.click(screen.getByText("Case Fans models"));
    await user.click(screen.getByRole("checkbox", { name: componentById.case_fans.models[0] }));
    expect(screen.getByText(`1 of ${componentById.case_fans.models.length} models`)).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: new RegExp(`Select all ${componentById.case_fans.models.length} models`),
      }),
    );
    expect(
      screen.getByText(`All ${componentById.case_fans.models.length} models`),
    ).toBeInTheDocument();
    calls.length = 0;
    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());
    expect((putTo(calls, "/api/watch")?.body as { models: unknown }).models).toEqual({
      case_fans: { mode: "all", values: [], query: "case fan" },
    });

    // SITE 3: toggleModel's own all-branch -- ticking every model one at a time collapses back to
    // `all`, and `values` must still be empty.
    for (const model of componentById.case_fans.models) {
      await user.click(screen.getByRole("checkbox", { name: model }));
    }
    expect(
      screen.getByText(`All ${componentById.case_fans.models.length} models`),
    ).toBeInTheDocument();
    calls.length = 0;
    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());
    expect((putTo(calls, "/api/watch")?.body as { models: unknown }).models).toEqual({
      case_fans: { mode: "all", values: [], query: "case fan" },
    });
  });

  /**
   * A-none: WHEN A TYPE'S MODEL LIST EMPTIES, THE COMPONENT IS UNTICKED. `mode:"none"` has no
   * backend representation, so leaving the component ticked means a component selected on screen
   * and silently unsearched -- and sending `none` is a 400.
   */
  it("A-none: emptying a type's model list unticks the component", async () => {
    const user = userEvent.setup();
    stubWire();
    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    const gpu = screen.getByRole("checkbox", { name: /^GPU:/i });
    await user.click(gpu);
    await user.click(screen.getByText("GPU models"));
    await user.click(screen.getByRole("checkbox", { name: /Select all 68 models/i }));

    expect(screen.queryByText("GPU models")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^GPU:/i })).not.toBeChecked();
    expect(screen.getByText("0 of 9 searches used")).toBeInTheDocument();
  });

  /**
   * A-radius-warn: the market change is DISCLOSED, NOT PREVENTED -- preventing it would mean
   * refusing the control this slice exists to build. Without the line the reset is invisible until
   * the benchmarks read zero.
   */
  it("A-radius-warn: the benchmark-reset line and the storable radius bounds are rendered", async () => {
    const user = userEvent.setup();
    stubWire({ watch: LIVE_WATCH, settings: null });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    expect(screen.getByTestId("radius-warning")).toHaveTextContent(
      "Changing the location or radius starts your price benchmarks over.",
    );

    await user.click(screen.getByRole("button", { name: "Custom" }));
    const custom = screen.getByLabelText<HTMLInputElement>("Custom radius (km)");
    expect(custom.min).toBe("1");
    expect(custom.max).toBe("25");
    expect(custom.step).toBe("1");
  });

  /**
   * A-snap: "USE CURRENT LOCATION" SNAPS TO THE NEAREST COMMITTED MARKET AND THE DEVICE'S
   * COORDINATES NEVER REACH THE WIRE. Two separate things ride on that:
   *
   * 1. PRIVACY. `migrations/0005` seeds a PUBLIC LANDMARK "chosen so that a leaked collector token
   *    does not disclose the operator's home", and says the settings UI must preserve that
   *    property. The shipped button wrote `position.coords.*` straight into the settings object.
   * 2. THE AGGREGATE. `market_key` buckets coordinates at 4 decimal places (~11 m), so GPS jitter
   *    alone would fork the price benchmark into a new bucket on every save.
   */
  it("A-snap: Use current location selects the nearest catalog market, not the device fix", async () => {
    const user = userEvent.setup();
    const calls = stubWire({
      watchAfter: {
        selection: {
          components: ["gpu"],
          models: { gpu: { mode: "all", values: [], query: "graphics card" } },
          location: { slug: "kitchener", latitude: 43.4516, longitude: -80.4925 },
          radiusKm: 25,
        },
        storedTargets: [],
        keptSearches: [],
      },
    });
    // A fix 1.2 km from the Kitchener entry and nowhere near its coordinates.
    const deviceLatitude = 43.4612;
    const deviceLongitude = -80.4877;
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: (onSuccess: PositionCallback) =>
          onSuccess({
            coords: { latitude: deviceLatitude, longitude: deviceLongitude },
          } as GeolocationPosition),
      },
    });

    render(<App getToken={noToken} />);
    await waitForLoad("0 of 9 searches used");

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.click(screen.getByRole("button", { name: "Use current location" }));

    expect(await screen.findByText(/Nearest match: Kitchener, ON/)).toBeInTheDocument();
    expect(screen.getByText("Selected: Kitchener, ON")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());
    expect((putTo(calls, "/api/watch")?.body as { location: unknown }).location).toEqual({
      slug: "kitchener",
      latitude: 43.4516,
      longitude: -80.4925,
    });
    const sent = JSON.stringify(putTo(calls, "/api/watch")?.body);
    expect(sent).not.toContain(String(deviceLatitude));
    expect(sent).not.toContain(String(deviceLongitude));
  });

  /**
   * A-market: THE STORED COORDINATES ARE WHAT THE FORM SENDS BACK. Looking the slug up in the
   * catalog and returning that entry WHOLE discarded them, so a market row at
   * `('toronto', 43.6459, -79.3816)` -- what a hand-written bootstrap could hold -- was rewritten to
   * the catalog's coordinates BY AN UNTOUCHED SAVE, moving `market_key` and orphaning every
   * `model_stats` row, while the form's own warning said that happens only if you change something.
   * The server cannot catch it: the coordinates it receives agree with the slug.
   *
   * The refusal those stored coordinates now get is `worker/api/watch.test.ts`'s W-loc; what this row
   * asserts is that the form stops silently substituting.
   */
  it("A-market: an untouched Save carries the stored coordinates, not the catalog's", async () => {
    const user = userEvent.setup();
    const drifted = { slug: "toronto", latitude: 43.6459, longitude: -79.3816 };
    const calls = stubWire({
      watch: {
        ...LIVE_WATCH,
        selection: { ...LIVE_WATCH.selection, location: drifted },
      },
      settings: null,
    });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    // The label still comes from the catalog, so the operator sees a city rather than a slug.
    expect(screen.getByText("Selected: Toronto, ON")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save searches" }));
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());
    expect((putTo(calls, "/api/watch")?.body as { location: unknown }).location).toEqual(drifted);
  });

  /**
   * A-partial: THE WATCH WRITE IS COMMITTED BEFORE THE DEAL-RULE WRITE IS ATTEMPTED, so a failure on
   * the second leaves the form describing what IS stored rather than what was stored before the
   * click. Previously both state setters sat after the rule PUT: a 503 there left the page showing
   * Toronto while D1 held Waterloo, with the benchmarks already reset and nothing on screen changed.
   */
  it("A-partial: a failing deal-rule save still shows the watch list that WAS written", async () => {
    const user = userEvent.setup();
    const written: WatchWire = {
      selection: {
        components: ["gpu"],
        models: { gpu: { mode: "all", values: [], query: "radeon" } },
        location: TORONTO,
        radiusKm: 10,
      },
      storedTargets: [{ targetId: "gpu-radeon", componentType: "gpu", query: "radeon" }],
      keptSearches: [],
    };
    const calls = stubWire({
      watch: LIVE_WATCH,
      watchAfter: written,
      settings: null,
      settingsPutStatus: 503,
    });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    await user.click(screen.getByRole("button", { name: "Save searches" }));

    // The error is shown...
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/);
    // ...and the form now describes the list that IS in D1: one derived search, no kept searches.
    expect(screen.getByText("1 of 9 searches used")).toBeInTheDocument();
    expect(screen.queryByTestId("kept-searches")).not.toBeInTheDocument();
    // "Saved." is NOT claimed, because the save was only half done.
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument();
    expect(putTo(calls, "/api/settings")).toBeDefined();
  });

  /**
   * A-fallback: THE FALLBACK MESSAGES ARE REACHABLE, which is why they are not deleted. The review
   * read them as dead on the grounds that every throw constructs an `ApiRequestError`; the body
   * parse does not. `requestJson` ends with an unwrapped `await response.json()`, so a 200 carrying
   * a truncated or non-JSON body rejects with a SyntaxError, which `requestErrorMessage` cannot
   * recognise -- and that is exactly when the caller's own sentence is the only thing to show.
   */
  it("A-fallback: a 200 with a body that is not JSON shows the load fallback and disables Save", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("<html>a proxy error page</html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App getToken={noToken} />);

    expect(
      await screen.findByText(
        "Could not read your saved searches. Saving is disabled until it loads.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save searches" })).toBeDisabled();
  });

  /**
   * A-saved-maybe: THE SAVE FALLBACK MUST NOT CLAIM THE DATA IS UNTOUCHED. It is reached only when
   * the throw is not an `ApiRequestError`, which on this path means a SyntaxError from parsing
   * `saveWatch`'s own RESPONSE -- i.e. AFTER one PUT reached `/api/watch` and the write committed,
   * and before the re-seed could run. "Nothing was changed." was therefore a false statement about
   * the operator's watch list, and no reordering can make it true.
   */
  it("A-saved-maybe: a save whose response will not parse says the write MAY have landed", async () => {
    const user = userEvent.setup();
    const calls = stubWire({
      watch: LIVE_WATCH,
      settings: null,
      watchPutRaw: "<html>a gateway page</html>",
    });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    await user.click(screen.getByRole("button", { name: "Save searches" }));

    // The PUT went out -- which is exactly why the copy cannot say nothing changed.
    await waitFor(() => expect(putTo(calls, "/api/watch")).toBeDefined());
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(
      "Your searches may have been saved. Reload the page to see what is stored.",
    );
    expect(banner.textContent).not.toContain("Nothing was changed");
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument();
  });

  /**
   * A-scope: WHAT PREVIEW STILL IGNORES IS ON SCREEN. `components` and `models` are real now;
   * `location`, `radiusKm` and the deal rule are not -- a verdict is committed against the STORED
   * revision, so an unsaved rule edit previews against the saved rule. The comment that used to
   * disclose this was replaced when the read became half-real.
   *
   * It also asserts the monitoring panel is GONE. With Start/Stop deleted, nothing could ever set
   * the status, so the panel answered "Not running / Stopped / Next scan —" forever, beside a line
   * saying the collector runs every 30 minutes. Restoring it needs a reader for `monitor_runs`.
   */
  it("A-scope: the page says what Preview ignores and claims nothing about the monitor", async () => {
    stubWire({ watch: LIVE_WATCH, settings: null });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    expect(screen.getByTestId("preview-scope")).toHaveTextContent(
      "using your saved deal rule — not unsaved edits",
    );
    for (const claim of ["Monitoring", "Not running", "Stopped", "Last successful scan", "Next scan"]) {
      expect(screen.queryByText(claim), claim).not.toBeInTheDocument();
    }
  });

  /** The form refuses a radius the column cannot store, rather than letting the write 503. */
  it("A-radius: a non-integer radius is refused by the form", async () => {
    const user = userEvent.setup();
    const calls = stubWire({ watch: LIVE_WATCH, settings: null });
    render(<App getToken={noToken} />);
    await waitForLoad("9 of 9 searches used");

    await user.click(screen.getByRole("button", { name: "Custom" }));
    const custom = screen.getByLabelText("Custom radius (km)");
    await user.clear(custom);
    await user.type(custom, "12.5");
    await user.click(screen.getByRole("button", { name: "Save searches" }));

    expect(
      await screen.findByText("Radius must be a whole number between 1 and 25 km."),
    ).toBeInTheDocument();
    expect(putTo(calls, "/api/watch")).toBeUndefined();
  });
});
