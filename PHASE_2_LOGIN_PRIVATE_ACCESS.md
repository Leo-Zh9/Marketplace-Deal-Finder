# Phase 2 - Firebase Google Login and Private API Access

## Status and next implementation step

Planning audit: 2026-09-20. Phase 2 is the next unfinished implementation phase.
This document plans remaining work; it does not claim completed Firebase
implementation or a verified production deployment.

| Area | Current repository evidence | Progress conclusion |
| --- | --- | --- |
| Phase 1 prototype | `src/App.tsx`, `src/components/`, `src/data/`, `src/services/marketplaceClient.ts`, and `src/App.test.tsx` provide controls, sample results, and simulated monitoring. | Prototype code exists; its Pages deployment acceptance is unverified. |
| Worker scaffold | `worker/auth/verifyAccess.ts` validates Access assertions and supplies a loopback development identity. `worker/index.ts` has `/api/auth/session` and `/api/status`. | Partial Phase 2 work implements the superseded Access design. |
| Browser authentication | `src/main.tsx` mounts `App` directly; there is no Firebase dependency. `apiClient.ts` handles Access redirects and same-origin requests. | No Firebase sign-in, application gate, token transport, or sign-out exists. |
| Production boundary | `wrangler.jsonc` has Access placeholders; the Worker has no CORS; `public/_headers` permits connections only to self. | Planned Pages-to-Worker authentication cannot work yet. |
| Setup documentation | `docs/phase-2-deployment-setup.md` is a Firebase target-state placeholder. | Executable setup and deployed verification remain outstanding. |
| Later phases | `worker/` contains only the handler, Access verifier, and their tests. | Facebook collection, D1, pricing, Workflows/Cron, and live monitoring are not implemented. |

The existing Phase 2 plan and `ARCHITECTURE.md` select Firebase. Access references
in implementation, `PLAN.md`, and Phase 5 are migration debt, not a new decision
to reinstate Access. Finish Phase 2 before Phase 3A.

Baseline checks from this audit: lint, frontend production build, and Worker
typecheck passed; all 4 existing test files / 15 tests passed with
`npm run test -- --pool=threads --maxWorkers=1`. The initial `npm run check`
failed because two default fork workers timed out during startup. That aggregate
command was not green, and these tests exercise the existing Access/prototype
implementation, not the planned Firebase acceptance criteria.

## Objective and scope

Deliver a Google-authenticated prototype on a generated `pages.dev` hostname
with a Worker on its generated `workers.dev` hostname that independently checks
Firebase ID tokens and an approved-email allowlist on every protected request.
Keep the sample-data UI behind this gate and preserve credential-free local
development through `npm run dev:full`.

Services remain Firebase Authentication on Spark, Cloudflare Pages, and Workers.
No purchased domain, Cloudflare Access/Zero Trust setup, credit card, or paid
service belongs to this phase. Confirm the selected account configuration stays
within these constraints; do not enable billing to unblock deployment.

Included: identity verification, authorization, session UX, API transport, CORS,
local isolation, security headers, configuration examples, tests, and deployment
instructions with observed verification results.

Excluded: Facebook/eBay collection, D1 schemas/data, real search/settings APIs,
pricing, live monitoring, Workflows/Cron, Discord, proxies, roles, organization or
profile management, registration UI, password handling, user administration UI,
and replacing the marketplace mock service. Keep the sample-data disclosure.

Static assets and the login shell remain public. Private data, secrets, and
authorization decisions belong on the Worker; hiding a dashboard is not an API
security boundary.

## Authentication and API contracts

