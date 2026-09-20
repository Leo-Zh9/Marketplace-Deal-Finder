# Phase 1 — Frontend Prototype

## Goal

Build the complete user-facing experience with **sample data only**.

At the end of this phase, the application should look and behave like the final product from the user's perspective, but it should not depend on Facebook Marketplace, D1, Workflows, Discord, or any backend service.

This phase establishes:

- the visual design and page layout;
- search controls and validation;
- listing cards and result states;
- monitoring controls and status displays;
- frontend data contracts that the backend will later satisfy.

The backend should be connectable later without redesigning the interface.

---

## Product Assumptions

The current product is designed for:

- one user;
- Facebook Marketplace only;
- 24/7 monitoring;
- a 30-minute monitoring interval;
- up to 9 component categories;
- newest 15 listings per selected component;
- CAD pricing;
- Discord notifications later.

Supported categories:

- CPU
- CPU Cooler
- Motherboard
- RAM
- Storage
- GPU
- PSU
- Case
- Case Fans

---

## Recommended Stack

- React
- TypeScript
- Vite
- Cloudflare Pages
- lightweight styling system of choice

Keep application state local to the frontend in this phase.

---

## Main User Flow

```text
Open app
   |
   v
Select components
   |
   v
Choose models / optional filters
   |
   v
Choose location + radius
   |
   v
Choose deal rule
   |
   v
Preview sample listings
   |
   v
Start monitoring
   |
   v
View monitoring state + sample deals
```

---

## Main Control Page

### Components

Provide checkboxes for all 9 categories.

Rules:

- at least one component is required;
- selected components reveal model/filter controls;
- none selected by default.

### Models

Each selected component receives a searchable model selector.

Behavior:

- `All` is the default;
- specific models may be selected;
- individual model selections do not imply one backend request per model;
- clearly distinguish `All`, specific models, and no selection.

### Location

Support UI for:

- city;
- postal code;
- address;
- current location.

For Phase 1, use mocked suggestions.

Suggested type:

```ts
interface SearchLocation {
  label: string;
  latitude: number;
  longitude: number;
}
```

### Radius

Initial options:

```text
2 km
5 km
10 km
25 km
Custom
```

Default: `25 km`.

### Deal Rule

Support:

```text
Discount
Maximum Price
Both
```

For `Discount`:

- minimum discount is required;
- default may be 25%.

For `Maximum Price`:

- positive CAD amount required.

For `Both`:

- both fields are required.

---

## Component-Specific Filters

Keep these UI controls available but frontend-only for now.

### CPU
- Manufacturer
- Socket

### CPU Cooler
- Cooling type
- Supported socket
- Maximum height
- Radiator size

### Motherboard
- Socket
- Chipset
- Memory type
- Form factor

### RAM
- Memory type
- Minimum capacity
- Module count
- Minimum speed

### Storage
- Storage type
- Minimum capacity
- Form factor

### GPU
- Manufacturer
- Minimum VRAM
- Maximum length
- Maximum slot width

### PSU
- Minimum wattage
- Form factor
- Required connectors

### Case
- Motherboard form factor
- Minimum GPU clearance
- Minimum cooler clearance
- Radiator size

### Case Fans
- Fan size
- Maximum thickness
- Connector

Use mock catalog options; do not build complex compatibility logic yet.

---

## Monitoring Controls

Provide:

```text
Preview
Start Monitoring
Stop Monitoring
```

Current assumption: monitoring runs 24/7 once enabled.

Mock states:

```text
STOPPED
STARTING
ACTIVE
DEGRADED
ERROR
```

Example status card:

```text
Monitoring: Active
Next scan: in 18 minutes
Facebook: Available
Last successful scan: 10:30 AM
```

---

## Listing Cards

Create one reusable card showing:

```text
title
component
identified model
price
location
distance
listing URL
observed time
deal status
estimated market average
estimated discount
```

Support statuses:

