# Plan
This is the overall plan of this application. This includes the problem statement, user workflow, and system architecture.

## Problem Statement
As an individual who builds and sells PCs, constantly browsing different reselling platforms to find the best deals on components is stressful, I want to have a centralized platform that will search all my desired platforms during a selected timeframe for the best deals on a selection of components within a selected area near me.

Scope: 1-5 private users, individual searches, CAD pricing, and a $0 recurring-service budget using free/open-source options. The current phase supports eBay's Browse API and Facebook Marketplace's HTTP provider with the response-body adapter under development. Routine checks default to 30 minutes; other marketplaces and browser fallback are deferred.

### User selections
 - "Components" and "Location" are the only required setup choices.
 - "Search radius" defaults to 25 km; "More filters" is collapsed by default.
 - Preview results, then select "Start monitoring".

### User selection parameters
- "Components": Checkboxes for "CPU", "CPU Cooler", "Motherboard", "RAM", "Storage", "GPU", "PSU", "Case", and "Case Fans". Initially empty; select at least one.
- "Location": Search by city, postal code, or address and select a result. "Use current location" requests device permission. Location remains editable; changing it updates the search center and displayed timezone.
- "Search radius": "2 km", "5 km", "10 km", "25 km" (default), or "Custom". Custom accepts 0.1-49.9 km in 0.1 km increments. Distance is straight-line distance from the selected location.
- "More filters": Contains the following optional controls; component-specific controls appear only for selected components.
- "Platforms": Checkboxes for "eBay" and "Facebook Marketplace". These select where alert candidates come from; market comparisons use observations across both supported platforms when available. Select all available platforms by default; unavailable platforms are disabled and labeled "Unavailable". At least one available platform is required to run a search. Deferred platforms are not shown in this phase.
- "Model": One searchable model selector per component type, searchable by brand or model name. "All" is the default and includes future catalog additions; unticking models creates exclusions. "None" clears the selection and matches nothing; selecting individual models creates an explicit selection. Sort models by release date, newest first, with unknown dates last.
- Component filters (exact labels):
    - CPU: "Manufacturer" (Any/Intel/AMD), "Socket"
    - CPU Cooler: "Cooling type" (Any/Air/AIO Liquid), "Supported socket", "Maximum height (mm)" (Air only), "Radiator size (mm)" (AIO Liquid only)
    - Motherboard: "Socket", "Chipset", "Memory type", "Form factor"
    - RAM: "Memory type", "Minimum capacity (GB)", "Module count", "Minimum speed (MT/s)"
    - Storage: "Storage type" (Any/HDD/SATA SSD/NVMe SSD), "Minimum capacity (GB)", "Form factor"
    - GPU: "Manufacturer" (Any/NVIDIA/AMD/Intel), "Minimum VRAM (GB)", "Maximum length (mm)", "Maximum slot width"
    - PSU: "Minimum wattage (W)", "Form factor", "Required connectors" (connector type and minimum count)
    - Case: "Motherboard form factor", "Minimum GPU clearance (mm)", "Minimum cooler clearance (mm)", "Radiator size (mm)"
    - Case Fans: "Fan size (mm)", "Maximum thickness (mm)", "Connector" (Any/3-pin/4-pin PWM)
- Filter behavior: Unset fields mean "Any". Socket, chipset, memory type, form factor, radiator size, and connector options come from the component catalog. Minimum/maximum fields are inclusive, positive numeric inputs; module counts are positive integers. Slot width accepts decimals. Different fields use AND; multiple choices within a field use OR, except required connectors, which must all be present in the requested quantities. Hidden, inapplicable fields do not restrict results. Missing required specifications produce "Needs review", not a confirmed match.
- "Deal rule": "Discount" (default), "Maximum price", or "Both". "Discount" uses the average unit price; "Maximum price" uses only a fixed listing-price limit; "Both" requires both conditions. Keep this control under "More filters".
- "Minimum discount (%)": Integer from 1-99, default 25; shown for "Discount" and "Both". Applies to each model's average unit price.
- "Maximum price (CAD)": Positive amount with up to two decimal places; initially blank, shown and required for "Maximum price" and "Both". Applies to the total listing price across the search, not per unit. An empty required field shows "Enter a maximum price." and prevents starting.
- Hidden pricing fields do not affect the selected rule. Fixed-price mode does not require a market estimate.
- "Search hours": "All day" (default), "Custom hours", or "Search once". Custom uses "Start time" and "End time" in HH:MM, default 09:00-22:00, in the displayed location timezone. Start is inclusive, end exclusive; an earlier end time means overnight. Equal times are invalid; use "All day" instead. "Search once" returns one result set without ongoing monitoring.
- Condition is not a setup choice: Search for seller-described working parts, new or used. Broken/for-parts listings are excluded; untested or unclear condition produces "Needs review". Compatibility filters narrow results; socket alone does not establish chipset/BIOS support.

