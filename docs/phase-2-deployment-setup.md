# Phase 2 deployment setup

Firebase Google sign-in in front of a Cloudflare Worker API, with an email
allowlist held as a Worker secret.

Status: **ready for deployed verification.** This runbook was executed end to end against real
Firebase and real Cloudflare on 2026-09-20; what was observed is recorded in "Deployed
acceptance checks". The phase is **not** complete: six of the seventeen checks there are
unticked — token refresh, a controlled expiry or refresh failure, a page refresh while signed
in, `/api/status` reporting `firebase-google` on the deployed Worker, the Worker's own
security headers on its own responses, and authentication and network errors staying distinct
from the sample provider states. None of the six has been observed.

No Cloudflare Zero Trust organization, Cloudflare Access policy, service-account
private key, custom domain, credit card, or paid upgrade is required.

Local development needs none of this: `npm run dev:full` runs with no Firebase
project and no secrets, using the Worker's `local-development` identity.

## Deployed instance (2026-09-20)

- App origin: `https://marketplace-deal-finder.leozhang07.workers.dev`
- Worker/API origin: `https://marketplace-deal-finder-api.leozhang07.workers.dev`
- Firebase project id: `marketplace-deal-finder` (auth domain
  `marketplace-deal-finder.firebaseapp.com`)
- Allowlist: one address, held as the Worker secret `APPROVED_EMAILS`. It is not in this
  repository and must never be.

**This deployment is on `*.workers.dev`, and that is not the default.** wrangler 4.x (this
repo pins `^4.131.0`) redirects `wrangler pages deploy` and `wrangler pages project create`
into an ordinary Workers deploy when it detects an AI-agent environment and the target Pages
project does not yet exist. An agent ran these commands, so this project is a Workers assets
project on `https://<project-name>.<account-subdomain>.workers.dev`. Classic Pages has not
gone away: the same commands in an ordinary terminal create a Pages project on a
`*.pages.dev` origin. The warning in step 3 has the mechanism and the opt-out. `_headers` is
honoured either way — gate 2 read the deployed CSP back off the live site. Nothing else below
is changed by this.

---

## What you must supply

| # | Value or action | Name | Where it is set |
|---|---|---|---|
| 1 | Firebase project on the **Spark** (free) plan with a registered **Web app** | — | Firebase console |
| 2 | Web app `apiKey` | `VITE_FIREBASE_API_KEY` | Build environment, exported locally before npm run build (step 6) |
| 3 | Web app `authDomain` (usually `<projectId>.firebaseapp.com`) | `VITE_FIREBASE_AUTH_DOMAIN` | Build environment, exported locally before npm run build (step 6) |
| 4 | Web app `projectId` — must equal #6 exactly | `VITE_FIREBASE_PROJECT_ID` | Build environment, exported locally before npm run build (step 6) |
| 5 | Web app `appId` | `VITE_FIREBASE_APP_ID` | Build environment, exported locally before npm run build (step 6) |
| 6 | The same project ID, server side | `FIREBASE_PROJECT_ID` | `wrangler.jsonc` var (committed) |
| 7 | Deployed Worker origin | `VITE_API_BASE_URL` | Build environment, exported locally before npm run build (step 6) |
| 8 | The same Worker origin again, as a **host** (no scheme) | CSP token `REPLACE_WITH_WORKER_ORIGIN` | substituted into `dist/_headers` |
| 9 | The Firebase auth domain again, without the scheme | CSP token `REPLACE_WITH_FIREBASE_AUTH_DOMAIN` | substituted into `dist/_headers` |
| 10 | Exact production app origin — no path, no trailing slash, no wildcard, no preview hostname | `ALLOWED_ORIGINS` (a JSON array string) | `wrangler.jsonc` var (committed) |
| 11 | Approved Google account emails, as a JSON array of strings | `APPROVED_EMAILS` | **Worker secret only** |
| 12 | Google provider enabled in Firebase Authentication, with a support email | — | Firebase console |
| 13 | Production app hostname added to Firebase **Authorized domains** | — | Firebase console |
| 14 | A Google account **outside** the allowlist you can sign in with | — | human login during acceptance |
| 15 | An authenticated `wrangler login` session (plus the account ID if the login has more than one account) | — | local shell |
| 16 | Preferred Cloudflare Pages project name (must not collide with an existing Worker name — see step 3) | — | Cloudflare dashboard, or wrangler pages project create from the clean directory (step 8) |

