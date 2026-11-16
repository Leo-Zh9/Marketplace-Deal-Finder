import {
  dealRuleToSettings,
  marketplaceClient,
  settingsToDealRule,
  type WireSettings,
} from "./marketplaceClient";
import {
  preservableTargets,
  queryFor,
  verdictsQuery,
  watchModelsFor,
  type StoredTarget,
} from "./watchSelection";
import { componentById } from "../data/catalog";
import type { DealRule, Listing, SearchSettings } from "../types";

const row = (over: Partial<Listing> = {}): Listing => ({
  source: "facebook-marketplace",
  listingId: "L1",
  componentType: "gpu",
  modelKey: "GeForce RTX 5080",
  variantKey: null,
  title: "a card",
  priceCents: 300000,
  location: null,
  url: "https://example.com/l",
  observedAt: "2027-01-15T08:00:00.000Z",
  evaluation: { status: "DEAL" },
  ...over,
});

const stubJson = (body: unknown) => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const settings: SearchSettings = {
  components: [],
  models: {},
  queries: {},
  location: null,
  radiusKm: 25,
  dealRule: {
    type: "discount" as const,
    minimumDiscountPercent: 25,
    maximumPriceCad: "",
  },
};

const INITIAL_RULE: DealRule = {
  type: "discount",
  minimumDiscountPercent: 25,
  maximumPriceCad: "",
};

const noToken = async () => null;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the read path", () => {
  /**
   * THE SELECTION TRAVELS IN THE URL AND THE CLIENT NO LONGER FILTERS. The old client filtered the
   * response AFTER the server's `LIMIT 50`, which is PR #17's defect: a bounded page of a component
   * the user does not watch filtered down to nothing and the page called a non-empty database
   * empty. Keeping the filter as well as the `WHERE` would hide a server-side regression.
   */
  it("A-select: the selection is sent as ?all and ?pairs, and the response is served unfiltered", async () => {
    const fetchMock = stubJson({
      listings: [
        row({ listingId: "wanted", modelKey: "GeForce RTX 5090" }),
        // Rows the OLD client-side filter would have removed. The server is what filters now, so
        // whatever it sends is what the page shows.
        row({ listingId: "other-model", modelKey: "GeForce RTX 5080" }),
        row({ listingId: "no-model", modelKey: null }),
        row({ listingId: "wrong-component", componentType: "cpu", modelKey: "Ryzen 5 9600X" }),
      ],
      truncated: false,
    });

    const result = await marketplaceClient.preview(
      {
        ...settings,
        components: ["gpu", "cpu"],
        models: {
          gpu: { mode: "selected", values: ["GeForce RTX 5090"] },
          cpu: { mode: "all", values: [] },
        },
      },
      noToken,
    );

    expect(result.listings.map((listing) => listing.listingId)).toEqual([
      "wanted",
      "other-model",
      "no-model",
      "wrong-component",
    ]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith("/api/verdicts?")).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(JSON.parse(params.get("all") ?? "")).toEqual(["cpu"]);
    expect(JSON.parse(params.get("pairs") ?? "")).toEqual(["gpu/GeForce RTX 5090"]);
  });

  /**
   * BOTH PARAMETERS ARE ALWAYS SENT. `?pairs` with `?all` ABSENT is a 400 on purpose -- measured,
   * the pairs are a silent no-op in that shape -- and `?all` absent means the UNFILTERED page, so
   * omitting an empty `all` would serve every component for a model-narrowed selection.
   */
  it("A-select: an all-models selection sends an empty pairs list, and vice versa", () => {
    expect(new URLSearchParams(verdictsQuery({ ...settings, components: ["gpu"] })).get("pairs")).toBe(
      "[]",
    );
    expect(
      new URLSearchParams(
        verdictsQuery({
          ...settings,
          components: ["gpu"],
          models: { gpu: { mode: "selected", values: ["GeForce RTX 5080"] } },
        }),
      ).get("all"),
    ).toBe("[]");
    // A `none` type contributes to neither list.
    expect(
      verdictsQuery({
        ...settings,
        components: ["gpu"],
        models: { gpu: { mode: "none", values: [] } },
      }),
    ).toBe("all=%5B%5D&pairs=%5B%5D");
  });

  it("carries the server's truncation flag through unchanged", async () => {
    stubJson({ listings: [row()], truncated: true });
    const result = await marketplaceClient.preview(
      { ...settings, components: ["gpu"] },
      noToken,
    );
    expect(result.truncated).toBe(true);
  });

  it("sends the identity token it was given", async () => {
    const fetchMock = stubJson({ listings: [], truncated: false });
    await marketplaceClient.preview({ ...settings, components: ["gpu"] }, async () => "id-token");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer id-token");
  });
});