## Algorithm

Every check gathers listing observations, evaluates unseen listings against the user's deal rule, and notifies the user of qualifying results. Percentage discounts use an outlier-filtered average unit asking price; a fixed maximum price can work independently of market data. Acquisition costs and resale profit are excluded.

### 1. Run a check and identify unseen listings
- Set `CHECK_INTERVAL_MINUTES = 30` as a configurable application variable. Check immediately when monitoring starts during active hours, then at this interval. Pause outside the selected hours and check again when they resume. "Search once" runs one check.
- Collect newly returned listings and update price observations for existing IDs when they are actually seen again. Process all available unseen results since the last successful check, including after downtime; do not limit candidates to listings posted in the last polling interval.
- Identify a listing only by `(platform, listing_id)`. Unseen means not yet evaluated for that user's current search settings. An observation collected for another user or for market pricing does not make a listing evaluated for everyone.
- Finish recording the current check's observations before evaluating candidates. Use that comparison-data snapshot throughout the check so results do not depend on processing order.
- Already evaluated IDs can refresh the reference data without triggering another normal deal evaluation. Listings awaiting missing details or sufficient pricing data remain pending and are retried when that evidence changes. Editing search settings allows reevaluation, but never clears notification history.

### 2. Validate, match, and normalize prices
- Extract listing ID/URL, location, observation time, total asking price P, currency, condition, model, specifications, and quantity q. Apply the selected platforms, components/models, location/radius, and specification filters; exclude definite mismatches. Missing required details produce "Needs review".
- Accept fixed CAD asking prices for available, complete, seller-described working items. Exclude wanted ads, services, auctions, deposits/installments, trade-only offers, and mixed-component bundles. An explicitly free item has P = 0; ambiguous zero/placeholder prices, untested condition, or missing required hardware require review.
- Resolve aliases to the same catalog model and value-affecting variant. Keep CPU suffixes, GPU variants/VRAM, motherboard revisions, RAM kit specifications, storage capacity, and PSU wattage distinct. A similarly performing component is not the same comparison product.
- Calculate unit price U = P / q. Quantity counts identical catalog sale units: one GPU, one SSD, or one complete factory kit. For example, a 2 x 16 GB RAM kit is one kit, not two independently valued modules. Compare like-for-like units; use quantity normalization only for clearly identified identical units. Unknown quantities require review.

### 3. Build the seven-day comparison set
- Set `REFERENCE_WINDOW_DAYS = 7`. At check time T, include references whose latest valid price observation occurred between T - 7 days and T, inclusive. This is observation recency, not posting age or first-seen age. A month-old listing observed today qualifies; a listing last observed eight days ago does not.
- A real repeat observation refreshes the timestamp and price. Reading a stored record or changing its status does not. Keep only the latest price per `(platform, listing_id)`, so checking one ad repeatedly contributes one data point, not hundreds.
- Pool valid observations across all supported platforms (currently eBay and Facebook Marketplace), regardless of which platforms the user selected for alerts. Match the same model/variant, sale unit, and condition group (New, Used-working, or Refurbished-working). Only positive reference prices enter the average.
- A listing later sold or removed can still contribute its last observed asking price until the seven-day window expires. It cannot generate a new deal alert once unavailable, and its asking price is never relabeled as a confirmed sale price.
- Start with references inside the user's search radius. If pricing evidence is insufficient or too variable, retry within 50 km of the same center, using the same seven-day window. Reference expansion never expands which listings can alert the user.
- Exclude the candidate's own platform/listing ID. Do not filter references by the user's discount, maximum price, or evaluated/notified status; those filters would distort the market average.
- Do not detect or merge reposts, cross-posts, photos, or seller identities. Different platform/listing IDs are separate observations, even for the same seller or physical item. A seller identifier is not required.

