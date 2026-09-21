import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { AuthenticatedIdentity } from "./auth/authTypes";

describe("Marketplace Deal Finder", () => {
  it("shows required-field errors when preview is submitted empty", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(screen.getByText("Select at least one component.")).toBeInTheDocument();
    expect(screen.getByText("Choose a location.")).toBeInTheDocument();
  });

  it("previews matching Facebook listings", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.type(screen.getByLabelText("Search location"), "Toronto");
    await user.click(screen.getByRole("button", { name: "Toronto, ON" }));
    await user.click(screen.getByRole("button", { name: "Preview listings" }));

    expect(
      await screen.findByRole("heading", { name: "ASUS Dual RTX 4070 Super 12GB" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 result")).toBeInTheDocument();
  });

  it("starts and stops the mock monitor", async () => {
    const user = userEvent.setup();
    render(<App />);

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
    render(<App />);

    await user.click(screen.getByRole("checkbox", { name: /^GPU:/i }));
    await user.click(screen.getByText("GPU models"));

    const selectAll = screen.getByRole("checkbox", {
      name: /Select all 23 models/i,
    });
    const excludedModel = screen.getByRole("checkbox", {
      name: "GeForce RTX 5090",
    });

    expect(selectAll).toBeChecked();
    expect(excludedModel).toBeChecked();
    await user.click(excludedModel);
    expect(selectAll).not.toBeChecked();
    expect(screen.getByText("22 of 23 models")).toBeInTheDocument();
  });

  it("infers the combined deal rule from two checked criteria", async () => {
    const user = userEvent.setup();
    render(<App />);

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
    render(<App />);

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

    const anonymous = render(<App />);
    expect(screen.queryByText("owner@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    anonymous.unmount();

    const local = render(<App identity={identity} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    local.unmount();

    render(<App identity={identity} onSignOut={onSignOut} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
