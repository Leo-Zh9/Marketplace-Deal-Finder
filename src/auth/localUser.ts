/**
 * A SECOND LOCAL IDENTITY, DEVELOPMENT ONLY. `?as=<name>` on the dev page stores `<name>` for this tab
 * (sessionStorage), and every API call then sends `X-Local-User: <name>`, which a local Worker on a
 * loopback host reads as `<name>@localhost` (worker/auth/verifyFirebaseToken.ts). `?as=` with an
 * empty value returns the tab to the default local identity.
 *
 * A production build never sends the header -- `dev` is `import.meta.env.DEV` -- and a production
 * Worker never reads it. The Worker's pattern is repeated here so a typo is dropped in the browser
 * rather than answered 401 on every call.
 */

export const LOCAL_USER_KEY = "undercut.localUser";
const LOCAL_USER_PATTERN = /^[a-z0-9-]{1,20}$/;

/** Storage can throw (private mode, blocked site data); a failure is "no second identity". */
const safely = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

export const captureLocalUser = (search: string, storage: Storage): void => {
  const name = new URLSearchParams(search).get("as");
  if (name === null) return;
  safely(() => {
    if (name === "") storage.removeItem(LOCAL_USER_KEY);
    else if (LOCAL_USER_PATTERN.test(name)) storage.setItem(LOCAL_USER_KEY, name);
  }, undefined);
};

export const localUserFor = (dev: boolean, storage: Storage | undefined): string | null => {
  if (!dev || storage === undefined) return null;
  const name = safely(() => storage.getItem(LOCAL_USER_KEY), null);
  return name !== null && LOCAL_USER_PATTERN.test(name) ? name : null;
};