`messagingSenderId` and `storageBucket` from the Firebase config snippet are
**not** read by this implementation. Do not set them.

Never supply, and never paste anywhere: a Firebase Admin SDK service-account
JSON or private key; a Google OAuth client secret; a Google account password,
cookie or ID token; Cloudflare Access credentials; an account-wide Cloudflare API
token; Facebook, eBay, proxy, D1 or Discord credentials.

---

## Runbook

### 1. Register the Firebase Web app (Spark plan)

Firebase console → **Add project** → create it on the **Spark** plan → **Add app
→ Web**. Copy `apiKey`, `authDomain`, `projectId` and `appId` from the generated
config snippet. These four values are public client configuration; they are
compiled into the published JavaScript bundle and are readable by anyone.

### 2. Enable Google sign-in with a support email

Firebase console → **Authentication** → **Sign-in method** → **Google** →
enable → select a **support email** → save. Google popup sign-in does not work
until this is done.

### 3. Create or select the Cloudflare Pages project

Pick the project name now (#16). Whichever origin your first deploy prints is the value for
#10 and #13. From an ordinary terminal that is `https://<project-name>.pages.dev`. If an agent
runs the command, it is delegated to Workers instead and the origin is
`https://<project-name>.<account-subdomain>.workers.dev` — that is what this deployment has;
see the warning below. Use whichever origin you actually get everywhere this runbook says the
app origin. The values change; the procedure does not.

The name must not be one an existing Worker already uses: a delegated command runs as
`wrangler deploy --name <project-name>`, so it collides with a Worker of that name (see the
warning below).

> **Do not connect the Pages project to a Git repository this phase.**
> `dist/` is gitignored, so a Git-connected build runs on Cloudflare's runners
> and never performs the CSP substitution in step 6. It would ship a policy
> still containing `REPLACE_WITH_WORKER_ORIGIN`, which blocks every API call
> from the browser. **Direct upload (`wrangler pages deploy dist`) is the only
> supported deploy method** until substitution moves into the build.
>
> Why it has not moved there yet: substitution in `vite.config.ts` needs
> `node:fs`, and `tsconfig.node.json` typechecks that file with no `types`
> array. Node's types do resolve today, but only because `@types/node` is
> installed as an **undeclared transitive dependency** — nothing in
> `package.json` asks for it, so a lockfile refresh upstream can remove it and
> break `npm run build` with no change to this repo. A security policy's
> correctness should not rest on that, and declaring `@types/node` is a second
> dependency addition, which this phase's scope does not allow. Recorded as debt
> for whoever is permitted to add it; spec 2.6.2 explicitly permits documented
> pre-deploy substitution in the meantime.

> **A `wrangler pages` command run by an agent is redirected to a Workers deploy.** In
> wrangler 4.131.0, `maybeDelegatePagesToWorkers()` returns immediately unless `detectAgent()`
> reports an agent environment — it matches `CLAUDECODE`, `OPENCODE` and the marker variables
> of other agent CLIs, and only table entries typed `agent` count. When it does report one, and the target Pages project does not
> already exist, `pages project create` and `pages deploy` both run as `wrangler deploy`
> instead, and the only thing printed is `Delegating to the latest version of Cloudflare
> Pages, now part of Cloudflare Workers`. That notice describes a delegation, not a platform
> change: a human in an ordinary terminal never triggers it and gets classic Pages.
>
> **Delegation never looks at your wrangler config**, so no directory layout prevents it. What
> the directory controls is what the resulting `wrangler deploy` then reads. When
> `wrangler pages project create <name>` was run here from the repository root, the delegated
> deploy read `wrangler.jsonc` (`main: worker/index.ts`) and published **a second copy of the
> API Worker** under the name `<name>`. It created no Pages project:
> `wrangler pages project list` stayed empty while the duplicate Worker was live, and the
> duplicate had taken the name the app needed, so it had to be deleted first. Nothing in the
> command output said any of this.
>
> Two separate precautions follow, and they do different jobs:
>
> - **To opt out of delegation, pass `--force`** — `wrangler pages project create <name>
>   --force`. wrangler's own notice says you need it once: once the Pages project exists,
>   later commands are not delegated.
> - **To keep a delegated deploy from publishing the Worker instead of the site, run every
>   `wrangler pages` command from a throwaway directory containing only `dist/`**, never from
>   the repository root. That is what this runbook does, and it is why `project create` here
>   uploaded `dist/` and printed a live URL. The commands are in step 8.

### 4. Record the app and Worker origins

- App origin, e.g. `https://<project-name>.pages.dev` — or
  `https://<project-name>.<account-subdomain>.workers.dev` from a delegated command (step 3),
  which is the form this deployment has
- Worker origin, e.g. `https://marketplace-deal-finder-api.<account-subdomain>.workers.dev`

Both are exact origins: scheme + host (+ port if non-default), no path and no
trailing slash.

`<account-subdomain>` is your account's `workers.dev` subdomain. It is shown in the Cloudflare
dashboard under **Workers & Pages**, and it is in the URL that `npx wrangler deploy` prints.

**Order of operations.** Two values are only knowable after a deploy: your `workers.dev`
subdomain, and the app origin built from it. This is the order this deployment used, and the
only one that cannot strand you:

1. **Deploy the Worker first** (step 5) with `FIREBASE_PROJECT_ID` set to your project. Leave
   the committed `ALLOWED_ORIGINS` in place for now — you fill it in at item 5.
   `npx wrangler deploy` prints `https://<worker-name>.<account-subdomain>.workers.dev`: that
   is #7, its **host** (the same thing without the `https://`) is #8, and it is where your
   `<account-subdomain>` comes from. Until `ALLOWED_ORIGINS` holds *your* app origin nobody
   gets in from your app: a 5xx while the value is unset, empty or a `REPLACE_WITH_`
   placeholder, and `403 CORS_ORIGIN_DENIED` while it holds another deployment's origin. Both
   fail closed.
2. **Set `APPROVED_EMAILS`** (step 5), then run step 5's check in its **form A** (no `Origin`
   header). That is the only thing that catches an empty secret upload, and it is runnable
   before your app origin exists.
