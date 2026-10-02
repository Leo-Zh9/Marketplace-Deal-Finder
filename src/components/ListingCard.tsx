import { componentById } from "../data/catalog";
import type { EvaluationStatus, Listing } from "../types";

const statusLabels: Record<EvaluationStatus, string> = {
  DEAL: "Deal",
  NOT_DEAL: "Not a deal",
  NEEDS_REVIEW: "Needs review",
  PENDING: "Pending",
};

/**
 * DERIVED FROM THE STATUS, NEVER SERVED. 3D persists `verdict` and not `reason`
 * (worker/evaluation/types.ts), so these sentences must claim nothing the status does not
 * already say -- naming a reason here would invent one.
 *
 * NOT "YOUR deal rule", WHICH BROKE THAT RULE ONE LINE BELOW WHERE IT IS STATED. The word
 * `your` claims the verdict was computed against the rule on this screen, and this page never
 * sends one: there is no `/api/settings` call anywhere in the frontend, so the form starts from
 * `initialSettings` and disagrees with whatever revision the collector was actually seeded with
 * from the first render onwards. "Judged" claims only what the status says -- that a judgement
 * exists -- and stays true whoever owns the rule it was judged against.
 */
const statusHints: Record<EvaluationStatus, string> = {
  DEAL: "Judged a deal.",
  NOT_DEAL: "Judged not a deal.",
  NEEDS_REVIEW: "Could not be judged automatically -- check this one yourself.",
  PENDING: "Waiting to be evaluated.",
};

const formatCurrency = (cents: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  }).format(cents / 100);

/** `listings.price_cents` is nullable: an unparseable price is stored as NULL. */
const formatPrice = (cents: number | null) =>
  cents === null ? "No price listed" : formatCurrency(cents);

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
        <p className="listing-price">{formatPrice(listing.priceCents)}</p>
      </div>

      {(listing.evaluation.averagePriceCents || listing.evaluation.discountPercent) && (
        <dl className="price-comparison">
          {/* UNREACHABLE AND KEPT AS DEFENCE IN DEPTH, the same way
              worker/api/listings.ts:433-435 keeps and labels its own: the endpoint never serves
              a discount without an average, so the outer guard already covers every case this
              one can see. MEASURED: no mutation kills it. worker/api/verdicts.test.ts V-20 is
              what pins the invariant that makes that true, at the layer that could break it. */}
          {listing.evaluation.averagePriceCents && (
            <div>
              <dt>Market average</dt>
              <dd>{formatCurrency(listing.evaluation.averagePriceCents)}</dd>
            </div>
          )}
          {listing.evaluation.discountPercent !== undefined && (
            <div>
              {/* THE DIRECTION IS A WORD, NOT A SIGN. "vs. market average  -50.0%" rendered for
                  a listing FIFTY PERCENT MORE EXPENSIVE than the market, and a negative number
                  under a neutral label is ambiguous in both directions -- worse than the
                  "Estimated discount" it replaced, which was at least wrong in only one. Under
                  the show-everything ruling NOT_DEAL is the commonest card, so the above-market
                  case is the common one and it is the one that must not misread. `above`/`below`
                  is unreadable backwards; `Math.abs` is what keeps the minus sign off the page.
                  A discount of exactly 0 reads "0.0% below", which is true. */}
              <dt>vs. market average</dt>
              <dd>
                {`${Math.abs(listing.evaluation.discountPercent).toFixed(1)}% ${
                  listing.evaluation.discountPercent < 0 ? "above" : "below"
                }`}
              </dd>
            </div>
          )}
        </dl>
      )}

      <p className="evaluation-reason">{statusHints[listing.evaluation.status]}</p>

      <div className="listing-card__footer">
        <p>
          <strong>{listing.location ?? "Location unavailable"}</strong>
          <span>Seen {formatRelativeTime(listing.observedAt)}</span>
        </p>
        <a href={listing.url} target="_blank" rel="noreferrer">
          View on Facebook
          <span aria-hidden="true"> ↗</span>
        </a>
      </div>
    </article>
  );
}