### 4. Remove outliers and calculate average unit price
- Require at least 5 distinct platform/listing IDs before and after outlier removal. If the local set fails, try the 50 km set; if that fails, the market estimate is unavailable with reason "Not enough comparable listings".
- Sort reference unit prices. Q1 and Q3 are the medians of the lower and upper halves, excluding the middle observation when the count is odd. An even-sized median is the average of its middle two values.
- Calculate IQR = Q3 - Q1. If positive, remove references below Q1 - 1.5 * IQR or above Q3 + 1.5 * IQR, once. If IQR is zero, skip trimming. Outlier removal applies only to comparison data; a cheap candidate is not rejected for being cheap.
- Calculate the arithmetic mean of the remaining unit prices: M = sum(U_i) / n. Each distinct listing has equal weight; a bulk listing does not gain extra weight from its quantity.
- Recalculate Q1 and Q3 on the retained references. If (Q3 - Q1) / M exceeds 0.35, try the broader radius; if that also fails, mark the estimate unavailable with reason "Comparable prices vary too widely".
- Calculate estimates for unseen/pending candidates from the current check's snapshot. Record the reference count, platform breakdown, radius, observation date range, and calculation time. M is an estimated average asking price, not a confirmed resale value.

### 5. Apply the selected deal rule
- Let D be the selected discount divided by 100 and L the fixed maximum listing price. Listing eligibility from step 2 must pass in every mode.
- "Discount": A deal requires a valid M and U <= M * (1 - D). Percentage discount is (M - U) / M.
- "Maximum price": A deal requires P <= L. This mode can alert without a market estimate; identify the reason as "Maximum price matched" and show unavailable market data as such.
- "Both": Require the discount condition AND P <= L. The absolute cap always applies to the total listing price, not the unit price.
- A definite failed condition returns "Not a deal"; in "Maximum price" or "Both", P > L can be rejected immediately without market data. Otherwise missing necessary evidence produces "Needs review" and remains pending. A valid M is required for "Discount" and for a "Both" candidate that passes its cap; it is not required for "Maximum price".
- Use integer-cent input prices and exact decimal/rational arithmetic for quantities, averages, and thresholds. Round only for display: two decimal places for CAD and one for percentages.
- Example: Reference unit prices of CAD 220, 230, 240, 250, 260, and 2,000 lose the 2,000 outlier, leaving M = CAD 240. A single-unit listing at CAD 180 meets a 25% discount. CAD 181 fails "Discount", passes "Maximum price" with L = CAD 200, and fails "Both" with those settings.
- Quantity example: Three identical units for CAD 540 have U = CAD 180 and meet that discount. A CAD 500 maximum rejects the listing in "Maximum price" or "Both" because P = CAD 540.

### 6. Notify once and retain processing state
- "Preview" and "Search once" do not consume monitoring's unseen/evaluated status or create notification records. The first monitoring check can alert on any currently qualifying, unnotified listing, including one previously shown in a preview.
- After evaluation, record the result for that user's current search. Keep pending evaluations and pending delivery separate; a failed notification must not be lost just because the listing has already been evaluated.
- Allow only one pending/successful notification per `(user, platform, listing_id)`, even when several searches match. Never notify again for that ID after successful delivery, including price drops or changes to the estimate/settings. Retain notification history independently of the seven-day price-data window.
- A repost with a new listing ID is unseen and eligible for another notification. Cross-platform posts also have different identities. Do not compare them to older posts to suppress alerts.
- Before sending, confirm the candidate is still available, still meets the current rule/filters, and has an active matching search. Retry explicit delivery failures using the same pending notification; uncertain delivery outcomes require review instead of a blind resend.
- Use Discord as the initial channel, configured once per user. Include model, total price, quantity/unit price when relevant, the matching rule, average unit price and discount when available, reference count/radius, location, observation time, and listing link. Show an unavailable source as "Unavailable", not as zero matches.

## User Workflow
The website will serve as the user's primary high-level control system, where they can perform their selections.

Login ----> Control Page ----> "Components" ----> "Location" ----> "Preview" ----> "Start monitoring"

"Search radius" and "More filters" remain editable on the Control Page. "Search once" replaces "Start monitoring" in one-time mode. Configure the Discord destination once before enabling notifications; previewing results does not require it.

## System Architecture

The application uses a lightweight cloud architecture designed for 1-5 private users and a $0 recurring-service budget. The current implementation phase supports only:

* **eBay** through the official eBay Browse API.
* **Facebook Marketplace** through a custom HTTP provider that reproduces the structured requests used by Facebook's web client.

Karrot, Kijiji, Playwright/browser fallback, and additional marketplaces are deferred.

The architecture separates:

1. User interface and authentication.
2. API/backend responsibilities.
3. Scheduled orchestration.
4. Marketplace acquisition.
5. Persistent storage.
6. Deal evaluation.
7. Notifications.

