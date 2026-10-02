import { render, screen } from "@testing-library/react";
import { ListingCard } from "./ListingCard";
import { componentCatalog } from "../data/catalog";
import type { EvaluationStatus, Listing } from "../types";

const row = (over: Partial<Listing> = {}): Listing => ({
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
  evaluation: { status: "DEAL" },
  ...over,
});

describe("ListingCard", () => {
  /**
   * ITERATES `componentCatalog`, AND THAT IS THE POINT. The first version of this guard lived
   * in App.test.tsx and clicked two checkboxes, so `marketplaceClient.preview`'s client-side
   * component filter dropped the other seven listings before a card rendered: MEASURED, making
   * `componentById` miss `psu` left the whole suite green (1096 passing) while a `psu` card
   * would have thrown. Rendering the card directly, over the catalog itself, cannot drift from
   * the catalog's length — add a tenth component and this covers it with no edit.
   *
   * The crash it guards is `componentById[listing.componentType].label` on an unchecked
   * `Object.fromEntries(...) as Record<ComponentType, ComponentDefinition>`
   * (src/data/catalog.ts): a miss is `undefined.label`, a TypeError, and with no error boundary
   * anywhere in src/ that is the whole dashboard, not one bad card.
   */
  it.each(componentCatalog.map((component) => [component.id, component.label] as const))(
    "renders a card for %s without reaching an undefined catalog entry",
    (componentType, label) => {
      render(<ListingCard listing={row({ componentType, title: `card for ${componentType}` })} />);
      expect(screen.getByRole("heading", { name: `card for ${componentType}` })).toBeInTheDocument();
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  it("covers every component the catalog declares", () => {
    expect(componentCatalog).toHaveLength(9);
  });

  it.each([
    ["DEAL", "Deal", "Meets your deal rule."],
    ["NOT_DEAL", "Not a deal", "Does not meet your deal rule."],
    ["NEEDS_REVIEW", "Needs review", "Could not be judged automatically -- check this one yourself."],
    ["PENDING", "Pending", "Waiting to be evaluated."],
  ] as Array<[EvaluationStatus, string, string]>)(
    "labels %s and explains it without naming a cause",
    (status, badge, hint) => {
      render(<ListingCard listing={row({ evaluation: { status } })} />);
      expect(screen.getByText(badge)).toBeInTheDocument();
      expect(screen.getByText(hint)).toBeInTheDocument();
    },
  );

  it("renders a null price as unpriced and a zero price as free", () => {
    const unpriced = render(<ListingCard listing={row({ priceCents: null })} />);
    expect(screen.getByText("No price listed")).toBeInTheDocument();
    unpriced.unmount();

    render(<ListingCard listing={row({ priceCents: 0 })} />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  /**
   * BOTH SIGNS, because the orchestrator's show-everything ruling puts NOT_DEAL rows on screen
   * and a price above the market average is then the common case. The label must be true of a
   * negative number, so it is "vs. market average" and not "Estimated discount".
   */
  it.each([
    ["below the average", 150000, "50.0%"],
    ["above the average", 450000, "-50.0%"],
  ])("states the comparison for a price %s", (_label, priceCents, rendered) => {
    render(
      <ListingCard
        listing={row({
          priceCents,
          evaluation: {
            status: "NOT_DEAL",
            averagePriceCents: 300000,
            discountPercent: ((300000 - priceCents) / 300000) * 100,
          },
        })}
      />,
    );
    expect(screen.getByText("vs. market average")).toBeInTheDocument();
    expect(screen.getByText(rendered)).toBeInTheDocument();
  });

  /**
   * THE COMBINATION PRODUCTION REACHES AND NO FIXTURE HAD: an average WITH NO DISCOUNT.
   * `worker/api/listings.ts` deliberately stores an unparseable or missing price as NULL rather
   * than refusing the listing -- the policy this slice cites to narrow `priceCents` -- and
   * `discountPercentFrom` returns null whenever the price is null. So an ordinary
   * "GPU, message me for price" on a model with MINIMUM_REFERENCE_COUNT comparables ships
   * `{averagePriceCents: 300000}` and no `discountPercent`, through the LIVE write path and no
   * hand-written SQL.
   *
   * MEASURED: with every other fixture supplying both values or neither, removing the
   * `discountPercent !== undefined` guard left the suite green (84 passed) while this listing
   * threw `TypeError: Cannot read properties of undefined (reading 'toFixed')` -- a blank
   * dashboard, no error boundary. This case is that guard's only killer, and it is also what
   * makes the inner `averagePriceCents &&` guard killable on its own.
   */
  it("shows the average alone when the listing has no price to compare", () => {
    render(
      <ListingCard
        listing={row({ priceCents: null, evaluation: { status: "PENDING", averagePriceCents: 300000 } })}
      />,
    );
    expect(screen.getByText("Market average")).toBeInTheDocument();
    expect(screen.getByText("$3,000.00")).toBeInTheDocument();
    expect(screen.queryByText("vs. market average")).not.toBeInTheDocument();
    expect(screen.getByText("No price listed")).toBeInTheDocument();
  });

  it("shows no comparison at all when the endpoint withheld one", () => {
    render(<ListingCard listing={row({ evaluation: { status: "PENDING" } })} />);
    expect(screen.queryByText("Market average")).not.toBeInTheDocument();
    expect(screen.queryByText("vs. market average")).not.toBeInTheDocument();
  });

});