/**
 * THE DEAL RULE, BOTH DIRECTIONS. Without the inverse mapper the form starts at 25%, Save PUTs
 * unconditionally, `updateSearchSettings` compares projections, 10 !== 25, and
 * `CLAIM_STALE_REVISION` RE-OPENS EVERY EVALUATION TASK IN THE CORPUS -- 348 of them in production
 * -- while the operator's threshold silently becomes a number they never typed.
 */
describe("the deal rule mappers", () => {
  it("A-rule: a live DISCOUNT 10% seeds the form, and an untouched save sends 10", async () => {
    const live: WireSettings = {
      mode: "DISCOUNT",
      minimumDiscountPercent: 10,
      maximumPriceCents: null,
      searchRevision: 1,
    };
    const seeded = settingsToDealRule(live, INITIAL_RULE);
    expect(seeded.minimumDiscountPercent).toBe(10);
    expect(dealRuleToSettings(seeded)).toEqual({
      mode: "DISCOUNT",
      minimumDiscountPercent: 10,
      maximumPriceCents: null,
    });
    // ...and the number the UNSEEDED form would have sent, which is the defect.
    expect(dealRuleToSettings(INITIAL_RULE).minimumDiscountPercent).toBe(25);
  });

  /**
   * A-rule-id: `live -> form -> wire` IS IDENTITY FOR EVERY MODE, `maximumPriceCents: 0` INCLUDED.
   * The per-field fallback is what makes it hold: `worker/search/settings.ts` warns that the field
   * a mode makes INERT IS NOT IN THE ROW, so it comes back `null` and the form must supply its own
   * value for it -- and `=== null` rather than `??` is what stops a stored 0 being replaced.
   */
  it.each([
    ["DISCOUNT", { mode: "DISCOUNT", minimumDiscountPercent: 10, maximumPriceCents: null }],
    ["MAXIMUM_PRICE", { mode: "MAXIMUM_PRICE", minimumDiscountPercent: null, maximumPriceCents: 74900 }],
    ["BOTH", { mode: "BOTH", minimumDiscountPercent: 15, maximumPriceCents: 60005 }],
    ["BOTH at zero", { mode: "BOTH", minimumDiscountPercent: 1, maximumPriceCents: 0 }],
  ])("A-rule-id: %s round-trips unchanged", (_label, live) => {
    const wire = live as WireSettings;
    expect(dealRuleToSettings(settingsToDealRule(wire, INITIAL_RULE))).toEqual(wire);
  });

  /**
   * A-rule-id's TABLE CANNOT SEE THE PER-FIELD FALLBACK ON ITS OWN, and this row is why it is
   * written separately. MEASURED: replacing the fallback with the stored `null` leaves the whole
   * round-trip table green, because the field the mode made inert is dropped again on the way back
   * -- `null -> null` is an identity. The fallback's consequence appears only when the USER CHANGES
   * THE MODE, which is the sequence `worker/search/settings.ts:95-98` warns about: an inert field
   * IS NOT IN THE ROW, so without a fallback the form switches to a mode whose required field is
   * `null` and Save answers 400 INVALID_SETTINGS.
   */
  it("A-rule-id: switching the mode after a load carries the form's own value for the inert field", () => {
    const live: WireSettings = {
      mode: "MAXIMUM_PRICE",
      minimumDiscountPercent: null,
      maximumPriceCents: 74900,
    };
    const form = settingsToDealRule(live, INITIAL_RULE);
    expect(form.minimumDiscountPercent).toBe(25);
    // The user ticks "Minimum discount" as well: the discount must be a number, not the `null` the
    // row held.
    expect(dealRuleToSettings({ ...form, type: "both" })).toEqual({
      mode: "BOTH",
      minimumDiscountPercent: 25,
      maximumPriceCents: 74900,
    });
  });

  /**
   * A STORED ZERO IS A VALUE, NOT AN ABSENCE, and `=== null` rather than a truthiness test is what
   * keeps it. MEASURED: `!settings.maximumPriceCents` leaves the round-trip table green because
   * `Number("") === 0`, so the fallback used there has to be a real price for the defect to show.
   */
  it("A-rule-id: a stored maximumPriceCents of 0 is rendered as 0.00, not replaced by the default", () => {
    expect(
      settingsToDealRule(
        { mode: "BOTH", minimumDiscountPercent: 1, maximumPriceCents: 0 },
        { type: "discount", minimumDiscountPercent: 25, maximumPriceCad: "749.99" },
      ).maximumPriceCad,
    ).toBe("0.00");
  });

  it("A-rule-null: a never-configured database keeps the form default", () => {
    expect(settingsToDealRule(null, INITIAL_RULE)).toEqual(INITIAL_RULE);
    // ...and not an invented "DISCOUNT 0%".
    expect(settingsToDealRule(null, INITIAL_RULE).minimumDiscountPercent).toBe(25);
  });

  /**
   * A-cents: `600.05`, AND THE VALUE'S PROVENANCE IS THE TEST. MEASURED over 500,000 two-decimal
   * prices: 65,628 (13.1%) give a non-integer product, and `600.05 * 100` is `60004.99999999999`.
   * `749.99 * 100` is EXACTLY 74999, so the obvious test value DOES NOT KILL the mutation -- and no
   * `.99` price between $600 and $1000 breaks at all. Without `Math.round` the wire carries a
   * non-integer, `validateSettings` gates on `Number.isSafeInteger`, and Save answers 400
   * INVALID_SETTINGS for one price in eight.
   */
  it("A-cents: a price whose cents are not exact in binary still sends an integer", () => {
    expect(600.05 * 100).not.toBe(60005);
    expect(
      dealRuleToSettings({ type: "maximum_price", minimumDiscountPercent: 25, maximumPriceCad: "600.05" })
        .maximumPriceCents,
    ).toBe(60005);
    // The control: the value anyone would have reached for first cannot see the defect.
    expect(749.99 * 100).toBe(74999);
  });

  it("sends the mapped rule to PUT /api/settings", async () => {
    const fetchMock = stubJson({ settings: null, changed: true });
    await marketplaceClient.saveDealRule(
      { type: "both", minimumDiscountPercent: 15, maximumPriceCad: "600.05" },
      noToken,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      mode: "BOTH",
      minimumDiscountPercent: 15,
      maximumPriceCents: 60005,
    });
  });
});