The major architectural constraint is Cloudflare Workers Free's **10 ms active CPU limit per invocation**. Rather than attempting to complete an entire monitoring cycle inside one Cron invocation, the Cron Trigger starts a **Cloudflare Workflow**. The Workflow divides the cycle into many small, bounded steps, with each step receiving its own CPU allowance.

Cloudflare currently documents 10 ms compute per Workflow step on Workers Free, unlimited wall-clock duration while waiting on network/database I/O, up to 1,024 steps per Free Workflow instance, and 3,000 included Workflow steps per day.

---

### 1. High-Level Architecture

```text
                            User
                              |
                              v
                     Cloudflare Pages
                  React + TypeScript + Vite
                       Public app shell
                              |
                              v
                   Firebase Authentication
                 Google sign-in in the browser
                       Firebase ID token
                              |
                              v
                     Cloudflare Worker
                       Application API
                              |
               +--------------+--------------+
               |                             |
               v                             v
         User API calls               Cloudflare Cron
   Firebase ID token verified                |
     and allowlist checked                   |
                                             |
                                      every 30 minutes
                                             |
                                             v
                                      Start Workflow
                                             |
                                             v
                                Monitoring Workflow Instance
                                             |
                     +-----------------------+----------------------+
                     |                       |                      |
                     v                       v                      v
              eBay acquisition       Facebook acquisition      D1 state
                     |                       |
                     v                       v
              eBay Browse API        Facebook HTTP Provider
                     |                       |
                     v                       v
                API Adapter           Response Adapter
                     |                       |
                     +-----------+-----------+
                                 |
                                 v
                         Normalized Listings
                                 |
                                 v
                      Incremental D1 Persistence
                                 |
                                 v
                       Bounded Deal Evaluation
                                 |
                                 v
                          Discord Webhook
```

A provider failure does not fail the entire monitoring cycle. If Facebook is unavailable, eBay observations continue through the pipeline, and vice versa.

---

### 2. Frontend

Use:

```text
React
TypeScript
Vite
Cloudflare Pages
```

Cloudflare states that requests for static Pages assets are free and unlimited. Pages Functions, if used, instead count against the normal Workers Free request quota.

The frontend is responsible only for presentation and user configuration:

* Component and model selection.
* Location and search radius.
* eBay/Facebook platform selection.
* Deal rules.
* Search hours.
* Preview.
* Search once.
* Starting/stopping monitoring.
* Provider and monitoring status.

The frontend never communicates directly with eBay or Facebook and never receives marketplace/proxy credentials.

---

### 3. Authentication

Use **Firebase Authentication with Google sign-in**, checked in the Worker against an explicit email allowlist, for the application's 1-5 private users. This is the mechanism Phase 2 built (`PHASE_2_LOGIN_PRIVATE_ACCESS.md`).

```text
User
 |
 v
Google sign-in popup (Firebase browser SDK)
 |
 v
Firebase ID token, sent as Authorization: Bearer <token>
 |
 v
Cloudflare Worker verification
 |
 +---- token and policy valid ------> Application
 |
 +---- no token --------------------> 401 AUTH_TOKEN_MISSING
 |
 +---- token not valid -------------> 401 AUTH_TOKEN_INVALID
 |
 +---- policy refuses --------------> 403 AUTH_FORBIDDEN
```

The Worker verifies the token's RS256 signature against Google's public X.509 signing certificates for Firebase ID tokens, then checks issuer, audience and expiry explicitly against the Firebase project ID. It then applies policy: `email_verified` must be true, the sign-in provider must be `google.com`, and the address must be a member of `APPROVED_EMAILS`, compared exactly after trimming and lowercasing. When Google's certificates cannot be fetched at the moment they are needed, the Worker fails closed with 503 `AUTH_KEYS_UNAVAILABLE`, which a client may retry — unlike the configuration 503s below, which need a human.

`APPROVED_EMAILS` is a **Worker secret** holding a JSON array of email strings. It is never committed, never sent to the browser, and never returned in an error. Missing, malformed or empty configuration fails closed with a 503. The allowlist is re-read on every request.

The browser app and the Worker API are **separate origins**. The Worker answers only the exact origins listed in its `ALLOWED_ORIGINS` var and refuses any other explicit `Origin` with 403 `CORS_ORIGIN_DENIED`.

Access is removed by editing the allowlist secret. **This phase has no token revocation**: a removed address is denied on its next request, but an already issued ID token is not invalidated, and signing out does not revoke it. Firebase account-disable and immediate token-revocation checks are deferred.

Local development is credential-free. With `APP_ENV=local` on a loopback host the Worker returns a `local-development` identity and verifies no token, so `npm run dev:full` needs no Firebase project and no secret.

