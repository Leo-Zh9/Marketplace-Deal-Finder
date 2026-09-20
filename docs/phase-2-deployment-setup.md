# Phase 2 deployment setup

Firebase Google sign-in in front of a Cloudflare Worker API, with an email
allowlist held as a Worker secret.

Status: **ready for deployed verification.** Every step below is written to be
executed by a human with console access. Nothing in this runbook has been run
yet — see "Remaining deployed checks".

No Cloudflare Zero Trust organization, Cloudflare Access policy, service-account
private key, custom domain, credit card, or paid upgrade is required.

Local development needs none of this: `npm run dev:full` runs with no Firebase
project and no secrets, using the Worker's `local-development` identity.

---

## What you must supply

| # | Value or action | Name | Where it is set |
|---|---|---|---|
| 1 | Firebase project on the **Spark** (free) plan with a registered **Web app** | — | Firebase console |
| 2 | Web app `apiKey` | `VITE_FIREBASE_API_KEY` | Pages build environment variable |
| 3 | Web app `authDomain` (usually `<projectId>.firebaseapp.com`) | `VITE_FIREBASE_AUTH_DOMAIN` | Pages build environment variable |
| 4 | Web app `projectId` — must equal #6 exactly | `VITE_FIREBASE_PROJECT_ID` | Pages build environment variable |
| 5 | Web app `appId` | `VITE_FIREBASE_APP_ID` | Pages build environment variable |
| 6 | The same project ID, server side | `FIREBASE_PROJECT_ID` | `wrangler.jsonc` var (committed) |
| 7 | Deployed Worker origin | `VITE_API_BASE_URL` | Pages build environment variable |
| 8 | The same Worker origin again | CSP token `REPLACE_WITH_WORKER_ORIGIN` | substituted into `dist/_headers` |
| 9 | The Firebase auth domain again, without the scheme | CSP token `REPLACE_WITH_FIREBASE_AUTH_DOMAIN` | substituted into `dist/_headers` |
| 10 | Exact production Pages origin — no path, no trailing slash, no wildcard, no preview hostname | `ALLOWED_ORIGINS` (a JSON array string) | `wrangler.jsonc` var (committed) |
| 11 | Approved Google account emails, as a JSON array of strings | `APPROVED_EMAILS` | **Worker secret only** |
| 12 | Google provider enabled in Firebase Authentication, with a support email | — | Firebase console |
| 13 | Production Pages hostname added to Firebase **Authorized domains** | — | Firebase console |
| 14 | A Google account **outside** the allowlist you can sign in with | — | human login during acceptance |
| 15 | An authenticated `wrangler login` session (plus the account ID if the login has more than one account) | — | local shell |
| 16 | Preferred Cloudflare Pages project name | — | Cloudflare dashboard / `wrangler pages deploy` |

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