/**
 * THE CLIENT HALF OF THE SYMMETRIC PRESERVATION RULE. The server recomputes this set and refuses
 * any id outside it, so these two must agree: if the client under-counts, the form shows a budget
 * the server refuses; if it over-counts, the save is a 400 naming an id.
 */
describe("the kept searches", () => {
  const stored: StoredTarget[] = [
    { targetId: "cpu-ryzen", componentType: "cpu", query: "ryzen" },
    { targetId: "cpu-toronto", componentType: "cpu", query: "cpu" },
    { targetId: "ram-ddr4", componentType: "ram", query: "ddr4 ram" },
    { targetId: "gpu-5080", componentType: "gpu", query: "GeForce RTX 5080" },
    { targetId: "fan-legacy", componentType: "case_fan", query: "quiet fans" },
    { targetId: "legacy-ebay", componentType: "ebay", query: "gpu deals" },
  ];

  it("keeps only what the selection is not writing, and never a re-authorable model name", () => {
    const kept = preservableTargets(
      stored,
      ["cpu", "ram"],
      {},
      { cpu: "ryzen", ram: "ddr4 ram" },
    );
    // `cpu-ryzen` and `ram-ddr4` are being written by the derivation, so they are not kept.
    // `gpu-5080` is a catalog model name: re-authorable as mode:"selected", so never preserved.
    expect(kept.map((row) => row.targetId)).toEqual([
      "cpu-toronto",
      "fan-legacy",
      "legacy-ebay",
    ]);
  });

  /**
   * NARROWING MOVES A BROAD QUERY INTO THE KEPT LIST -- the action the whole slice exists to
   * enable, and the one a delete-on-narrow rule destroys.
   */
  it("moves a type's broad query into the kept list when that type is narrowed", () => {
    const kept = preservableTargets(
      stored,
      ["cpu", "ram"],
      { ram: { mode: "selected", values: [componentById.ram.models[0]] } },
      { cpu: "ryzen" },
    );
    expect(kept.map((row) => row.targetId)).toContain("ram-ddr4");
  });

  it("keeps a deselected type's broad query too -- deselecting frees no budget slot", () => {
    const kept = preservableTargets(stored, ["cpu"], {}, { cpu: "ryzen" });
    expect(kept.map((row) => row.targetId)).toEqual([
      "cpu-toronto",
      "ram-ddr4",
      "fan-legacy",
      "legacy-ebay",
    ]);
  });

  /**
   * THE `case_fan`/`case_fans` TRANSLATION, on the client side of the same trap. Comparing the
   * stored `case_fan` against the catalog without translating makes every case-fan row look like
   * an unknown type -- which is still preservable, so the bug is silent until a case_fans
   * selection derives a row the client thinks is also preservable and the server refuses the id.
   */
  it("translates the stored case_fan spelling before asking the catalog", () => {
    const kept = preservableTargets(
      [{ targetId: "fan-noctua", componentType: "case_fan", query: "Noctua NF-A12x25 PWM" }],
      [],
      {},
      {},
    );
    expect(kept).toEqual([]);
  });

  /**
   * THE WIRE INVARIANT IS ENFORCED AT THIS ONE BOUNDARY, not at the four UI sites that used to
   * break it. `values` is non-empty IFF the mode is `selected`, and a `query` is forbidden under
   * `selected`; the server REFUSES both violations rather than coercing them, so one normalisation
   * here is what keeps a UI state that still carries model names from being a 400.
   *
   * THE FIRST INPUT IS THE SHIPPED BUG'S OWN STATE: `mode:"all"` carrying all 68 model names, which
   * the reachable sequence `tick gpu -> narrow -> Select all` used to produce.
   */
  it("builds the wire selection with values empty under all and no query under selected", () => {
    expect(
      watchModelsFor(
        ["cpu", "gpu"],
        {
          cpu: { mode: "all", values: [...componentById.cpu.models] },
          gpu: { mode: "selected", values: ["GeForce RTX 5080"] },
        },
        { cpu: "ryzen" },
      ),
    ).toEqual({
      cpu: { mode: "all", values: [], query: "ryzen" },
      gpu: { mode: "selected", values: ["GeForce RTX 5080"] },
    });
  });

  /** A newly selected type with no stored row searches with the catalog's committed term. */
  it("falls back to the catalog searchTerm for a type with no stored query", () => {
    expect(queryFor("gpu", {})).toBe("graphics card");
    expect(queryFor("gpu", { gpu: "radeon" })).toBe("radeon");
    expect(queryFor("cpu", {})).toBe("cpu");
  });

  it("sends the watch body to PUT /api/watch", async () => {
    const fetchMock = stubJson({
      selection: { components: [], models: {}, location: null, radiusKm: null },
      storedTargets: [],
      keptSearches: [],
    });
    await marketplaceClient.saveWatch(
      {
        components: ["gpu"],
        models: { gpu: { mode: "all", values: [], query: "radeon" } },
        location: { slug: "toronto", latitude: 43.6532, longitude: -79.3832 },
        radiusKm: 25,
        preservedTargetIds: ["cpu-toronto"],
      },
      noToken,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/watch");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body)).preservedTargetIds).toEqual(["cpu-toronto"]);
  });

  /**
   * THE STATUS READ IS A GET TO `/api/status` WITH THE TOKEN AND NO BODY, and the body is passed
   * through UNFLATTENED.
   *
   * THE MUTATION THAT MATTERS IS RESHAPING IT HERE -- picking fields, or defaulting `collector`
   * to an object. Every field below is rendered by the panel, and the panel's whole contract is
   * that it renders nothing the collector did not report; a client that invented a `collector`
   * where the server sent `null` would make "No collector run has reported yet" unreachable,
   * which is the state the deleted panel's "Stopped" occupied.
   *
   * `getStatus` IS THE SIXTH METHOD ON THE CLIENT AND IT DELIBERATELY DOES NOT JOIN THE TWO
   * MOUNT READS. See `MarketplaceClient` for why: those two gate Save, and this one must not.
   */
  it("reads GET /api/status with the token and passes the body through unchanged", async () => {
    const body = {
      status: "degraded",
      causes: ["canary", "feed-overlap:gpu-radeon+gpu-rtx"],
      reportedAt: 1_800_000_000,
      ageMinutes: 6,
      collector: {
        exitCode: 0,
        complete: false,
        canary: true,
        dryRun: false,
        fixture: false,
        targets: 9,
        alarms: ["feed-overlap:gpu-radeon+gpu-rtx"],
      },
      authentication: "firebase-google",
    };
    const fetchMock = stubJson(body);

    const status = await marketplaceClient.getStatus(async () => "a-firebase-id-token");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/status");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer a-firebase-id-token");
    expect(status).toEqual(body);
  });

  /**
   * THE SIGNAL IS FORWARDED, PINNED AT THIS LAYER AS WELL AS THROUGH `App`. `apiClient` forwards
   * `options.signal` and nothing else, so a `getStatus` that accepted the parameter and dropped
   * it would leave the poll unbounded while `App`'s own call site still looked correct -- and the
   * displayed age's error would have no ceiling.
   */
  it("forwards an abort signal to /api/status, and sends none when given none", async () => {
    const fetchMock = stubJson({
      status: "ok",
      causes: [],
      reportedAt: 1_800_000_000,
      ageMinutes: 3,
      collector: null,
    });
    const controller = new AbortController();

    await marketplaceClient.getStatus(noToken, controller.signal);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);

    await marketplaceClient.getStatus(noToken);
    expect(fetchMock.mock.calls[1][1]?.signal).toBeUndefined();
  });

  it("passes a null collector through rather than inventing one", async () => {
    stubJson({
      status: "unknown",
      causes: [],
      reportedAt: 0,
      ageMinutes: 0,
      collector: null,
      authentication: "local-development",
    });

    const status = await marketplaceClient.getStatus(noToken);

    expect(status.collector).toBeNull();
    expect(status.status).toBe("unknown");
  });

  /**
   * THE PRE-ALERTING WORKER'S BODY IS REFUSED, NOT CAST. Its `status` is a known word, so a
   * check on `status` alone would pass it; `causes` and `collector` are what it lacks. The
   * mutation is returning the body unchecked.
   */
  it.each<[string, unknown]>([
    ["the old stub body", { status: "ok", phase: 2, authentication: "firebase-google" }],
    ["an unknown status word", { status: "fine", causes: [], reportedAt: 0, ageMinutes: 0, collector: null }],
    ["a collector without its counts", { status: "ok", causes: [], reportedAt: 0, ageMinutes: 0, collector: {} }],
    // EVERY OTHER FIELD VALID, so the `causes` check is the only thing that can refuse it.
    ["a body with no causes", { status: "ok", reportedAt: 0, ageMinutes: 0, collector: null }],
  ])("refuses %s as unreadable", async (_label, body) => {
    stubJson(body);

    await expect(marketplaceClient.getStatus(noToken)).rejects.toMatchObject({
      name: "ApiRequestError",
      kind: "unexpected",
    });
  });
});

