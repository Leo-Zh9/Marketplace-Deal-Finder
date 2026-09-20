import { mockListings } from "../data/mockListings";
import type {
  ComponentType,
  MonitoringStatus,
  PreviewResult,
  SearchSettings,
} from "../types";

export interface MarketplaceClient {
  preview(settings: SearchSettings): Promise<PreviewResult>;
  getMonitoringStatus(): Promise<MonitoringStatus>;
  startMonitoring(settings: SearchSettings): Promise<MonitoringStatus>;
  stopMonitoring(): Promise<MonitoringStatus>;
}

const wait = (duration = 450) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, duration));

const getMockScenario = () =>
  new URLSearchParams(window.location.search).get("scenario");

const dateInMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

let monitoringStatus: MonitoringStatus = {
  state: "STOPPED",
  provider: "AVAILABLE",
  lastSuccessfulScanAt: null,
  nextScanAt: null,
};

const matchesModelSelection = (
  component: ComponentType,
  model: string | null,
  settings: SearchSettings,
) => {
  const selection = settings.models[component];
  if (!selection || selection.mode === "all") return true;
  if (selection.mode === "none") return false;
  return model !== null && selection.values.includes(model);
};

export const marketplaceClient: MarketplaceClient = {
  async preview(settings) {
    await wait();

    const scenario = getMockScenario();
    if (scenario === "error") {
      throw new Error("Simulated provider error");
    }
    if (scenario === "unavailable") {
      return {
        listings: [],
        provider: "UNAVAILABLE",
        searchedAt: new Date().toISOString(),
      };
    }

    const listings = mockListings.filter(
      (listing) =>
        settings.components.includes(listing.componentType) &&
        matchesModelSelection(
          listing.componentType,
          listing.modelKey,
          settings,
        ),
    );

    return {
      listings,
      provider: "AVAILABLE",
      searchedAt: new Date().toISOString(),
    };
  },

  async getMonitoringStatus() {
    await wait(100);
    if (getMockScenario() === "unavailable") {
      return { ...monitoringStatus, provider: "UNAVAILABLE" };
    }
    return monitoringStatus;
  },

  async startMonitoring() {
    await wait();
    monitoringStatus = {
      state: "ACTIVE",
      provider: "AVAILABLE",
      lastSuccessfulScanAt: new Date().toISOString(),
      nextScanAt: dateInMinutes(30),
    };
    return monitoringStatus;
  },

  async stopMonitoring() {
    await wait(250);
    monitoringStatus = {
      ...monitoringStatus,
      state: "STOPPED",
      nextScanAt: null,
    };
    return monitoringStatus;
  },
};
