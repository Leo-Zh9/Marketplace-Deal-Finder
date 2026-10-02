import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { AuthenticatedIdentity } from "./auth/authTypes";
import type { Listing } from "./types";

const wireListing = (over: Partial<Listing> = {}): Listing => ({
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
  evaluation: { status: "DEAL", averagePriceCents: 420000, discountPercent: 28.57 },
  ...over,
});

/** Explicit at every call site: each test says which identity it runs under. */
const noToken = async () => null;

/** The real client and the real transport run; only the wire is stubbed. */
const stubVerdicts = (body: { listings: Listing[]; truncated: boolean }) => {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Marketplace Deal Finder", () => {
  it("shows required-field errors when preview is submitted empty", async () => {
    const user = userEvent.setup();
    render(<App getToken={noToken} />);

    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(screen.getByText("Select at least one component.")).toBeInTheDocument();
    expect(screen.getByText("Choose a location.")).toBeInTheDocument();
  });

  /**
   * LINK THREE OF THE TOKEN CHAIN. The first version of this test captured `calls[0][0]` and
   * never looked at `calls[0][1]`, so `preview(settings, noToken)` left the whole frontend
   * suite green (MEASURED, 64 passing) while production answered 401 on every preview forever.
   * The header is what makes the chain observable from this end.
   */
  it("previews the listings the server returns, asking the right path WITH the token", async () => {
    const user = userEvent.setup();
    const fetchMock = stubVerdicts({
      listings: [wireListing(), wireListing({ listingId: "cpu-1", componentType: "cpu" })],
      truncated: false,
    });
    render(<App getToken={async () => "tok-123"} />);

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(
      await screen.findByRole("heading", { name: "ASUS ROG Astral RTX 5080" }),
    ).toBeInTheDocument();
    // The CPU row came back from the server and is filtered out by the component selection.
    expect(screen.getByText("1 result")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/verdicts");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer tok-123",
    );
    expect(screen.getByText("Deal")).toBeInTheDocument();
    expect(screen.getByText("$3,000.00")).toBeInTheDocument();
    expect(screen.getByText("Meets your deal rule.")).toBeInTheDocument();
  });

  it("shows a bounded page as bounded, a null price as unpriced, and every status", async () => {
    const user = userEvent.setup();
    stubVerdicts({
      listings: [
        wireListing({ listingId: "a", evaluation: { status: "DEAL" } }),
        wireListing({ listingId: "b", evaluation: { status: "NOT_DEAL" } }),
        wireListing({ listingId: "c", evaluation: { status: "NEEDS_REVIEW" } }),
        wireListing({ listingId: "d", priceCents: null, evaluation: { status: "PENDING" } }),
      ],
      truncated: true,
    });
    render(<App getToken={noToken} />);

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(await screen.findByText("4+ results")).toBeInTheDocument();
    expect(screen.getByText("No price listed")).toBeInTheDocument();
    for (const label of ["Deal", "Not a deal", "Needs review", "Pending"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("Waiting to be evaluated.")).toBeInTheDocument();
  });

  /**
   * THE READER FOR `source`, ASSERTED WHERE THE KEY ACTUALLY IS.
   * `source` is on the wire on one stated ground: the row's identity is `(source, listing_id)`
   * (migrations/0001), so the list key must carry both. My first version of this test built the
   * key inside the test body and MEASURED as vacuous -- reverting `App.tsx` to
   * `key={listing.listingId}` left the whole frontend suite green, because the test was
   * exercising React rather than App. This one previews two rows that share a `listingId`
   * across two sources and lets App's own key expression run: React 19 calls `console.error`
   * once with "Encountered two children with the same key" if the key drops `source`.
   */
  it("keys the list on (source, listingId), so two sources cannot collide", async () => {
    const user = userEvent.setup();
    stubVerdicts({
      listings: [
        wireListing({ source: "facebook-marketplace", listingId: "SAME", title: "from facebook" }),
        wireListing({ source: "ebay", listingId: "SAME", title: "from ebay" }),
      ],
      truncated: false,
    });
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => errors.push(String(args[0])));
    render(<App getToken={noToken} />);

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(await screen.findByRole("heading", { name: "from facebook" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "from ebay" })).toBeInTheDocument();
    spy.mockRestore();
    expect(errors.filter((message) => message.includes("same key"))).toEqual([]);
  });

  it("starts and stops the mock monitor", async () => {
    const user = userEvent.setup();
    render(<App getToken={noToken} />);

    await user.click(screen.getByRole("checkbox", { name: /^CPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Waterloo");
    await user.click(screen.getByRole("button", { name: "Waterloo, ON" }));
    await user.click(screen.getByRole("button", { name: "Start monitoring" }));

    expect(await screen.findByText("Live")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop monitoring" }));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
  });

  it("selects every model by default and supports all except one", async () => {
    const user = userEvent.setup();
    render(<App getToken={noToken} />);

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.click(screen.getByText("GPU models"));

    const selectAll = screen.getByRole("checkbox", {
      name: /Select all 68 models/i,
    });
    const excludedModel = screen.getByRole("checkbox", {
      name: "GeForce RTX 5090",
    });

    expect(selectAll).toBeChecked();
    expect(excludedModel).toBeChecked();
    await user.click(excludedModel);
    expect(selectAll).not.toBeChecked();
    expect(screen.getByText("67 of 68 models")).toBeInTheDocument();
  });

  it("infers the combined deal rule from two checked criteria", async () => {
    const user = userEvent.setup();
    render(<App getToken={noToken} />);

    const discount = screen.getByRole("checkbox", { name: /Minimum discount/i });
    const maximum = screen.getByRole("checkbox", { name: /Maximum price/i });

    expect(discount).toBeChecked();
    expect(maximum).not.toBeChecked();
    await user.click(maximum);
    expect(discount).toBeChecked();
    expect(maximum).toBeChecked();
    expect(screen.getByText("Maximum price (CAD)")).toBeInTheDocument();
  });

  it("finds small municipalities, postal codes, and address fixtures", async () => {
    const user = userEvent.setup();
    render(<App getToken={noToken} />);

    const locationSearch = screen.getByLabelText("Search location");
    await user.type(locationSearch, "N0B");
    expect(screen.getByRole("button", { name: "St. Jacobs, ON" })).toBeInTheDocument();

    await user.clear(locationSearch);
    await user.type(locationSearch, "200 University Avenue");
    expect(
      screen.getByRole("button", {
        name: "200 University Avenue W, Waterloo, ON N2L 3G1",
      }),
    ).toBeInTheDocument();
  });

  it("shows the account bar only when an identity is supplied", async () => {
    const user = userEvent.setup();
    const identity: AuthenticatedIdentity = {
      email: "owner@example.com",
      subject: "firebase-uid-1",
      expiresAt: 1_800_003_600,
      authenticationMethod: "firebase-google",
    };
    const onSignOut = vi.fn();

    const anonymous = render(<App getToken={noToken} />);
    expect(screen.queryByText("owner@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    anonymous.unmount();

    const local = render(<App identity={identity} getToken={noToken} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    local.unmount();

    render(<App identity={identity} onSignOut={onSignOut} getToken={noToken} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
