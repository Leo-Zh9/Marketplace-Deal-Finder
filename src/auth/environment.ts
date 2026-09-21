/** Exact set. No substring or suffix matching. */
export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "[::1]";

export const shouldUseLocalDevelopmentIdentity = (env: {
  dev: boolean;
  hostname: string;
}): boolean => env.dev && isLoopbackHostname(env.hostname);
