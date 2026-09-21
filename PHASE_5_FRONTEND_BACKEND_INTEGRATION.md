# Phase 5 — Connect Frontend and Backend

## Goal

Replace Phase 1 sample data with the real backend built in Phases 2–4.

At the end of this phase the complete user flow should work:

```text
Login
  |
  v
Configure search
  |
  v
Save settings / Preview
  |
  v
Start monitoring
  |
  v
Facebook scans every 30 min
  |
  v
Listings + evaluations appear in UI
  |
  v
Discord receives qualifying deals
```

This phase should mostly be integration work, not new backend architecture.

---

## Integration Principle

The frontend depends only on **application APIs**.

It must never directly access:

- Facebook;
- D1;
- Discord;
- Workflow internals.

The Cloudflare Worker API is the boundary.

---

## Suggested API Surface

Keep it small.

### Search Settings

```text
GET  /api/settings
PUT  /api/settings
```

### Monitoring

```text
POST /api/monitoring/start
POST /api/monitoring/stop
GET  /api/monitoring/status
```

### Listings

```text
GET /api/listings
```

Optional filters:

```text
component
evaluation_status
limit
```

### Service Status

```text
GET /api/status
```

### Preview

If retained:

```text
POST /api/preview
```

Preview must not create notification history.

---

## Search Settings Payload

Example:

```json
{
  "components": ["gpu", "cpu"],
  "models": {
    "gpu": ["RTX_4070_SUPER"],
    "cpu": ["RYZEN_7_7800X3D"]
  },
  "location": {
    "label": "Waterloo, ON",
    "latitude": 43.4643,
    "longitude": -80.5204
  },
  "radiusKm": 25,
  "dealRule": {
    "type": "discount",
    "minimumDiscountPercent": 25
  }
}
```

Frontend validates for usability, but backend validation remains authoritative.

---

## Search Revision Behavior

When settings change:

```text
frontend PUT /api/settings
        |
        v
backend validates
        |
        v
new search_revision
        |
        v
next monitoring run uses new revision
```

UI message:

```text
Settings saved. New settings will apply to the next monitoring scan.
```

An immediate scan can be added later if desired, but is not required initially.

---

## Monitoring Controls

### Start

```text
POST /api/monitoring/start
```

Backend:

- marks monitoring enabled;
- confirms settings are valid;
- may trigger an initial run;
- returns current monitoring state.

### Stop

```text
POST /api/monitoring/stop
```

Backend:

- future routine scans skip collection;
- historical notification identities remain;
- existing aggregate state is not corrupted.

---

## Replace Mock Services

Phase 1 should have mock functions such as:

```text
mockListings()
mockStatus()
mockSaveSettings()
```

Replace with API-backed services:

```text
getListings()
getStatus()
saveSettings()
startMonitoring()
stopMonitoring()
```

UI components should require minimal changes.

---

## Listings View

Render real fields:

```text
title
component
model
price
location
Facebook URL
last seen
evaluation status
market average
discount
```

Support:

```text
DEAL
NOT_A_DEAL
NEEDS_REVIEW
PENDING
```

For pending evaluations show the backend-provided reason, for example:

```text
Waiting for enough market data
```

---

## Monitoring Status

Display real service state.

Example:

```text
Monitoring: Active
Last Run: 2:30 PM
Last Successful Facebook Search: 2:30 PM
Next Scheduled Scan: 3:00 PM

Facebook: Available
Database: Available
Discord: Available
```

If degraded:

```text
Facebook: Temporarily unavailable
Last successful scan: 1:30 PM
```

Never display zero listings as a substitute for a failed provider.

---

## Loading / Error Handling

Every API-backed surface needs:

```text
loading
success
empty
error
unauthorized
degraded
```

### Settings Save Failure

Keep unsaved form state and show:

```text
Could not save settings. Your previous monitoring settings are still active.
```

### Listing Fetch Failure

Do not immediately erase previously displayed data.

Show stale/error status.

### Authentication Expired

A 401 (`AUTH_TOKEN_MISSING` or `AUTH_TOKEN_INVALID`) is an identity event, not a Facebook/backend failure. **For the GET reads**, reuse the Phase 2 path: retry once with a force-refreshed Firebase ID token, and if that also fails, return the user to Google sign-in.

That path is GET-only — Phase 2's client issues no other method. **Mutation retry policy remains deferred** (`PHASE_2_LOGIN_PRIVATE_ACCESS.md`, subtask 2.4, item 4: "Defer mutation retry policy until business APIs exist"). This phase is where those APIs arrive, so decide it when `PUT /api/settings`, `POST /api/monitoring/start`, `POST /api/monitoring/stop` and `POST /api/preview` are built. Do not assume the GET retry generalises to them.