Firebase Authentication on the **Spark (free) plan** covers this scope. No Cloudflare Zero Trust organization, no purchased domain, and no paid service is required.

No public registration system or custom password database is required.

---

### 4. Application Worker

Use one Cloudflare Worker application for the website API and Workflow definitions.

The Worker handles:

```text
/api/searches
/api/preview
/api/search-once
/api/monitor/start
/api/monitor/stop
/api/status
```

It also contains:

```text
Marketplace provider interfaces
Normalization code
Deal evaluation code
Workflow definitions
Discord notification code
D1 access layer
```

Cloudflare Workers Free currently provides:

```text
100,000 Worker requests / day
10 ms CPU / HTTP invocation
10 ms CPU / Cron invocation
128 MB memory
5 Cron Triggers / account
```

Waiting for `fetch()`, database queries, and other network I/O does not count toward active CPU time.

The application should therefore treat CPU-heavy parsing, sorting, model matching, and pricing calculations differently from network waiting.

---

### 5. Monitoring Trigger

Use only **one** Cloudflare Cron Trigger for routine monitoring.

```cron
*/30 * * * *
```

This executes:

```text
48 times/day
```

for an all-day monitoring schedule.

The Cron handler itself performs almost no monitoring work.

Its responsibility is:

```text
Cron fires
    |
    v
Check whether monitoring work exists
    |
    v
Create MonitoringWorkflow instance
    |
    v
Return
```

It must not:

```text
Fetch all eBay listings
Fetch all Facebook listings
Parse everything
Calculate all prices
Send every notification
```

inside the Cron invocation.

Cloudflare currently allows **5 Cron Triggers per Free account**. This architecture uses only one, preserving four triggers for future functionality.

---

### 6. Monitoring Workflow

Each routine Cron execution starts one `MonitoringWorkflow`.

Conceptually:

```typescript
class MonitoringWorkflow extends WorkflowEntrypoint {
    async run(event, step) {
        // bounded steps
    }
}
```

The Workflow performs the complete monitoring cycle as individually bounded operations.

```text
Workflow
   |
   v
Step: build work plan
   |
   +--------------------------+
   |                          |
   v                          v
eBay work                 Facebook work
   |                          |
   v                          v
bounded pages             bounded pages
   |                          |
   +------------+-------------+
                |
                v
        persist changed data
                |
                v
       evaluate candidate batch
                |
                v
       evaluate next batch
                |
                v
         create notifications
                |
                v
          send notifications
```

Cloudflare Workflows Free currently provides:

```text
10 ms active CPU per step
Unlimited wall-clock waiting per step
1,024 maximum steps per Workflow instance
3,000 included Workflow steps/day
1 MiB maximum normal result returned from a step
100 MB maximum persisted state per Workflow instance
100,000 Workflow executions/day,
shared with Workers' daily request allowance
```

The application does not come remotely close to the Workflow execution count, but the **3,000 steps/day** limit must be treated as the main Workflow resource budget.

---

### 7. Workflow Step Budget

There are 48 routine cycles per day.

Therefore:

```text
3,000 free steps/day
÷ 48 cycles/day

= 62.5 steps/cycle
```

Using all 62 would leave no room for:

* Immediate monitoring-start checks.
* Previews.
* Search-once requests.
* Retries.
* Operational overhead.

Set:

```text
MAX_ROUTINE_STEPS = 40
```

as an initial hard application budget.

This gives:

```text
40 × 48
= 1,920 routine steps/day
```

leaving approximately:

```text
3,000 - 1,920
= 1,080 steps/day
```

for non-routine work.

The actual normal target should be lower:

```text
TARGET_ROUTINE_STEPS = 20-30
```

The 40-step value is a ceiling, not a target.

If the Workflow reaches its work budget while unprocessed work remains, it saves a continuation cursor/state in D1 and stops normally. The next routine monitoring cycle resumes that work.

Do not recursively create unlimited continuation Workflows.

---

### 8. Keeping Individual Steps Under 10 ms CPU

A Workflow step must perform a **small, bounded amount of active computation**.

Bad design:

```text
one step:

parse 1,000 listings
normalize 1,000 listings
sort pricing observations
evaluate 500 candidates
write everything
```

Preferred design:

```text
step:
fetch + parse one marketplace page

step:
normalize one small page

step:
persist one small listing batch

step:
evaluate 20 candidates

step:
evaluate next 20 candidates
```

Initial configurable limits:

```text
EBAY_PAGE_SIZE = 50

NORMALIZE_BATCH_SIZE = 25

PERSIST_BATCH_SIZE = 25

EVALUATION_BATCH_SIZE = 20

MAX_ROUTINE_STEPS = 40
```

These are engineering starting points, not guaranteed values.

Production measurements determine their final values.

Target:

```text
p95 step CPU < 8 ms
```

rather than intentionally operating at exactly Cloudflare's 10 ms ceiling.

If a step approaches the CPU limit:

```text
reduce batch size
```

rather than moving unrelated work into another Cron Trigger.

Cloudflare explicitly states that external-network and storage waiting does not consume CPU time, while actual computation does.

---

### 9. Workflow State

Large marketplace responses must not be passed between Workflow steps.

Cloudflare currently limits normal step results to **1 MiB**.

Therefore, a step should not return:

```text
{
    listings: [hundreds of complete listing objects]
}
```

Instead:

```text
Marketplace fetch
       |
       v
parse + normalize bounded page
       |
       v
persist necessary data to D1
       |
       v
return only:
{
    nextCursor,
    processedCount,
    providerStatus
}
```

Workflow state should consist primarily of:

* Pagination cursor.
* Search/query ID.
* Current batch position.
* Counts.
* Provider status.
* Continuation state.

D1 remains the durable source of application data.

---

### 10. eBay Provider

Use the official **eBay Browse API**.

The Browse API provides:

```text
GET /item_summary/search
GET /item/{item_id}
```

for searching listings and retrieving individual item information. All Browse API methods require an application access token.

Flow:

```text
eBay Workflow Step
      |
      v
Browse API search
      |
      v
API response
      |
      v
eBay adapter
      |
      v
Normalized Listing[]
```

The application does not use:

```text
checkout
orders
bidding
purchasing
```

#### API Budget

eBay currently documents a standard Browse API limit of:

```text
5,000 API calls/day
```

for Browse API methods.

Use the following safeguards:

```text
Deduplicate equivalent user queries

Fetch result pages rather than one API request per listing

Only fetch individual item details when necessary

Set a daily application-side eBay call counter

Set a conservative soft limit below 5,000/day
```

For example, even:

```text
20 eBay calls/routine cycle
× 48 cycles

= 960 calls/day
```

leaves substantial API headroom.

#### Production Access Caveat

This is an important implementation dependency:

eBay currently states that production use of many Buy APIs, including Browse, requires approval through the eBay Partner Network/Developer process and **approval is not guaranteed**. Sandbox access is available to developers before production approval.

Therefore:

```text
Development:
eBay Sandbox

Production:
requires eBay production approval
```

This should be resolved early.

---

### 11. Facebook Marketplace Provider

Facebook Marketplace uses a custom HTTP-only provider in the current phase.

There is no browser service in the production architecture yet.

```text
Facebook Workflow
       |
       v
Bootstrap public web session
       |
       v
Discover current request metadata
       |
       v
Construct Marketplace web request
       |
       v
Receive structured response
       |
       v
Response-body adapter
       |
       v
Normalized Listing[]
```

The implementation should dynamically discover routine web-client request metadata instead of permanently hardcoding values that may rotate.

Conceptually:

```text
bootstrapSession()

discoverMarketplaceOperation()

search()

paginate()

normalize()
```

Current third-party Marketplace implementations provide evidence that this architecture is technically viable: multiple current Apify Marketplace Actors report using direct HTTP, dynamically deriving Facebook's current GraphQL operation/session information from the live web frontend, and paginating structured Marketplace responses without running a browser. This is implementation evidence, **not an official Meta API or stability guarantee**.

#### Facebook Workflow Partitioning

Do not fetch every Facebook page in one Workflow step.

Use:

```text
Step
    bootstrap

Step
    obtain first result page

Step
    process first result page

Step
    obtain next result page

Step
    process next result page
```

Each page is bounded.

If acquisition returns a recognized valid empty result:

```text
SOURCE_EMPTY
```

If the expected response format cannot be interpreted:

```text
PROVIDER_FAILURE
```

If Facebook explicitly returns a checkpoint, CAPTCHA, block, or equivalent restriction:

```text
UNAVAILABLE
```

The application does not attempt to circumvent the restriction.

A Facebook failure does not prevent eBay data from being processed.

---

### 12. Shared Marketplace Provider Interface

Both providers expose the same logical interface:

```typescript
interface MarketplaceProvider {
    search(
        query: MarketplaceSearch,
        cursor?: string
    ): Promise<ProviderPage>;

    getListing?(
        listingId: string
    ): Promise<ProviderResult<ListingDetails>>;

    healthCheck(): Promise<ProviderHealth>;
}
```

