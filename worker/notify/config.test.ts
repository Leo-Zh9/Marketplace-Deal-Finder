// @vitest-environment node

import { isValidWebhookUrl, resolveNotifyConfig } from "./config";

const GOOD = "https://discord.com/api/webhooks/123456789012345678/AbC-dEf_123";

describe("isValidWebhookUrl", () => {
  /**
   * U1. PRODUCTION ACCEPTS EXACTLY THE FOUR DISCORD HOSTS OVER HTTPS. Kills: a suffix or
   * substring host match, accepting http, accepting a port, and the path pattern dropped.
   */
  it.each([
    ["discord.com", GOOD],
    ["discordapp.com", "https://discordapp.com/api/webhooks/1/tok"],
    ["ptb.discord.com", "https://ptb.discord.com/api/webhooks/1/tok"],
    ["canary.discord.com", "https://canary.discord.com/api/webhooks/1/tok"],
  ])("U1: production accepts %s", (_label, url) => {
    expect(isValidWebhookUrl(url, "production")).toBe(true);
  });

  it.each([
    ["plain http", "http://discord.com/api/webhooks/1/tok"],
    ["a look-alike host", "https://discord.com.evil.example/api/webhooks/1/tok"],
    ["a sub-domain not on the list", "https://evil.discord.com/api/webhooks/1/tok"],
    ["credentials before the host", "https://discord.com@evil.example/api/webhooks/1/tok"],
    ["a port", "https://discord.com:8443/api/webhooks/1/tok"],
    ["a non-numeric id", "https://discord.com/api/webhooks/abc/tok"],
    ["no token", "https://discord.com/api/webhooks/1/"],
    ["a path after the token", "https://discord.com/api/webhooks/1/tok/slack"],
    ["a query", "https://discord.com/api/webhooks/1/tok?thread_id=2"],
    ["a fragment", "https://discord.com/api/webhooks/1/tok#x"],
    ["another API path", "https://discord.com/api/channels/1/messages"],
    ["the local stub", "http://127.0.0.1:8798/api/webhooks/1/e2e"],
    ["not a URL", "discord.com/api/webhooks/1/tok"],
  ])("U2: production rejects %s", (_label, url) => {
    expect(isValidWebhookUrl(url, "production")).toBe(false);
  });

  /**
   * U3. THE LOCAL EXCEPTION IS 127.0.0.1 OVER HTTP, AND ONLY WHEN APP_ENV IS "local". Kills: the
   * exception keyed on anything but APP_ENV, and widening it to any http host.
   */
  it("U3: local accepts the 127.0.0.1 stub; production and an absent APP_ENV do not", () => {
    const stub = "http://127.0.0.1:8798/api/webhooks/1/e2e";
    expect(isValidWebhookUrl(stub, "local")).toBe(true);
    expect(isValidWebhookUrl(stub, undefined)).toBe(false);
    expect(isValidWebhookUrl(stub, "production")).toBe(false);
    expect(isValidWebhookUrl("http://localhost:8798/api/webhooks/1/e2e", "local")).toBe(false);
    expect(isValidWebhookUrl("http://127.0.0.1/api/webhooks/1/e2e", "local")).toBe(false);
    expect(isValidWebhookUrl("http://evil.example:8798/api/webhooks/1/e2e", "local")).toBe(false);
    // The production rule still applies locally.
    expect(isValidWebhookUrl(GOOD, "local")).toBe(true);
  });
});

describe("resolveNotifyConfig", () => {
  /**
   * U4. THE PRECEDENCE: unconfigured, invalid-url, off, on. Only the exact string "on" enables.
   * Kills: the switch checked before the URL (a bad URL with the switch on would read `on`), and a
   * case-insensitive or truthy switch.
   */
  it.each<[string, Record<string, string | undefined>, string]>([
    ["no URL", { NOTIFICATIONS: "on" }, "unconfigured"],
    ["an empty URL", { DISCORD_WEBHOOK_URL: "   ", NOTIFICATIONS: "on" }, "unconfigured"],
    ["a bad URL, switch on", { DISCORD_WEBHOOK_URL: "https://evil.example/x", NOTIFICATIONS: "on" }, "invalid-url"],
    ["a bad URL, switch off", { DISCORD_WEBHOOK_URL: "https://evil.example/x" }, "invalid-url"],
    ["a good URL, no switch", { DISCORD_WEBHOOK_URL: GOOD }, "off"],
    ["a good URL, switch ON", { DISCORD_WEBHOOK_URL: GOOD, NOTIFICATIONS: "ON" }, "off"],
    ["a good URL, switch true", { DISCORD_WEBHOOK_URL: GOOD, NOTIFICATIONS: "true" }, "off"],
    ["a good URL, switch on", { DISCORD_WEBHOOK_URL: GOOD, NOTIFICATIONS: "on" }, "on"],
  ])("U4: %s -> %s", (_label, environment, state) => {
    expect(resolveNotifyConfig({ APP_ENV: "production", ...environment }).state).toBe(state);
  });

  /**
   * U6. THE URL THAT IS SENT IS REBUILT FROM THE PARSE. A trailing `?` or `#` passes validation
   * (both parse as empty), so it must not reach the request. Kills: returning the raw string.
   */
  it.each(["?", "#", "?#"])("U6: a trailing %s is dropped from the sendable URL", (suffix) => {
    expect(
      resolveNotifyConfig({ APP_ENV: "production", DISCORD_WEBHOOK_URL: `${GOOD}${suffix}`, NOTIFICATIONS: "on" }),
    ).toEqual({ state: "on", url: GOOD });
  });

  it("U5: a pasted URL with a trailing newline is accepted as the trimmed URL", () => {
    expect(
      resolveNotifyConfig({ APP_ENV: "production", DISCORD_WEBHOOK_URL: `${GOOD}\n`, NOTIFICATIONS: "on" }),
    ).toEqual({ state: "on", url: GOOD });
  });
});