/**
 * `notifications` (worker/notify/status.ts), checked on its own. A bad value costs the alert line,
 * never the poll: `getStatus` still resolves, so the rest of the panel renders.
 */
describe("the notifications field of /api/status", () => {
  const BODY = {
    status: "ok",
    causes: [],
    reportedAt: 1_800_000_000,
    ageMinutes: 3,
    collector: null,
    authentication: "firebase-google",
  };
  const COUNTS = { pending: 0, sent24h: 3, deliveryUnknown: 1, failed: 0, lastSentAt: 1_799_990_000 };

  /** C-n1: every shape the Worker really sends passes through untouched. */
  it.each<[string, unknown]>([
    ["unconfigured", { state: "unconfigured" }],
    ["invalid-url", { state: "invalid-url" }],
    ["off", { state: "off" }],
    ["on with counts", { state: "on", ...COUNTS }],
    ["on with nothing sent yet", { state: "on", ...COUNTS, sent24h: 0, lastSentAt: null }],
    ["webhook-rejected with counts", { state: "webhook-rejected", ...COUNTS }],
    // The Worker's answer when its table read fails. The mutation is requiring counts for `on`.
    ["on without counts", { state: "on" }],
  ])("C-n1: passes %s through unchanged", async (_label, notifications) => {
    stubJson({ ...BODY, notifications });

    expect(await marketplaceClient.getStatus(noToken)).toEqual({ ...BODY, notifications });
  });

  /**
   * C-n2: THE EXACT BODY AN API WORKER OLDER THAN #27 SENDS -- no `notifications` key at all --
   * comes back with no key, not with an invented state. The mutation is treating absent as
   * malformed, which would put "status unreadable" on every page served by an older Worker.
   */
  it("C-n2: an older Worker's body comes back with no notifications key", async () => {
    stubJson(BODY);

    const status = await marketplaceClient.getStatus(noToken);

    expect(status).toEqual(BODY);
    expect("notifications" in status).toBe(false);
  });

  /**
   * C-n3: A PRESENT BUT MALFORMED FIELD IS `unreadable`, AND THE POLL STILL SUCCEEDS. The two
   * mutations are returning the field unchecked (the panel would print a number the Worker never
   * sent, or nothing at all) and folding the check into `isCollectionStatus` (a bad alert field
   * would blank the whole panel to "could not be read" -- #20's F1 one level down).
   */
  it.each<[string, unknown]>([
    ["null", null],
    ["a number", 42],
    ["an unknown state", { state: "maybe" }],
    ["no state", { sent24h: 3 }],
    ["a count that is a string", { state: "on", ...COUNTS, sent24h: "3" }],
    ["a negative count", { state: "on", ...COUNTS, deliveryUnknown: -1 }],
    ["a fractional count", { state: "on", ...COUNTS, failed: 0.5 }],
    ["half the counts", { state: "on", sent24h: 3, deliveryUnknown: 1 }],
    ["a lastSentAt that is a string", { state: "on", ...COUNTS, lastSentAt: "yesterday" }],
    ["a rejected webhook without its counts", { state: "webhook-rejected" }],
  ])("C-n3: reads %s as unreadable without failing the poll", async (_label, notifications) => {
    stubJson({ ...BODY, notifications });

    const status = await marketplaceClient.getStatus(noToken);

    expect(status).toEqual({ ...BODY, notifications: { state: "unreadable" } });
  });

  /**
   * C-n4: THE FIELD IS REBUILT, NOT PASSED THROUGH. An inert state comes back as `{state}` alone
   * and a counted state with only its checked fields, so nothing unchecked reaches the panel.
   * The first row is review D's exact body: passed through, its `sent24h` threw a TypeError in
   * the panel and unmounted the app. The mutation is returning the checked field as received.
   */
  it.each<[string, unknown, unknown]>([
    [
      "an inert state carrying an unprintable count",
      { state: "off", sent24h: { toString: null, valueOf: null } },
      { state: "off" },
    ],
    ["an inert state carrying stray fields", { state: "unconfigured", note: "x" }, { state: "unconfigured" }],
    [
      "a counted state carrying stray fields",
      { state: "on", ...COUNTS, note: { toString: null } },
      { state: "on", ...COUNTS },
    ],
  ])("C-n4: rebuilds %s from the checked fields only", async (_label, notifications, expected) => {
    stubJson({ ...BODY, notifications });

    expect((await marketplaceClient.getStatus(noToken)).notifications).toEqual(expected);
  });
});
