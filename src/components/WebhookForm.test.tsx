import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiRequestError } from "../auth/authTypes";
import { WebhookForm } from "./WebhookForm";

const HOOK = "https://discord.com/api/webhooks/123456789/secret-token_A";

describe("WebhookForm", () => {
  /**
   * WF-1. WRITE-ONLY ON SCREEN: the state comes from `{configured}`, a save clears the field, and the
   * pasted URL is nowhere in the document afterwards. Kills: keeping the draft after a save.
   */
  it("WF-1: shows not configured, saves, then shows configured with the field cleared", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (url: string | null) => ({ configured: url !== null }));
    render(<WebhookForm load={async () => ({ configured: false })} save={save} />);

    expect(await screen.findByText("No Discord webhook is configured.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Discord webhook URL"), HOOK);
    await user.click(screen.getByRole("button", { name: "Save webhook" }));

    expect(await screen.findByText("Your Discord webhook is configured.")).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(HOOK);
    expect(screen.getByLabelText<HTMLInputElement>("Discord webhook URL").value).toBe("");
    expect(document.body.innerHTML).not.toContain("secret-token");
  });

  /** WF-2. Clear sends null and is only offered when something is configured. */
  it("WF-2: Clear sends null", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => ({ configured: false }));
    render(<WebhookForm load={async () => ({ configured: true })} save={save} />);

    await screen.findByText("Your Discord webhook is configured.");
    await user.click(screen.getByRole("button", { name: "Clear webhook" }));

    expect(save).toHaveBeenCalledWith(null);
    expect(await screen.findByText("No Discord webhook is configured.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear webhook" })).toBeDisabled());
  });

  /** WF-3. A refused URL says what to do and does not repeat the value. */
  it("WF-3: INVALID_WEBHOOK is named in the page's words", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {
      throw new ApiRequestError("x", "unexpected", 400, "INVALID_WEBHOOK");
    });
    render(<WebhookForm load={async () => ({ configured: false })} save={save} />);

    await screen.findByText("No Discord webhook is configured.");
    await user.type(screen.getByLabelText("Discord webhook URL"), "https://evil.example/x");
    await user.click(screen.getByRole("button", { name: "Save webhook" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That is not a Discord webhook URL. Copy it again from Discord.",
    );
    expect(screen.getByRole("alert").textContent).not.toContain("evil");
  });
});