A page result includes:

```typescript
interface ProviderPage {
    status:
        | "SUCCESS"
        | "SOURCE_EMPTY"
        | "PROVIDER_FAILURE";

    listings: Listing[];

    nextCursor?: string;
}
```

The rest of the application does not know whether data came from:

```text
eBay REST API

or

Facebook structured HTTP response
```

---

### 13. Normalized Listing

Both providers produce:

```typescript
interface Listing {
    platform: "ebay" | "facebook";

    listingId: string;
    url: string;

    title: string;

    priceCents: number | null;
    currency: string | null;

    condition: string | null;
    quantity: number | null;

    locationText: string | null;
    latitude: number | null;
    longitude: number | null;

    postedAt: Date | null;
    observedAt: Date;

    available: boolean | null;
}
```

The deal engine operates only on this representation.

Marketplace-specific raw fields may be stored separately for debugging but must not leak marketplace-specific logic into the deal engine.

---

### 14. Persistent Database

Use **Cloudflare D1**.

Current Free limits are:

```text
5,000,000 rows read/day
100,000 rows written/day
5 GB total account storage
500 MB maximum size per Free D1 database
```

Suggested tables:

```text
users

searches
search_filters

component_models
component_specs

listings
listing_observations

search_evaluations
notifications

provider_status
workflow_state
check_runs
```

Listing identity:

```text
UNIQUE(platform, listing_id)
```

---

### 15. D1 Write Strategy

The application must not write every unchanged listing every 30 minutes.

That would unnecessarily consume the 100,000-row/day write limit.

Persistence rules:

```text
New listing
    -> WRITE

Price changed
    -> WRITE

Important normalized field changed
    -> WRITE

Availability changed
    -> WRITE

New notification
    -> WRITE

Evaluation state changed
    -> WRITE

Completely unchanged listing
    -> normally NO WRITE
```

For observation-recency tracking, use a bounded heartbeat:

```text
LISTING_HEARTBEAT_INTERVAL = 6 hours
```

An unchanged listing receives a persisted `last_seen_at` refresh only when its previous persisted heartbeat is at least six hours old.

This means a continuously visible unchanged listing generates at most approximately:

```text
4 heartbeat writes/day
```

rather than:

```text
48 writes/day
```

with 30-minute polling.

The seven-day comparison window therefore has observation recency accurate to within approximately six hours for unchanged listings.

If exact every-30-minute observation timestamps become a hard requirement later, the D1 write budget must be recalculated.

---

### 16. D1 Read Strategy

Use indexes for frequently queried columns:

```text
(platform, listing_id)

(model_id, condition_group, last_seen_at)

(search_id, evaluation_status)

(user_id, platform, listing_id)

notification_status
```

Avoid full-table scans.

Cloudflare specifically recommends indexing D1 workloads to reduce rows read when operating under Free-tier limits.

The deal evaluator should retrieve only:

```text
same normalized model/variant
matching condition group
last_seen_at within seven days
relevant geographic range
```

rather than loading all stored observations into Worker memory.

---

### 17. Deal Evaluation Workflow

Deal evaluation is performed incrementally.

```text
Load candidate IDs
       |
       v
Take first 20
       |
       v
Load comparable observations
       |
       v
IQR filtering
       |
       v
Calculate mean
       |
       v
Evaluate rule
       |
       v
Persist results
       |
       v
More candidates?
   /            \
 yes             no
  |               |
next step       continue
```

Initial:

```text
EVALUATION_BATCH_SIZE = 20
```

If CPU telemetry shows substantial headroom, increase it.

If CPU approaches 10 ms, decrease it.

Never dynamically process an unbounded number of candidates in a single step.

---

### 18. Notifications

Use **Discord Incoming Webhooks**.

Discord documents Incoming Webhooks as a way to post messages to channels without requiring a bot user or separate authenticated bot connection.

Flow:

```text
Qualifying deal
      |
      v
Create pending notification
      |
      v
Verify listing still qualifies
      |
      v
POST Discord webhook
      |
      v
Success?
  /       \
yes        no
 |          |
sent       retain pending
```

Enforce:

```text
UNIQUE(user_id, platform, listing_id)
```

for pending/successful notifications.

---

### 19. Workflow Failure and Recovery

Every step should be idempotent.

For example:

```text
Step retries eBay page
        |
        v
same listing IDs returned
        |
        v
UPSERT / duplicate protection
        |
        v
no duplicate logical listing
```

Likewise, notification delivery state must be persisted before sending.