3. **Build the frontend and substitute the CSP** (step 6), using the Worker origin from 1.
   Gate 1.
4. **Deploy the app** (step 8). It prints the app origin — `https://<project-name>.pages.dev`,
   or `https://<project-name>.<account-subdomain>.workers.dev` if the command was delegated
   (step 3). That is #10 and #13. Gate 2.
5. **Now put that app origin into `ALLOWED_ORIGINS`** in `wrangler.jsonc` and run
   `npx wrangler deploy` a second time. Until you do, every browser call from your app is
   answered `403 CORS_ORIGIN_DENIED` — including when `wrangler.jsonc` still holds the
   committed values, which are another deployment's origin. Then run step 5's check in its
   **form B** (with the `Origin` header): it must return `401` **and** an
   `Access-Control-Allow-Origin` naming your app origin.
6. **Authorize the app hostname in Firebase** (step 7), then run the acceptance checks
   (step 9).

### 5. Install Worker configuration, then deploy the Worker

`wrangler.jsonc` is committed with the values this deployment runs (shown below). **If you are
deploying your own copy, replace both with yours** — `FIREBASE_PROJECT_ID` now, and
`ALLOWED_ORIGINS` once you know your app origin (see the order note in step 4). A stale
`ALLOWED_ORIGINS` denies every browser call from your app with `403 CORS_ORIGIN_DENIED`.

```jsonc
"vars": {
  "APP_ENV": "production",
  "FIREBASE_PROJECT_ID": "marketplace-deal-finder",
  "ALLOWED_ORIGINS": "[\"https://marketplace-deal-finder.leozhang07.workers.dev\"]"
}
```

`APP_ENV` **must never be `local` on a deployed Worker.** It is the only
local-bypass guard that is not derived from request headers: in workerd the
request URL is itself built from the incoming `Host`/`:authority`, so the
loopback hostname check is defence in depth, not an independent second factor.

Then:

```sh
npx wrangler login
npx wrangler deploy
```