- Use the modular Firebase browser SDK with a user-initiated Google popup.
  Handle blocked/closed popups with a retryable sign-in message. Redirect flow
  and other providers are deferred unless deployed browser evidence requires
  them. Follow [Firebase Google sign-in setup](https://firebase.google.com/docs/auth/web/google-signin).
- Send a Firebase ID token as `Authorization: Bearer <token>`; a Google OAuth
  access token is not the application credential.
- Preserve `{ identity: { email, subject, expiresAt, authenticationMethod } }`
  from `/api/auth/session`. Use `firebase-google` / `local-development` method
  values, the verified Firebase UID for `subject`, and Unix seconds for expiry.
  Never return tokens or complete claims.
- Store `APPROVED_EMAILS` only as a Worker secret containing a JSON array of
  email strings. Missing, malformed, or empty configuration fails closed.
  Normalize entries and verified email by trimming/lowercasing, then compare
  exact values. Do not accept wildcards, suffix/substring matches, or Gmail
  dot/plus alias equivalence. Recheck membership for every request.
- Removing an email denies subsequent requests after the updated secret becomes
  active, even with an unexpired ID token. Sign-out clears the browser session
  but does not revoke an already issued bearer token. Firebase account-disable
  and immediate token-revocation checks are deferred; use allowlist removal for
  access removal in this phase.
- Keep only `GET /api/auth/session` and `GET /api/status` as business endpoints
  in this phase. Authenticate before dispatching every `/api/*` handler, except
  valid preflight. `/api/status` describes the shell/API, not Facebook health.

Use `{ error: { code, message } }` and these stable outcomes:

| Status | Code | Meaning / frontend behavior |
| --- | --- | --- |
| 401 | `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID` | Missing, malformed, expired, or invalid identity; bounded refresh then sign-in. |
| 403 | `AUTH_FORBIDDEN` | Valid token fails verified-email, Google-provider, or allowlist policy; access denied with sign-out/change-account. |
| 403 | `CORS_ORIGIN_DENIED` | Explicit origin is unapproved; do not grant it CORS access. |
| 503 | `AUTH_CONFIG_MISSING`, `AUTH_CONFIG_INVALID` | Worker configuration unusable; fail closed with service/setup messaging. |
| 503 | `AUTH_KEYS_UNAVAILABLE` | Verification keys cannot be obtained when needed; fail closed and permit a later retry. |

Do not expose secrets, allowlists, or tokens in errors/logs. Keep frontend
unauthenticated, forbidden, network, server, and unexpected errors separate;
none of these is a Facebook provider failure.

## Subtasks and acceptance criteria

### 2.1 - Configuration and shared types

Dependencies: none; use placeholder public configuration for local work.

Work:

1. Add the modular `firebase` browser dependency, keep `jose`, and update the
   lockfile. Define public configuration in `.env.example` and
   `src/vite-env.d.ts` using the inventory below.
2. Replace production Access variables with `APP_ENV=production`,
   `FIREBASE_PROJECT_ID`, and `ALLOWED_ORIGINS`. Define `ALLOWED_ORIGINS` as a JSON
   array of exact URL origins; production contains the actual HTTPS Pages
   origin, with no paths, trailing slashes, wildcards, or implicit preview hosts.
3. Document `APPROVED_EMAILS` format with dummy emails only in
   `.dev.vars.example`/runbook. Keep real `.env*` and `.dev.vars*` ignored; never
   put privileged credentials or the allowlist in `VITE_*` values.
4. Update `src/auth/authTypes.ts` and Worker types to the contracts above. Remove
   the executable Access path/config when the replacement is wired.

Touchpoints: dependency files, `.env.example`, `.dev.vars.example`,
`src/vite-env.d.ts`, `src/auth/authTypes.ts`, both Wrangler configs, Worker types.

Acceptance:

- [ ] Names, formats, and public/secret boundaries match the inventory and
  browser/Worker types compile.
- [ ] Missing public production config shows a setup/service error without
  mounting the dashboard or selecting a local identity.
- [ ] Missing/malformed Worker configuration returns the specified 503 and does
  not treat placeholders as a configured production service.
- [ ] Active code/config no longer accepts `Cf-Access-Jwt-Assertion`,
  `CLOUDFLARE_ACCESS_*`, Access redirects, or `cloudflare-access` identities.

### 2.2 - Authoritative Firebase token verification

Dependencies: 2.1; can proceed independently of frontend UX.

Work:

1. Replace `worker/auth/verifyAccess.ts` with
   `worker/auth/verifyFirebaseToken.ts`; parse one nonempty bearer token from
   `Authorization` and reject malformed input.
2. Use `jose` with Firebase signing certificates from
   `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`.
   Import certificate keys and cache for the response cache lifetime. Bound
   fetch timeouts and refresh attempts; unknown key IDs can cause one controlled
   refresh, never an unbounded loop. Share an in-flight fetch and apply a refresh
   cooldown within each Worker isolate so repeated/concurrent unknown IDs do
   not cause one fetch per request. No distributed cache is needed. Never trust
   token-provided key URLs.
3. Require `RS256`, a known `kid`, valid signature, a string audience exactly
   equal to the configured project ID, issuer
   `https://securetoken.google.com/<projectId>`, finite numeric `exp`, `iat`, and
   `auth_time`, and nonempty `sub`. With an injected seconds clock, require
   `exp > now`, `iat <= now`, and `auth_time <= now`; same-second issuance is
   valid. Inject clock/key access for deterministic tests. Follow
   [Firebase verification requirements](https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library).
4. Then require nonempty email, `email_verified === true`,
   `firebase.sign_in_provider === 'google.com'`, and exact allowlist membership.
   Return only the verified identity contract.
5. An unknown key after a successful refresh is an invalid token (401). A failed
   required key fetch is a service failure (503). Neither condition may trigger
   unsigned decoding or a development identity.

Touchpoints: Worker auth module/types, `worker/index.ts`, verifier tests.

Acceptance:

- [ ] A signed Firebase-format test token for the configured project and an
  approved, verified Google account returns the expected identity.
- [ ] Tests reject missing/malformed bearer input, tampered signatures, wrong
  algorithm/key/issuer/audience, missing/empty subject, expiry, and missing or
  future issued-at/authentication timestamps. Cover the same-second boundary,
  non-finite timestamps, and rejection of array/non-string audiences.
- [ ] Validly signed tokens with missing/unverified email, non-Google provider,
  or unapproved email receive 403; lookalike addresses do not pass.
- [ ] Tests cover certificate caching, rotation, shared in-flight refresh and
  cooldown, unknown-key 401 versus required-key-fetch 503, and fetch timeouts
  without live Google requests.
- [ ] Changing the allowlist environment changes authorization on the next
  request; browser-side cached approval cannot override the Worker.

### 2.3 - Exact-origin CORS and route protection

Dependencies: 2.1 and 2.2.

Work:

1. Handle `/api/*` preflight before authentication. Validate origin, requested
   method, and requested headers; return 204 only for allowed preflights.
2. Initially allow GET and its needed request headers (`Authorization`,
   `Accept`). Extend methods/content types only with later business APIs.
3. With valid origin configuration, add exact `Access-Control-Allow-Origin` plus
   `Vary: Origin` to every allowed-origin success/error response, including
   401/403/503. If `ALLOWED_ORIGINS` itself is absent/malformed, fail closed with
   no access-granting CORS headers: the browser reports network/setup failure,
   and the runbook uses direct API diagnostics to inspect the 503. Retain
   no-store and existing API security headers.
4. Deny explicit unapproved/`null` origins. Requests without Origin still require
   identical token validation; CORS is not authentication. Do not trust
   `Referer`, forwarded headers, or claimed host information as identity.
5. Use no wildcard origin, cross-origin cookies, or
   `Access-Control-Allow-Credentials` for this bearer design.

Touchpoints: `worker/index.ts`, optional CORS helper, handler tests, Wrangler
origin configuration.

Acceptance:

- [ ] Allowed preflight succeeds without a token; the following unauthenticated
  GET is denied. With valid origin configuration, allowed-origin
  200/401/403/503 remain readable in the browser.
- [ ] Missing/malformed origin configuration grants no CORS access; tests and
  runbook distinguish its direct 503 diagnostic from browser network failure.
- [ ] Another Pages project, preview hostname, lookalike suffix, wrong scheme or
  port, `null`, unsupported method/header are denied without granting CORS.
- [ ] Direct no-Origin requests with missing/invalid tokens are denied; approved
  verified requests work with or without Origin.
- [ ] Unknown API paths cannot bypass verification; authenticated unknown paths
  return a predictable JSON not-found response.

### 2.4 - Firebase session UX and bearer-token API transport

Dependencies: 2.1 contracts; full integration requires 2.2 and 2.3.

Work:

1. Add `src/auth/firebase.ts`, `AuthProvider.tsx`, and a small sign-in/access
   gate; wire the provider into `src/main.tsx`. Subscribe to Firebase session/
   token changes and configure persistence that survives refresh.
2. Represent initializing, signed out, authorizing, approved, denied, and
   recoverable service/network states. Mount `App` only after the Worker session
   endpoint approves the identity; Firebase sign-in alone is insufficient.
3. Update `apiClient.ts` to obtain the current token before each request and
   resolve `/api/*` against `VITE_API_BASE_URL` in production. Keep same-origin
   `/api` through Vite's existing proxy in development. Attach credentials only
   to the configured API; reject arbitrary destinations and cross-origin
   redirects rather than forwarding tokens.
4. Let the Firebase SDK refresh expiring tokens. On a 401 allow at most one
   forced-refresh retry for current GET session/status requests. Never retry
   403 or loop indefinitely. Defer mutation retry policy until business APIs
   exist.
5. Add sign-out/change-account. Clear authorized identity and visible prototype
   state, including the module-level mock monitoring state when switching users.
   Cancel or ignore pending authorization results; an old response cannot reopen
   the app after logout/account change. Invalidate pending mock operation
   generations too: an older delayed start/stop must not mutate singleton state
   after it has been reset for a different identity.
6. Remove Access-redirect handling. Map network/key/config errors to service
   messaging, denial to access denied, and invalid identity to sign-in. Keep
   `marketplaceClient` mocked and retain sample-data labeling. Controls and
   loading/error messages remain keyboard accessible and appropriately labeled.

Touchpoints: `src/auth/`, `src/main.tsx`, `src/App.tsx`, `apiClient.ts`, the
mock-state reset seam in `marketplaceClient.ts`, styles, and corresponding tests.

Acceptance:

- [ ] Signed-out/loading/denied/service-error states cannot mount the dashboard
  or invoke its marketplace operations.
- [ ] Approved sign-in and browser refresh recheck the Worker and show the
  existing Phase 1 UI; unapproved Google accounts remain outside it.
- [ ] Each API call gets the latest token at the correct origin; tokens never
  enter URLs, logs, analytics, or application-managed persistence.
- [ ] Tests cover successful single refresh retry, failed refresh, persistent
  401, 403 without retry, network/503 states, popup dismissal, and logout/account-
  switch races. A pending mock start followed by account change cannot activate
  monitoring for the new account; no prior account state remains visible.
- [ ] Existing search/preview/mock-monitoring behavior works behind the gate;
  authentication errors never appear as Facebook failures.

### 2.5 - Isolated local development

Dependencies: 2.2 and 2.4; validate together with CORS.

Work:

1. Retain `npm run dev:full`, Vite's `/api` proxy, and the Worker loopback binding
   at `127.0.0.1:8787` in `wrangler.local.jsonc`. Bind Vite to loopback with port
   5173 and `strictPort: true`; configure local `ALLOWED_ORIGINS` explicitly for
   `http://localhost:5173` and `http://127.0.0.1:5173`. Fail on port conflicts
   instead of silently choosing an origin that CORS does not permit.
2. Supply the fixed development identity only when Worker `APP_ENV === 'local'`
   and the actual request URL hostname is loopback. Check that guarded local
   path before requiring Firebase project/allowlist config. Valid local
   preflight and sessions must work with no Firebase or allowlist credentials.
3. Permit the frontend local path only with `import.meta.env.DEV` and a loopback
   browser hostname, then require `/api/auth/session` to report
   `authenticationMethod: 'local-development'`. Missing Firebase config cannot
   select this path in production.
4. Specify supported loopback forms (`localhost`, `127.0.0.1`, parsed IPv6
   loopback where supported). Handle/test bracketed IPv6 URL hostnames explicitly
   and add an IPv6 local origin only if the corresponding bind/proxy path is
   supported and tested.
5. A public Worker hostname denies development identity even if local config is
   accidentally deployed. A production bundle served locally still requires
   Firebase; a development bundle on a public/LAN host cannot auto-authorize.
   Add no override header, query parameter, or production bypass flag.

Touchpoints: Worker verifier/local config, frontend auth gate, `vite.config.ts`,
focused auth/environment tests.

Acceptance:

- [ ] `npm run dev:full` provides the sample UI at the documented fixed local
  origin without Firebase/allowlist credentials; preflight succeeds and
  session/status endpoints report local development. A port conflict reports
  a startup error instead of selecting an unconfigured origin.
- [ ] Tests cover frontend DEV/hostname and Worker APP_ENV/hostname combinations,
  including public hosts, lookalikes, production-on-loopback, forwarded headers,
  and IPv6 behavior. Every required bypass condition must hold together.
- [ ] A deployed Worker addressed publicly cannot authorize through the local
  identity, even with `APP_ENV=local`.

### 2.6 - Headers, examples, and deployment runbook

Dependencies: 2.1-2.5; actual hostname checks need the inputs below.

Work:

1. Update `public/_headers` for exact Worker and Firebase authentication origins
   required by popup sign-in. Retain CSP, no-sniff, frame/referrer/permissions
   protection, and existing geolocation behavior. Validate actual required
   connect/frame/script destinations in-browser; do not use wildcard origins
   or disable CSP to make sign-in work.
2. Make project-specific CSP configuration executable through deterministic
   build substitution or documented exact pre-deploy substitution. Inspect
   emitted `dist/_headers`; no release may contain placeholder origins. Verify
   popup compatibility without weakening unrelated policies.
3. Complete `docs/phase-2-deployment-setup.md` in this order: register Firebase Web
   app on Spark; enable Google/support email; select/create Pages project; obtain
   Pages/Worker origins; install Worker project/origins/allowlist; set Pages build
   variables; authorize Pages hostname in Firebase; deploy; run acceptance.
4. Document build output (`dist`), deploy commands/config targets, secret update
   commands, and allowlist add/remove behavior. Prefer an authenticated Wrangler
   session; no account-wide pasted Cloudflare API token is required.
5. Keep Firebase's generated auth domain and register only the production Pages
   hostname needed. Default local bypass needs no Firebase localhost entry.
   Describe optional real-Firebase local testing separately; new projects do
   not automatically authorize localhost. See
   [Firebase authorized-domain guidance](https://firebase.google.com/docs/auth/faq-and-troubleshooting).
6. Record actual URLs, deployment version, date, tested desktop/mobile browsers,
   and pass/fail outcomes without secrets. Keep pending setup checks distinct
   from observed successes.

Touchpoints: `public/_headers`, configuration/build scripts only if needed,
examples, `docs/phase-2-deployment-setup.md`.

Acceptance:

- [ ] The runbook is executable with the listed inputs and needs no Access
  policy, custom domain, service-account private key, or paid upgrade.
- [ ] Deployed popup sign-in, token refresh, and API calls work under the actual
  CSP; unrelated origins remain blocked and existing headers remain present.
- [ ] CORS uses the actual Pages origin; Firebase authorized domains use its
  hostname. Preview hosts are denied unless separately and explicitly listed.
- [ ] No allowlist secret/privileged credential appears in examples, browser
  assets, or validation logs.

### 2.7 - Local and deployed verification

Dependencies: all previous subtasks; deployment needs provisioned resources and
human Google sign-in.

Work:

1. Replace Access-specific tests with Firebase verifier, Worker CORS, API-client,
   and auth-gate coverage. Use local signing keys and injected clocks/key
   fetchers/SDK boundaries; offline tests must not call live Google services.
   Preserve Phase 1 regression coverage.
2. Run `npm run check` (lint, tests, frontend typecheck/build, Worker typecheck),
   focused `npm run dev:full` smoke testing, and emitted-config/header inspection.
   Record results; if the known fork-worker startup limitation recurs, record
   that failure and separate single-thread verification rather than claiming
   the default aggregate command passed.
3. Exercise the deployed checklist against the real origins and record redacted
   evidence in the runbook.

Acceptance in deployment:

- [ ] Signed-out visit shows Google sign-in, not the dashboard.
- [ ] Owner signs in, opens the sample UI, refreshes, calls both endpoints, and
  signs out back to the sign-in screen.
- [ ] An account outside the allowlist signs into Firebase but gets Worker 403
  and access denied, without rendering the dashboard.
- [ ] A test account is added/removed. Once removal config is active, its still-
  valid ID token receives 403 on the next request. Restore it only if intended.
- [ ] Direct calls with missing/malformed tokens or an Access assertion header
  alone fail. Successful preflight does not authorize a subsequent GET.
- [ ] Browser checks confirm exact-origin CORS and security headers on successes
  and failures. An unrelated origin receives no readable protected response.
- [ ] Real public-key verification succeeds in the deployed Worker, a token
  refresh works, and controlled expiry/refresh-failure checks return to sign-in
  without retry loops.
- [ ] Neither the public Worker nor production bundle uses local identity.
- [ ] Auth/network errors remain distinct from sample provider states. No
  Facebook requests, D1 writes, Cron jobs, or Discord messages are introduced.

## Required user inputs and setup

No credentials are needed to implement or run the offline/local tests. These
inputs unlock real login and deployed acceptance:

| Input | Exact value/action needed | Destination and timing |
| --- | --- | --- |
| Firebase project/Web app | Existing or new Spark project with a registered Web app. Supply public `apiKey`, `authDomain`, `projectId`, `appId` from Project settings. | Pages build variables `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`; Worker `FIREBASE_PROJECT_ID` must match. Needed for real login. |
| Google provider setup | Enable Google in Firebase Authentication, select the required support email, and authorize the final Pages hostname. | Console setup by the user/account administrator; no Google password/OAuth secret is needed. |
| Approved Google identities | Exact owner and tester emails, including an account available for add/remove testing. | Worker `APPROVED_EMAILS` JSON-array secret via secure local prompt/dashboard; never frontend config or committed source. |
| Rejection-test identity | Ability to sign in with an account initially outside the allowlist; this can be the test account before addition. | Human login during deployment checks. Do not paste passwords, cookies, or ID tokens into chat. |
| Cloudflare deployment access | Intended account and authenticated Wrangler session (`wrangler login`) or dashboard deployment access; identify account ID if multiple accounts are available. | Needed for provisioning/config/deployment only. A securely installed scoped token is an alternative for automation, not a requirement when login works. |
| Pages project/origin | Existing name and exact `https://<project>.pages.dev` origin, or preferred new project name and then the assigned origin. | Worker `ALLOWED_ORIGINS`, Firebase authorized hostname, deployed verification. |
| Worker project/origin | Reuse `marketplace-deal-finder-api` unless an existing deployment requires another name; confirm assigned `https://<worker>.<account-subdomain>.workers.dev` origin. | `VITE_API_BASE_URL`, CSP, and acceptance checks. Discover after setup; not needed to write code. |

The Firebase web API key is public application configuration, not a backend
credential; the Worker verifier and allowlist enforce access. A copied Firebase
config may include `messagingSenderId`/`storageBucket`, but neither is required
for this auth-only scope. See [Firebase web setup](https://firebase.google.com/docs/web/setup)
and [Firebase API-key guidance](https://firebase.google.com/support/guides/security-checklist#api-keys).

Not needed now: Firebase Admin/service-account JSON/private keys, Google OAuth
client secrets, Access team/AUD/client credentials, Facebook cookies/credentials,
eBay keys, proxy credentials, D1 IDs, Discord webhooks, a domain, or billing data.

If setup or human login is unavailable, finish local work and record exactly
which deployed checks remain; label the implementation **ready for deployed
verification**, not Phase 2 complete.

## Decisions and consequences for later phases

Record handoffs here; do not implement later features or rewrite other phase
plans during this planning task.

| Decision / unresolved handoff | Consequence for later implementation |
| --- | --- |
| Firebase Google + bearer tokens is the sole production identity contract. | Phase 3/5 handlers reuse the verifier, identity, errors, and CORS. Correct stale Access assumptions in `PLAN.md` and Phase 5 when maintaining them; do not introduce a second scheme. |
| `subject` is the verified UID; email controls admission. | Later ownership derives from server identity, never a browser-supplied user ID/email. Phase 2 creates no user/ownership schema. |
| Tester access does not settle tenancy. | Architecture/Phase 1 describe one owner, while `PLAN.md` mentions 1-5 users. Before storage/business APIs, decide shared owner data versus per-user settings/notifications. Do not assume testers may access another user's future records. |
| Static bundles are public; private data uses authenticated APIs. | Never embed real settings/listings, allowlists, provider secrets, or webhooks in browser assets. |
| Pages/Worker use separate origins and only GET methods initially. | Later PUT/POST routes must explicitly expand preflight methods/headers, reuse the API client, and define safe/idempotent mutation retries. |
| Logout neither stops monitoring nor revokes every issued token. | Background monitoring remains independent of browser sessions. Define removed-owner/disabled-account effects on scheduled work during backend implementation. |
| Browser identity is not Cron/Workflow identity. | Later internal work needs trusted bindings/boundaries; do not exempt public API routes from authentication for scheduler convenience. |
| Sample listings and simulated monitoring stay through Phase 2. | Phase 5 replaces the mock adapter; keep prototype labeling until integration is complete. |
| Marketplace/pricing conflicts are unresolved outside this phase. | `PLAN.md` includes eBay/multiple users and outlier-filtered pricing; architecture/Phase 3 use Facebook-only discovery and running aggregates. Reconcile before collection/schema/pricing work; auth work must not select a price model. |
| Phase 5 references Phases 2-4, but no Phase 4 plan exists. | Settle notification phase ownership and the missing plan before notification/integration work, without expanding Phase 2 into Discord. |

## Completion gate and planning review

Phase 2 is complete when all subtask and deployed criteria pass, implementation
checks are successful with any environment limitations recorded, real origins
are safely documented, and the Firebase runbook is usable. The deliverable is
an authorized prototype and protected Worker boundary ready for Phase 3A's
collection viability work.

Planning review:

- 2026-09-20: Agent A drafted the plan from implementation and phase evidence;
  Agent B then independently reviewed the saved draft and underlying code.
- The review resolved four areas: exact token/key-refresh boundaries, the CORS
  error behavior when origin configuration is invalid, pending mock-operation
  invalidation across identity changes, and deterministic local origins/ports
  without production Firebase credentials.
- Agent A accepted and applied all four findings. Agent B re-read the revised
  file and explicitly approved it; Agent A explicitly agreed. No substantive
  review findings remain open. This agreement approves the plan, not future
  implementation or deployment acceptance results.