Pick the project name now (#16). The `*.pages.dev` origin it is assigned becomes
the value for #10 and #13.

> **Do not connect the Pages project to a Git repository this phase.**
> `dist/` is gitignored, so a Git-connected build runs on Cloudflare's runners
> and never performs the CSP substitution in step 6. It would ship a policy
> still containing `REPLACE_WITH_WORKER_ORIGIN`, which blocks every API call
> from the browser. **Direct upload (`wrangler pages deploy dist`) is the only
> supported deploy method** until substitution moves into the build — which
> requires `@types/node`, a dependency this phase may not add.

### 4. Record the Pages and Worker origins

- Pages origin, e.g. `https://marketplace-deal-finder.pages.dev`
- Worker origin, e.g. `https://marketplace-deal-finder-api.<account-subdomain>.workers.dev`

Both are exact origins: scheme + host (+ port if non-default), no path and no
trailing slash.

### 5. Install Worker configuration, then deploy the Worker

Edit `wrangler.jsonc` and replace both placeholders:

```jsonc
"vars": {
  "APP_ENV": "production",
  "FIREBASE_PROJECT_ID": "<your-firebase-project-id>",
  "ALLOWED_ORIGINS": "[\"https://marketplace-deal-finder.pages.dev\"]"
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
npx wrangler secret put APPROVED_EMAILS
# paste, on one line, e.g.:
# ["owner@example.com","tester@example.com"]
```

`APPROVED_EMAILS` is a **secret**. It must never appear in `wrangler.jsonc`, in
any `VITE_*` value, in the browser bundle, or in any committed file.

Preview hostnames are denied unless you list them in `ALLOWED_ORIGINS`
separately and deliberately.

### 6. Build the frontend and substitute the CSP placeholders

Set the Pages build environment variables (#2–#5, #7) in the Cloudflare
dashboard, or export them locally before building:

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

**Gate 1 — before deploying.** This must print `0`:

```sh
grep -c "REPLACE_WITH" dist/_headers
```

Do not deploy while it prints anything else.

### 7. Authorize the Pages hostname in Firebase

Firebase console → **Authentication** → **Settings** → **Authorized domains** →
add the production Pages hostname (host only, e.g.
`marketplace-deal-finder.pages.dev`). Keep Firebase's generated auth domain.
Register only the production hostname you need.

`localhost` is **not** needed: local development bypasses Firebase entirely. See
"Optional: real Firebase against a local frontend" below if you want to test the
real popup locally.

### 8. Deploy the frontend

```sh
npx wrangler pages deploy dist --project-name <your-pages-project>
```

**Gate 2 — after deploying.** The served policy must contain no placeholder:

```sh
curl -sI https://<pages-origin>/ | grep -i content-security-policy
```

The output must contain no `REPLACE_WITH`. This gate catches the mistake from
outside, on any deploy path, including a Git-connected project that skipped
gate 1.

### 9. Run the acceptance checklist

See "Remaining deployed checks".

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
| _(Pages origin)_ | | | | | not yet run |
| _(Worker origin)_ | | | | | not yet run |

## Remaining deployed checks

None of the following has been executed. Each requires provisioned Cloudflare
and Firebase resources plus a human Google sign-in, which were unavailable when
this phase was implemented. They are pending, not observed.

- [ ] A signed-out visit shows Google sign-in, not the dashboard.
- [ ] The owner signs in, opens the sample UI, refreshes the page, calls both
      `/api/auth/session` and `/api/status`, and signs out back to sign-in.
- [ ] An account outside the allowlist signs into Firebase but receives Worker
      `403 AUTH_FORBIDDEN` and access-denied copy, with the dashboard never
      rendered.
- [ ] A test account is added and then removed. Once the removal is active, its
      still-valid ID token receives 403 on the next request.
- [ ] Direct calls with a missing token, a malformed token, and a
      `Cf-Access-Jwt-Assertion` header alone all fail. A successful preflight
      does not authorize the subsequent GET.
- [ ] Browser checks confirm exact-origin CORS and the security headers on both
      successes and failures. An unrelated origin receives no readable
      protected response.
- [ ] Real public-key verification succeeds in the deployed Worker, a token
      refresh works, and a controlled expiry or refresh failure returns to
      sign-in without a retry loop.
- [ ] Neither the public Worker nor the production bundle uses the local
      identity (`/api/status` reports `firebase-google`).
- [ ] Authentication and network errors stay distinct from the sample provider
      states. No Facebook requests, D1 writes, Cron jobs or Discord messages
      exist.
- [ ] Gate 1 (`grep -c "REPLACE_WITH" dist/_headers` prints `0`) and gate 2
      (`curl -sI` shows no `REPLACE_WITH`) both pass.

## Verified locally

- `npm run check` (lint, tests, frontend build and typecheck, Worker typecheck).
- `npm run dev:full` with no Firebase project and no secrets: the UI loads and
  `GET /api/status` reports `local-development`.
