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
});
