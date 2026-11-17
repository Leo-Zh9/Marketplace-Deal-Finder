import { useEffect, useState } from "react";
import { ApiRequestError } from "../auth/authTypes";

/**
 * THE CALLER'S DISCORD WEBHOOK, WRITE-ONLY (migrations/0010). The Worker never sends the stored URL
 * back -- `GET /api/webhook` is `{configured}` -- so this form cannot display it, and it clears the
 * field after a save so a pasted credential does not sit on screen.
 */
interface WebhookFormProps {
  load: () => Promise<{ configured: boolean }>;
  save: (url: string | null) => Promise<{ configured: boolean }>;
}

export function WebhookForm({ load, save }: WebhookFormProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "alert" | "status"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((body) => {
        if (!cancelled) setConfigured(body.configured);
      })
      .catch(() => {
        if (!cancelled) setNotice({ kind: "alert", text: "Could not read your webhook setting." });
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const submit = async (url: string | null) => {
    setPending(true);
    setNotice(null);
    try {
      const body = await save(url);
      setConfigured(body.configured);
      setDraft("");
      setNotice({ kind: "status", text: url === null ? "Webhook cleared." : "Webhook saved." });
    } catch (error: unknown) {
      setNotice({
        kind: "alert",
        text:
          error instanceof ApiRequestError && error.code === "INVALID_WEBHOOK"
            ? "That is not a Discord webhook URL. Copy it again from Discord."
            : "Could not save the webhook. Try again.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="collection-panel" aria-labelledby="webhook-heading" data-testid="webhook">
      <h2 id="webhook-heading">Discord webhook</h2>
      <p data-testid="webhook-state">
        {configured === null
          ? "Reading your webhook setting…"
          : configured
            ? "Your Discord webhook is configured."
            : "No Discord webhook is configured."}
      </p>
      <p className="muted-copy">
        In Discord, open Server Settings, then Integrations, then Webhooks, then New Webhook. Pick the
        channel, choose Copy Webhook URL, and paste it here. It is stored, never shown again.
      </p>
      <label className="custom-radius">
        <span>Discord webhook URL</span>
        <input
          autoComplete="off"
          placeholder="https://discord.com/api/webhooks/…"
          type="url"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button
          className="primary-button action-button"
          disabled={pending || draft.trim() === ""}
          type="button"
          onClick={() => void submit(draft.trim())}
        >
          Save webhook
        </button>
        <button
          className="secondary-button action-button"
          disabled={pending || configured !== true}
          type="button"
          onClick={() => void submit(null)}
        >
          Clear webhook
        </button>
      </div>
      {notice && (
        <p className="collection-notice" role={notice.kind}>
          {notice.text}
        </p>
      )}
    </section>
  );
}