```text
DEAL
NOT_A_DEAL
NEEDS_REVIEW
PENDING
```

Example:

```text
ASUS RTX 4070 Super Dual
CAD $520

Model: RTX 4070 Super
Market Average: $685
Estimated Discount: 24.1%

Waterloo, ON
Observed 4 minutes ago

[View on Facebook]
```

---

## Mock Data

Suggested files:

```text
src/mocks/
  listings.ts
  componentCatalog.ts
  monitoringStatus.ts
```

Include fixtures for:

- a deal;
- a non-deal;
- unknown model;
- missing location;
- insufficient market data;
- zero results;
- Facebook unavailable;
- loading state.

Suggested listing interface:

```ts
interface Listing {
  listingId: string;
  componentType: string;
  modelKey: string | null;
  variantKey: string | null;
  title: string;
  priceCents: number;
  location: string | null;
  url: string;
  observedAt: string;
  evaluation: {
    status: "DEAL" | "NOT_A_DEAL" | "NEEDS_REVIEW" | "PENDING";
    averagePriceCents?: number;
    discountPercent?: number;
  };
}
```

---

## Frontend Data Contracts

Define now:

```text
SearchSettings
SearchLocation
ComponentSelection
Listing
EvaluationResult
MonitoringStatus
ProviderStatus
```

UI components must never depend on raw Facebook response shapes.

---

## Validation

At minimum:

- at least one component selected;
- location required;
- radius valid;
- discount 1–99 when required;
- maximum price positive when required;
- `Both` requires both values;
- hidden filters must not affect submitted settings.

Show errors inline.

---

## Responsive / Accessibility Requirements

Support desktop first but remain usable on tablet/mobile.

Suggested layout:

```text
Desktop:
left = controls
right = results

Mobile:
controls
then results
```

Minimum accessibility:

- labelled controls;
- keyboard navigation;
- visible disabled states;
- text-based errors, not color-only;
- clear status messages.

---

## Loading / Empty / Error States

Design these explicitly:

### Loading
`Searching Facebook Marketplace...`

### Empty
`No matching listings found.`

### Provider unavailable
`Facebook Marketplace is temporarily unavailable. Your monitoring settings are still saved.`

### Insufficient pricing data
`Needs Review — Not enough market observations yet.`

---

## Suggested Structure

```text
src/
  app/
    App.tsx

  components/
    ComponentSelector/
    ModelSelector/
    LocationSelector/
    RadiusSelector/
    DealRuleForm/
    ListingCard/
    ListingGrid/
    MonitoringControls/
    StatusPanel/

  pages/
    ControlPage.tsx

  mocks/
    listings.ts
    monitoringStatus.ts
    componentCatalog.ts

  types/
    search.ts
    listing.ts
    monitoring.ts

  utils/
    currency.ts
    validation.ts
```

---

## Testing

### Component tests

Test:

- component selection;
- model selection;
- conditional deal-rule fields;
- validation;
- listing states;
- monitoring controls.

### User-flow tests

At minimum:

1. select GPU;
2. select a location;
3. preview listings;
4. start monitoring;
5. stop monitoring.

Also test:

- all 9 components;
- zero results;
- Facebook unavailable;
- invalid price;
- switching deal rules.

---

## Out of Scope

Do not build yet:

- Facebook HTTP collection;
- D1;
- Workflows;
- Cron Triggers;
- Discord;
- real authentication;
- real price calculations;
- backend APIs.

Mock all of them.

---

## Acceptance Criteria

Phase 1 is complete when:

- frontend deploys to Cloudflare Pages;
- main control page represents the intended final UX;
- all 9 categories can be selected;
- model/location/radius/deal inputs work;
- mock listings render correctly;
- monitoring can be simulated;
- loading/empty/error/degraded states exist;
- frontend interfaces are defined;
- the full UI can be demonstrated without a backend.

---

## Deliverable

A deployable frontend prototype whose mock service layer can later be replaced with real APIs without redesigning the UI.