Then set the allowlist secret (#11) with `npx wrangler secret put APPROVED_EMAILS`. This step
is **required**: until that secret holds a non-empty JSON array of addresses, the Worker
answers `503 AUTH_CONFIG_MISSING` to every `/api/*` request. Read the warning below before you
run it.

> **`wrangler secret put` silently uploads an empty secret when stdin is not a terminal.** Run
> from a script, a CI step or an agent shell, `npx wrangler secret put APPROVED_EMAILS` read an
> empty value, printed `✨ Success! Uploaded secret APPROVED_EMAILS`, listed the secret under
> `wrangler secret list` and deployed a new Worker version. The Worker then answered `503
> AUTH_CONFIG_MISSING` — the same answer it gives when the secret was never set at all. Every
> surface said it had worked.
>
> Set it from a file instead, and delete the file in the same shell session. Write the file
> outside the repository so it cannot be committed:
>
> ```sh
> printf '%s' '["owner@example.com"]' > "${TMPDIR:-/tmp}/approved-emails.json"
> npx wrangler secret put APPROVED_EMAILS < "${TMPDIR:-/tmp}/approved-emails.json"
> rm -f "${TMPDIR:-/tmp}/approved-emails.json"
> ```

**Form A — before the app is deployed** (order-note items 1–2, and after every `secret put`).
Send no `Origin` header and no `Authorization` header:

```sh
curl -si https://<worker-origin>/api/status
```

Read the status line and `error.code` in the body. A `503` is the empty-secret signature — see
the table. A `401 AUTH_TOKEN_MISSING` means `FIREBASE_PROJECT_ID`, `ALLOWED_ORIGINS` and
`APPROVED_EMAILS` all load. It says nothing about whether `ALLOWED_ORIGINS` is *yours*; only
form B can tell you that.

**Form B — after order-note item 5**, once `ALLOWED_ORIGINS` holds your app origin, and after
every later `npx wrangler deploy`:

```sh
curl -si -H 'Origin: https://<your-app-origin>' https://<worker-origin>/api/status
```

Send no `Authorization` header. Read three things: the status line, the
`Access-Control-Allow-Origin` response header, and `error.code` in the body.

| What you see | What it means |
|---|---|
| **(B only)** `401`, `AUTH_TOKEN_MISSING`, and `Access-Control-Allow-Origin: https://<your-app-origin>` | Correct. You sent no token, and your app's origin is allowed. |
| **(B only)** `403`, `CORS_ORIGIN_DENIED`, and **no** `Access-Control-Allow-Origin` | `ALLOWED_ORIGINS` does not contain your app origin — most likely it still holds the committed value, which is another deployment's origin. Fix `wrangler.jsonc` and deploy again. |
| **(A or B)** `503`, `AUTH_CONFIG_MISSING` | `FIREBASE_PROJECT_ID`, `ALLOWED_ORIGINS` or `APPROVED_EMAILS` is unset, empty, or still a `REPLACE_WITH_` placeholder. The Worker does not say which, by design. **This is what an empty secret upload looks like.** |
| **(A or B)** `503`, `AUTH_CONFIG_INVALID` | One of them is set but unusable: `APPROVED_EMAILS` is `[]` or not a JSON array of strings, or an `ALLOWED_ORIGINS` entry has a path, a trailing slash, a wildcard or a non-`http(s)` scheme. `[]` is also the deliberate emergency stop — see "Allowlist add and remove". |

**A `401` with no `Access-Control-Allow-Origin` means you sent no `Origin` header** — form A,
or you forgot the `-H`. The Worker's configuration still loads; that is all form A proves.
With an `Origin` header present, a mismatch is always `403 CORS_ORIGIN_DENIED`, never a
silent 401.

`APPROVED_EMAILS` is a **secret**. It must never appear in `wrangler.jsonc`, in
any `VITE_*` value, in the browser bundle, or in any committed file.

Preview hostnames are denied unless you list them in `ALLOWED_ORIGINS`
separately and deliberately.

### 6. Build the frontend and substitute the CSP placeholders

Export the build environment variables (#2–#5, #7) before building. Do **not** set them as
Pages build variables in the Cloudflare dashboard: this project deploys by direct upload, so
Cloudflare runs no build and those values are never read.

```sh
VITE_FIREBASE_API_KEY=... \
VITE_FIREBASE_AUTH_DOMAIN=<projectId>.firebaseapp.com \
VITE_FIREBASE_PROJECT_ID=<projectId> \
VITE_FIREBASE_APP_ID=... \
VITE_API_BASE_URL=https://marketplace-deal-finder-api.<account-subdomain>.workers.dev \
npm run build
```

The build output is `dist/`, including `dist/_headers`.

Now edit `dist/_headers` and replace the two CSP tokens:

- `REPLACE_WITH_WORKER_ORIGIN` → the Worker **host** (no scheme; the policy
  already carries `https://`), e.g.
  `marketplace-deal-finder-api.<account-subdomain>.workers.dev`
- `REPLACE_WITH_FIREBASE_AUTH_DOMAIN` → the Firebase auth domain host, e.g.
  `<projectId>.firebaseapp.com`

A convenience one-liner — GNU sed:

```sh
sed -i \
  -e 's|REPLACE_WITH_WORKER_ORIGIN|marketplace-deal-finder-api.<account-subdomain>.workers.dev|g' \
  -e 's|REPLACE_WITH_FIREBASE_AUTH_DOMAIN|<projectId>.firebaseapp.com|g' \
  dist/_headers
```

BSD/macOS sed:

```sh
sed -i '' \
  -e 's|REPLACE_WITH_WORKER_ORIGIN|marketplace-deal-finder-api.<account-subdomain>.workers.dev|g' \
  -e 's|REPLACE_WITH_FIREBASE_AUTH_DOMAIN|<projectId>.firebaseapp.com|g' \
  dist/_headers
```

**Gate 1 — before deploying.** Both of these must print `0`:

```sh
grep -c "REPLACE_WITH" dist/_headers
grep -c '[<>]' dist/_headers
```

Do not deploy while either prints anything else.

The second line catches the other way this goes wrong: an example pasted from above with its
own placeholder still in it — `<account-subdomain>`, or `<projectId>`. The `REPLACE_WITH`
check does not catch those and neither does gate 2: a CSP carrying a literal `<…>` blocks
every API call exactly as a leftover `REPLACE_WITH` would. The committed `public/_headers` contains no angle bracket, so a
correctly substituted `dist/_headers` prints `0`.

### 7. Authorize the app hostname in Firebase

You need the app hostname from step 8 first — see the order note in step 4.

Firebase console → **Authentication** → **Settings** → **Authorized domains** →
add the production app hostname (host only, e.g.
`marketplace-deal-finder.<account-subdomain>.workers.dev`). Keep Firebase's
generated auth domain. Register only the production hostname you need.

`localhost` is **not** needed: local development bypasses Firebase entirely. See
"Optional: real Firebase against a local frontend" below if you want to test the
real popup locally.

### 8. Deploy the frontend

Deploy from a throwaway directory containing only `dist/` — never from the repository root
(see the warning in step 3):

```sh
# from the repository root, after step 6 and gate 1:
REPO="$PWD"
UPLOAD="$(mktemp -d)"
cp -R dist "$UPLOAD/dist"
cd "$UPLOAD"

# first time only — creates the project:
"$REPO/node_modules/.bin/wrangler" pages project create <your-project-name> \
  --production-branch master

# publishes a build:
"$REPO/node_modules/.bin/wrangler" pages deploy dist --project-name <your-project-name>

cd "$REPO" && rm -rf "$UPLOAD"
```

Three things about this block are load-bearing:

- **`mktemp -d`, every time.** Copying `dist` into a directory that already holds one nests it
  (`.../dist/dist`) and leaves the previous run's bytes at the upload root, so you silently
  publish the **previous** build. Gate 2 cannot catch that: the stale CSP was already
  substituted, so it passes.
- **The wrangler binary is invoked by path.** `npx wrangler` outside the repository would fetch
  a different wrangler instead of the pinned one.
- **`--production-branch master` on `project create`.** Without it the command prompts for a
  branch and will hang or fail in a non-interactive shell. On this deployment `project create`
  was delegated to a Workers deploy (step 3), so it uploaded `dist/` itself and printed the
  live URL — that is delegation's behaviour, not `project create`'s. The `pages deploy` line
  above is how you publish each later build. `project create` is not a deploy command — do not
  use it as one.

**Gate 2 — after deploying.** The served policy must be present and must contain no
placeholder:

```sh
curl -sI https://<app-origin>/ | grep -i content-security-policy
```

It must print exactly one line, and that line must contain no `REPLACE_WITH`. **Empty output
is a failure, not a pass.** It means the site served no `Content-Security-Policy` header at
all — `_headers` was not honoured on this deploy path and you have shipped a site with no
policy. `grep` prints nothing and exits non-zero in that case, which reads exactly like a
clean result. As one command:

```sh
csp="$(curl -sI https://<app-origin>/ | grep -i content-security-policy)"
[ -n "$csp" ] && ! printf '%s' "$csp" | grep -q "REPLACE_WITH" && echo "gate 2 OK"
```

This gate catches the mistake from
outside, on any deploy path, including a Git-connected project that skipped
gate 1.

Record the app origin the deploy printed: that is #10 and #13. Now complete step 4's order
note — put that origin into `ALLOWED_ORIGINS` and run `npx wrangler deploy` again, then
re-run step 5's `curl` check in **form B**.

### 9. Run the acceptance checklist

See "Deployed acceptance checks".

---

## Content-Security-Policy notes

`https://apis.google.com` is a **required** CSP host in both `script-src` and
`frame-src`. It is a fixed literal already committed in `public/_headers`; you
supply nothing for it. The shipped `firebase-auth` bundle loads
`https://apis.google.com/js/api.js` into the top document and maps its `onerror`
to `auth/internal-error`; under `script-src 'self'` alone, `signInWithPopup`
cannot complete and the symptom is a sign-in button that appears to do nothing,
with the real cause visible only in the browser console.

`https://identitytoolkit.googleapis.com` and
`https://securetoken.googleapis.com` in `connect-src` are likewise fixed
literals taken from the same bundle.

If the deployed sign-in still fails, open the browser console and read the
blocked-resource entries. **Add only the hosts the console names as blocked,
nothing more. Never use a wildcard origin. Never disable CSP.** Do not weaken
`frame-ancestors`, `object-src`, `base-uri`, `form-action`, `Permissions-Policy`,
`Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options` or `X-Robots-Tag`
to make sign-in work.

---

## Allowlist add and remove

```sh
# Replace the whole list (this is the only update operation):
npx wrangler secret put APPROVED_EMAILS
# then paste the full new JSON array, e.g. ["owner@example.com"]

# Emergency stop — revoke everyone with no code change and no deploy:
npx wrangler secret put APPROVED_EMAILS
# paste: []
# The Worker then answers 503 AUTH_CONFIG_INVALID for everyone: it fails closed.

npx wrangler secret list
npx wrangler secret delete APPROVED_EMAILS
```

Both `secret put` calls above are subject to the non-TTY footgun in step 5 — use the
file-redirect form. After either, re-run step 5's check in **form B**: a replaced list must
return `401` again, with the `Access-Control-Allow-Origin` header, and the emergency stop
(`[]`) must return `503 AUTH_CONFIG_INVALID`. A `503 AUTH_CONFIG_MISSING` there means the
upload was empty, not that `[]` took effect.

The allowlist is re-read from the secret on **every** request. Removing an entry
denies that account's **next** request, even while it still holds an unexpired
Firebase ID token. Matching is exact after trimming and lowercasing: no
wildcards, no suffix or substring matching, and no Gmail dot or plus-alias
folding.

---

## Optional: real Firebase against a local frontend

The default local path needs none of this. If you specifically want to exercise
the real Google popup locally:

1. Add `localhost` to Firebase **Authorized domains**. New projects do not
   automatically authorize it — see
   <https://firebase.google.com/docs/auth/faq-and-troubleshooting>.
2. Copy `.env.example` to a gitignored `.env` and fill in the four
   `VITE_FIREBASE_*` values.
3. Serve the frontend from a **non-loopback** hostname, or the gate selects the
   credential-free local identity and never contacts Firebase at all.
4. Point `VITE_API_BASE_URL` at a Worker deployed with `APP_ENV: "production"`
   and a matching `ALLOWED_ORIGINS`.

This is a deliberate detour around the supported local path. The supported local
path is `npm run dev:full` with no configuration whatsoever.

---

## Deployed acceptance results

Record actual values here. No secret, allowlist entry, or token belongs in this
table — redact email local parts if you prefer (`o…r@example.com`).

| URL | Deployment version | Date | Desktop browser | Mobile browser | Outcome |
|---|---|---|---|---|---|
| App — `https://marketplace-deal-finder.leozhang07.workers.dev` | not recorded | 2026-09-20 | not recorded | not observed | passed the checks ticked below |
| Worker — `https://marketplace-deal-finder-api.leozhang07.workers.dev` | not recorded | 2026-09-20 | not recorded | not observed | passed the checks ticked below |

`not recorded`: it happened and was not logged. `not observed`: it did not happen.

## Deployed acceptance checks

Run against the deployment above on 2026-09-20. A ticked box was observed on the live
deployment. **An unticked box has not been observed and is what remains.** No email address,
token or allowlist entry is recorded here.

- [x] Fail-closed before configuration: with no `APPROVED_EMAILS` set, every `/api/*`
      request returned `503 AUTH_CONFIG_MISSING`, leaking nothing about what was missing.
- [x] A signed-out visit shows Google sign-in, not the dashboard.
- [x] The allowlisted account signs in through the Google popup and reaches the dashboard.
      The deployed CSP therefore permits the real popup flow, and the gate renders the
      dashboard only after `GET /api/auth/session` succeeds against the deployed Worker.
- [ ] A page refresh while signed in keeps the session, and a deliberate sign-out returns
      to the sign-in screen.
- [x] An account outside the allowlist signed into Firebase and received the access-denied
      screen; the dashboard never rendered. (That screen is reachable only from a Worker 403.)
- [x] Revocation: with the allowlist replaced by an address that is not the signed-in user,
      that user's still-valid, unexpired ID token was denied on the very next request.
      Restoring the allowlist restored access.
- [x] Direct calls: a missing token returned `401 AUTH_TOKEN_MISSING`, a malformed token
      `401 AUTH_TOKEN_INVALID`, and a `Cf-Access-Jwt-Assertion` header alone
      `401 AUTH_TOKEN_MISSING` — the superseded Access credential is ignored, not accepted
      as a fallback. A successful preflight did not authorize the following GET: the
      preflight returned 204 and the subsequent unauthenticated GET still returned 401.
- [x] Exact-origin CORS: a preflight from the app origin returned 204 with an exact
      `Access-Control-Allow-Origin`, `Vary: Origin`,
      `Access-Control-Allow-Methods: GET, OPTIONS`,
      `Access-Control-Allow-Headers: Authorization, Accept`,
      `Access-Control-Max-Age: 600`, and no `Access-Control-Allow-Credentials`.
      An unrelated origin (`https://evil.example`) received `403 CORS_ORIGIN_DENIED` with
      zero `Access-Control-Allow-Origin` headers.
- [x] The served site carries `Content-Security-Policy`, `Referrer-Policy: no-referrer`,
      `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
- [ ] The Worker's own responses carry `Cache-Control: no-store`, `Permissions-Policy`,
      `Referrer-Policy`, `X-Content-Type-Options` and `X-Frame-Options` on both successes
      and failures.
- [x] Real public-key verification succeeds in the deployed Worker: a live Google ID token
      was accepted, so `importX509` ran against Google's live certificate payload.
- [ ] A token refresh works across the ~1 hour ID-token lifetime.
- [ ] A controlled expiry or refresh failure returns to sign-in without a retry loop.
- [ ] Neither the public Worker nor the production bundle uses the local identity
      (`/api/status` reports `firebase-google`). Requires a signed-in browser session;
      never captured.
- [ ] Authentication and network errors stay distinct from the sample provider states.
- [x] No Facebook requests, D1 writes, Cron jobs or Discord messages exist.
- [x] Gate 1 (`grep -c "REPLACE_WITH" dist/_headers`) printed `0`. Gate 2 (`curl -sI` on the
      served origin) showed a CSP with no `REPLACE_WITH`, carrying the Worker origin, the
      Firebase endpoints and `https://apis.google.com`.

## Verified locally

- `npm run check` (lint, tests, frontend build and typecheck, Worker typecheck).
- `npm run dev:full` with no Firebase project and no secrets: the UI loads and
  `GET /api/status` reports `local-development`.
