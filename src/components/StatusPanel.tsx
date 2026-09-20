import type { MonitoringStatus } from "../types";

const formatTime = (value: string | null) => {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
};

interface StatusPanelProps {
  status: MonitoringStatus;
}

export function StatusPanel({ status }: StatusPanelProps) {
  const isActive = status.state === "ACTIVE";
  return (
    <section className="status-panel" aria-label="Monitoring status">
      <div className="status-panel__heading">
        <div>
          <p className="eyebrow">Monitoring</p>
          <h2>{isActive ? "Active" : "Not running"}</h2>
        </div>
        <span className={`live-indicator${isActive ? " live-indicator--active" : ""}`}>
          <span aria-hidden="true" />
          {isActive ? "Live" : "Stopped"}
        </span>
      </div>

      <dl className="status-list">
        <div>
          <dt>Facebook Marketplace</dt>
          <dd className={`provider-state provider-state--${status.provider.toLowerCase()}`}>
            {status.provider === "AVAILABLE" ? "Available" : status.provider.toLowerCase()}
          </dd>
        </div>
        <div>
          <dt>Last successful scan</dt>
          <dd>{formatTime(status.lastSuccessfulScanAt)}</dd>
        </div>
        <div>
          <dt>Next scan</dt>
          <dd>{isActive ? formatTime(status.nextScanAt) : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