The Workflow should record:

```text
check_id
started_at
completed_at
provider statuses
current stage
current cursor
steps consumed
listings processed
candidates evaluated
notifications sent
```

If the Workflow reaches its application-defined step ceiling:

```text
save continuation state
        |
        v
finish successfully
        |
        v
resume on next scheduled cycle
```

This prevents a large marketplace result set from consuming the entire daily Workflow allocation.

---

### 20. Resource Guardrails

The application should explicitly enforce free-tier budgets rather than merely hoping usage stays below them.

#### Cloudflare Worker

```text
100,000 requests/day
```

Routine monitoring creates only 48 scheduled starts/day, so request count is not expected to be a meaningful constraint.

#### Cron

```text
5 active Cron Triggers available
1 used
4 reserved
```

#### Workflows

```text
3,000 steps/day

Routine ceiling:
40 × 48
= 1,920/day

Remaining:
~1,080/day
```

Cloudflare states that Workers Free customers are not charged for Workflow step/storage usage beyond the Free-plan included amounts.

#### D1

```text
5,000,000 rows read/day
100,000 rows written/day
500 MB/database
5 GB/account
```

On Workers Free, D1 now **fails queries after the daily read/write limit is exceeded rather than silently charging for overage**; access resumes after the daily limit resets.

Application soft limits should therefore be lower:

```text
D1 writes warning:
60,000/day

D1 writes stop/defer threshold:
80,000/day

Workflow steps warning:
2,300/day

Workflow new-work stop threshold:
2,700/day

eBay API warning:
3,500/day

eBay API new-work stop threshold:
4,500/day
```

The remaining margin protects against previews, retries, immediate monitoring starts, and unexpected spikes.

---

### 21. Final Routine Monitoring Flow

```text
Cloudflare Cron
every 30 minutes
        |
        v
Start MonitoringWorkflow
        |
        v
Step 1
Build active-search work plan
        |
        +-----------------------------+
        |                             |
        v                             v
Step 2+                         Step N+
eBay pages                     Facebook bootstrap/pages
        |                             |
        v                             v
eBay adapter                  Facebook response adapter
        |                             |
        +--------------+--------------+
                       |
                       v
               Normalized listings
                       |
                       v
             Bounded persistence steps
                       |
                       v
            Current snapshot complete
                       |
                       v
             Candidate ID generation
                       |
                       v
              Evaluation batch #1
                       |
                       v
              Evaluation batch #2
                       |
                      ...
                       |
                       v
               Persist evaluations
                       |
                       v
               Notification steps
                       |
                       v
              Persist check summary
                       |
                       v
                    Finish
```

---

### 22. Deployment Components

```text
Frontend
    Cloudflare Pages

Authentication
    Firebase Authentication - Google sign-in
    Worker-verified ID tokens, APPROVED_EMAILS allowlist secret

Application API
    Cloudflare Workers

Routine scheduler
    1 Cloudflare Cron Trigger

Orchestration
    Cloudflare Workflows

Persistent database
    Cloudflare D1

eBay acquisition
    eBay Browse API

Facebook acquisition
    Custom HTTP Marketplace provider

Browser automation
    Deferred / not deployed

Notifications
    Discord Incoming Webhooks
```

---

### 23. Design Principles

1. **One Cron, many bounded Workflow steps.** Cron schedules work; it does not perform the entire monitoring cycle.
2. **Stay comfortably below 10 ms.** Step batch sizes are configurable and tuned using measured CPU usage.
3. **Bound all work.** No marketplace page, candidate list, or database batch is processed without an explicit size limit.
4. **HTTP-only acquisition for this phase.** eBay uses its official API; Facebook uses the custom HTTP adapter.
5. **Normalize immediately.** Marketplace-specific data becomes the common `Listing` representation before entering the deal engine.
6. **Persist incrementally.** New and changed listings are written immediately; unchanged listings are not rewritten every 30 minutes.
7. **Preserve free-tier margin.** Routine monitoring is capped well below Cloudflare's daily limits.
8. **Resume instead of overflowing.** Work that cannot fit inside a routine Workflow's budget is carried forward.
9. **Provider failures are isolated.** Facebook failure does not prevent eBay processing.
10. **Undocumented sources remain replaceable.** Facebook acquisition is isolated because its web interface has no stability contract.
11. **No local machine dependency.** All production monitoring, storage, evaluation, and notifications run in cloud-hosted services.
12. **Measure before increasing workload.** CPU, Workflow steps, D1 rows, and eBay calls are recorded and monitored before increasing result/page/batch limits.
