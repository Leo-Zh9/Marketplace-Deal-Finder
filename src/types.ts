export type ComponentType =
  | "cpu"
  | "cpu_cooler"
  | "motherboard"
  | "ram"
  | "storage"
  | "gpu"
  | "psu"
  | "case"
  | "case_fans";

export type DealRuleType = "discount" | "maximum_price" | "both";

export type EvaluationStatus =
  | "DEAL"
  | "NOT_DEAL"
  | "NEEDS_REVIEW"
  | "PENDING";

export type MonitoringState =
  | "STOPPED"
  | "STARTING"
  | "ACTIVE"
  | "DEGRADED"
  | "ERROR";

export interface SearchLocation {
  label: string;
  latitude: number;
  longitude: number;
}

export interface ModelSelection {
  mode: "all" | "none" | "selected";
  values: string[];
}

export interface DealRule {
  type: DealRuleType;
  minimumDiscountPercent: number;
  maximumPriceCad: string;
}

export interface SearchSettings {
  components: ComponentType[];
  models: Partial<Record<ComponentType, ModelSelection>>;
  location: SearchLocation | null;
  radiusKm: number;
  filters: Partial<Record<ComponentType, Record<string, string>>>;
  dealRule: DealRule;
}

export interface Listing {
  source: string;
  listingId: string;
  componentType: ComponentType;
  modelKey: string | null;
  variantKey: string | null;
  title: string;
  priceCents: number | null;
  location: string | null;
  url: string;
  observedAt: string;
  evaluation: {
    status: EvaluationStatus;
    averagePriceCents?: number;
    discountPercent?: number;
  };
}

export interface MonitoringStatus {
  state: MonitoringState;
  provider: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  lastSuccessfulScanAt: string | null;
  nextScanAt: string | null;
}

export interface PreviewResult {
  listings: Listing[];
  truncated: boolean;
  searchedAt: string;
}
