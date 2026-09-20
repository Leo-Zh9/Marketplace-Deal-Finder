# Phase 2 deployment setup

This runbook will be completed alongside the Firebase implementation.

Target services:

```text
Firebase Authentication — Google sign-in
Cloudflare Pages       — generated pages.dev frontend
Cloudflare Workers     — generated workers.dev API
```

No Cloudflare Zero Trust organization, Cloudflare Access policy, credit card,
or custom domain is required by the Phase 2 design.

Production configuration will require:

- Firebase web configuration;
- Firebase project ID;
- the exact Pages origin;
- an approved-email Worker secret.

Local development continues to use `npm run dev:full` without Firebase login.
