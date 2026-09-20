import { marketplaceClient, resetMarketplaceState } from "./marketplaceClient";

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
