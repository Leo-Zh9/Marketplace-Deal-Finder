import { marketplaceClient, resetMarketplaceState } from "./marketplaceClient";
import type { Listing } from "../types";

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

const stubVerdicts = (listings: Listing[], truncated = false) => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ listings, truncated }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const settings = {
  components: [],
  models: {},
  location: null,
  radiusKm: 25,
  filters: {},
  dealRule: {
    type: "discount" as const,
    minimumDiscountPercent: 25,
    maximumPriceCad: "",
  },
};

afterEach(() => {
  resetMarketplaceState();
  vi.unstubAllGlobals();
});

describe("the read path", () => {
  const noToken = async () => null;

  it("keeps only the selected components and the selected models", async () => {
    stubVerdicts([
      row({ listingId: "wanted", modelKey: "GeForce RTX 5090" }),
      // Same component, a model the selection excludes.
      row({ listingId: "wrong-model", modelKey: "GeForce RTX 5080" }),
      // A model key the catalog never resolved: excluded by a narrowed selection.
      row({ listingId: "no-model", modelKey: null }),
      // Right model, wrong component.
      row({ listingId: "wrong-component", componentType: "cpu", modelKey: "GeForce RTX 5090" }),
    ]);

    const result = await marketplaceClient.preview(
      {
        ...settings,
        components: ["gpu"],
        models: { gpu: { mode: "selected", values: ["GeForce RTX 5090"] } },
      },
      noToken,
    );

    expect(result.listings.map((listing) => listing.listingId)).toEqual(["wanted"]);
  });

  it("carries the server's truncation flag through unchanged", async () => {
    stubVerdicts([row()], true);
    const result = await marketplaceClient.preview(
      { ...settings, components: ["gpu"] },
      noToken,
    );
    expect(result.truncated).toBe(true);
  });

  it("sends the identity token it was given", async () => {
    const fetchMock = stubVerdicts([]);
    await marketplaceClient.preview({ ...settings, components: ["gpu"] }, async () => "id-token");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/verdicts");
    expect(headers.get("Authorization")).toBe("Bearer id-token");
  });
});

describe("prototype marketplace state", () => {
  it("returns monitoring to a stopped state", async () => {
    await marketplaceClient.startMonitoring(settings);
    resetMarketplaceState();

    await expect(marketplaceClient.getMonitoringStatus()).resolves.toEqual({
      state: "STOPPED",
      provider: "AVAILABLE",
      lastSuccessfulScanAt: null,
      nextScanAt: null,
    });
  });

  it("activates monitoring when no reset intervenes", async () => {
    await expect(marketplaceClient.startMonitoring(settings)).resolves.toMatchObject({
      state: "ACTIVE",
    });
  });

  it("drops a start issued by a previous identity", async () => {
    const pending = marketplaceClient.startMonitoring(settings);
    resetMarketplaceState();
    await pending;

    await expect(marketplaceClient.getMonitoringStatus()).resolves.toMatchObject({
      state: "STOPPED",
      nextScanAt: null,
    });
  });
});