A 403 `AUTH_FORBIDDEN` means the signed-in Google account is not approved — for example, it was removed from the allowlist. Show access denied with sign-out/change-account, again not a provider failure.

---

## Frontend Polling

No WebSocket is required initially.

Simple application polling is sufficient.

Example:

```text
monitoring status -> every 30–60 seconds while page is open
listings -> manual refresh or periodic refresh
```

Backend monitoring continues independently when the browser is closed.

---

## API Contracts

Define stable response interfaces.

Example:

```ts
interface MonitoringStatusResponse {
  enabled: boolean;
  state: "STOPPED" | "ACTIVE" | "DEGRADED" | "ERROR";
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  services: {
    facebook: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
    database: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
    discord: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  };
}
```

The frontend should not infer service status from missing data.

---

## Authentication Integration

Every `/api/*` route must reuse the identity path established in Phase 2: the Worker authenticates the request before dispatching any handler, except a valid CORS preflight. Do not introduce a second scheme.

That means each request carries a Firebase ID token as `Authorization: Bearer <token>`, which the Worker verifies against Google's X.509 certificates and then checks against the `APPROVED_EMAILS` allowlist secret. Because the app and the Worker are separate origins, every new route also depends on the Worker's exact-origin `ALLOWED_ORIGINS` check; an unapproved origin is refused with 403 `CORS_ORIGIN_DENIED`.

Test direct API calls without authentication.

Expected:

```text
denied
```

---

## Full End-to-End Test

Perform one controlled full-system test:

1. login;
2. select one component;
3. choose location/radius;
4. choose deal rule;
5. save settings;
6. start monitoring;
7. confirm backend search revision;
8. run/wait for monitoring Workflow;
9. verify Facebook results stored;
10. verify model totals;
11. verify evaluation results;
12. confirm listings appear in frontend;
13. use/force a qualifying test deal;
14. confirm Discord alert;
15. refresh frontend;
16. confirm monitoring remains active;
17. change search parameters;
18. confirm new revision;
19. verify next scan uses new settings;
20. confirm previously alerted listing does not duplicate.

---

## Search-Change Test

Important scenario:

```text
Hour 0:
GPU
max price = $500

Hour 1:
change max price = $600
```

Expected:

- new search revision stored;
- next run uses $600;
- unchanged stored listings not evaluated under the new revision become eligible;
- notification history remains;
- previously notified listing does not alert again.

---

## Failure Integration Tests

### Facebook Unavailable

Frontend should show:

```text
Monitoring: Degraded
Facebook: Unavailable
```

Previously stored data remains visible.

### D1 Unavailable

Frontend receives real backend failure/degraded state.

Do not claim monitoring succeeded.

### Discord Unavailable

Deal still appears in UI.

Notification state remains pending/failed/unknown as appropriate.

### Cleanup Failure

Monitoring remains operational.

Maintenance degradation may be surfaced separately.

---

## Performance Verification

Measure the real combined system:

```text
Workflow steps/day
CPU per step
D1 rows read
D1 rows written
Facebook request count
database size
notification count
```

Do not rely only on theoretical design estimates.

---

## Production Checklist

Before declaring the project complete:

- Firebase Google sign-in enabled, the Worker's `FIREBASE_PROJECT_ID` var set to that same project, the `APPROVED_EMAILS` allowlist secret set, and the production app origin listed both in Firebase Authorized domains and in the Worker's `ALLOWED_ORIGINS`;
- Worker secrets configured;
- D1 production database migrated;
- 30-minute monitoring Cron configured;
- daily noon cleanup Cron configured;
- Discord webhook configured;
- frontend API base URL correct;
- local/mock flags disabled in production;
- provider failures surfaced honestly;
- basic logs/telemetry available.

---

## Mock Data After Integration

Do not necessarily delete fixtures.

Keep them for:

- component tests;
- UI development;
- regression tests.

But production must never silently fall back to fake listings.

If backend fails:

```text
show real failure
```

not:

```text
show sample data
```

---

## Acceptance Criteria

Phase 5 is complete when:

- user can authenticate;
- search controls save to real backend;
- monitoring can start/stop;
- Facebook monitoring runs independently of browser;
- real listings appear in UI;
- evaluations/averages display correctly;
- search changes create new revisions;
- Discord alerts work;
- service failures appear honestly;
- mock data is not used in production;
- complete system works after closing/reopening the website.

---

## Final Deliverable

A complete private Facebook Marketplace PC-component deal monitor:

```text
User configuration
      |
      v
Cloudflare backend
      |
      v
Facebook Marketplace
      |
      v
D1 running price model
      |
      v
Deal evaluation
      |
      +--> Website
      |
      +--> Discord
```

The project is complete only after the deployed end-to-end flow works reliably, not merely when the individual modules work in isolation.
