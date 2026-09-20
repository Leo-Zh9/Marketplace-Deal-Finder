import { componentById } from "../data/catalog";
import type { EvaluationStatus, Listing } from "../types";

const statusLabels: Record<EvaluationStatus, string> = {
  DEAL: "Deal",
  NOT_A_DEAL: "Not a deal",
  NEEDS_REVIEW: "Needs review",
  PENDING: "Pending",
};

const formatCurrency = (cents: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  }).format(cents / 100);

const formatRelativeTime = (value: string) => {
  const minutes = Math.max(
    1,
    Math.round((Date.now() - new Date(value).getTime()) / 60_000),
  );
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr${hours === 1 ? "" : "s"} ago`;
};

interface ListingCardProps {
  listing: Listing;
}

export function ListingCard({ listing }: ListingCardProps) {
  const component = componentById[listing.componentType];

  return (
    <article
      className={`listing-card listing-card--${listing.evaluation.status.toLowerCase()}`}
    >
      <div className="listing-card__topline">
        <span className="component-tag">{component.label}</span>
        <span className={`status-badge status-badge--${listing.evaluation.status.toLowerCase()}`}>
          {statusLabels[listing.evaluation.status]}
        </span>
      </div>

      <div className="listing-card__main">
        <div>
          <h3>{listing.title}</h3>
          <p className="model-name">
            {listing.modelKey ?? "Model not identified"}
            {listing.variantKey ? ` · ${listing.variantKey}` : ""}
          </p>
        </div>
        <p className="listing-price">{formatCurrency(listing.priceCents)}</p>
      </div>

      {(listing.evaluation.averagePriceCents || listing.evaluation.discountPercent) && (
        <dl className="price-comparison">
          {listing.evaluation.averagePriceCents && (
            <div>
              <dt>Market average</dt>
              <dd>{formatCurrency(listing.evaluation.averagePriceCents)}</dd>
            </div>
          )}
          {listing.evaluation.discountPercent !== undefined && (
            <div>
              <dt>Estimated discount</dt>
              <dd>{listing.evaluation.discountPercent.toFixed(1)}%</dd>
            </div>
          )}
        </dl>
      )}

      {listing.evaluation.reason && (
        <p className="evaluation-reason">{listing.evaluation.reason}</p>
      )}

      <div className="listing-card__footer">
        <p>
          <strong>{listing.location ?? "Location unavailable"}</strong>
          <span>
            {listing.distanceKm !== null ? `${listing.distanceKm.toFixed(1)} km away · ` : ""}
            Seen {formatRelativeTime(listing.observedAt)}
          </span>
        </p>
        <a href={listing.url} target="_blank" rel="noreferrer">
          View on Facebook
          <span aria-hidden="true"> ↗</span>
        </a>
      </div>
    </article>
  );
}
