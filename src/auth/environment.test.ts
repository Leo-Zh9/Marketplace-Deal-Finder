import { shouldUseLocalDevelopmentIdentity } from "./environment";

describe("local development identity selection", () => {
  it.each([
    [true, "localhost", true],
    [true, "127.0.0.1", true],
    [true, "::1", true],
    [true, "[::1]", true],
    [true, "app.pages.dev", false],
    [true, "localhost.evil.com", false],
    [true, "127.0.0.1.evil.com", false],
    [true, "192.168.1.10", false],
    [true, "0.0.0.0", false],
    [false, "localhost", false],
  ])("dev=%s on %s resolves to %s", (dev, hostname, expected) => {
    expect(shouldUseLocalDevelopmentIdentity({ dev, hostname })).toBe(expected);
  });
});
