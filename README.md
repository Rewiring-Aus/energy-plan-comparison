# Bill Comparison Tool

An Australian electricity **bill comparison tool**. Describe your home in plain language,
shape your hour-by-hour usage, and watch every plan re-rank live by total cost.

Built for Rewiring Australia, in the visual style of the "petrol bowser" EV calculator
(rough.js hand-drawn boxes, fill-in-the-blanks sentences).

## What it does

Three escalating tiers of usage input, each feeding the next:

1. **Baseline** — total kWh (or $) per month/quarter/year (with a slider).
2. **Home model** — occupants, hot water, cooking, heating, A/C, pool, EV, solar, battery.
   Estimates your total *or* refines the shape of a known total.
3. **Net-grid-demand editor** — a draggable weekday/weekend chart of the **billed** line:
   grid **import** above the zero baseline (shaded by the selected plan's time-of-use periods),
   solar **export** below it. Solar/battery are baked in during derivation, with **effectiveness
   presets** (Optimistic/Realistic/Conservative) for rainy-day realism and **behaviour buttons**
   (shift flexible load → off-peak / midday; battery off-peak grid top-up).

Every NSW (Ausgrid) residential electricity plan is costed and ranked cheapest-first (offers
**grouped by retailer**, expandable), re-sorting instantly as you edit. **Click a plan to make it
active** — it drives the chart's TOU shading and the per-period cost chips. The cost engine bills
the net line: import by TOU (incl. tiered blocks), export by feed-in tariff (incl. TOU FiT), plus
controlled load, daily supply, recurring/membership fees, and best-effort demand charges.

## Stack

React 19 + Vite + TypeScript, Zustand for state, rough.js for the hand-drawn UI, Vitest for tests.
No backend — plan data is a bundled JSON snapshot.

## Develop

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # cost engine, usage model, normalisation, snapshot integrity
npm run build
```

## Refreshing plan data

```bash
npm run fetch-plans                 # defaults to Ausgrid
npm run fetch-plans -- Citipower    # any distributor substring
```

`scripts/fetch-plans.ts` pulls live data from the AER's public **CDR Energy Product Reference
Data** (the source behind [Energy Made Easy](https://www.energymadeeasy.gov.au/)) and writes a
normalised snapshot to `src/data/plans.<network>.json`.

### How the fetch works (and its limits)

- The CDR register (`api.cdr.gov.au/.../energy/data-holders/brands/summary`, no auth) lists ~85
  energy retailer brands.
- Plans are pulled from the AER aggregator `cdr.energymadeeasy.gov.au/<slug>/cds-au/v1/energy/plans`,
  which is uniform and reliable. **The slug is not derivable from the brand name** (e.g. "Origin
  Energy" → `origin`, not `originenergy`), so the script generates ranked candidate slugs and
  probes for one returning plans.
- ~34 brands resolve with plans (all the majors). A handful of **self-hosting retailers — notably
  Red Energy and OVO — 404 on the standard CDR path and are not currently captured.** The script
  logs the unresolved list.

## Known limitations (v1)

- Ausgrid (NSW) network only — the data layer is network-agnostic, so other networks just need a
  new snapshot.
- "Variable wholesale"/"estimate" plans (Amber, GloBird WHOLESAVE, Flow Power) carry indicative
  reference rates and can appear artificially cheap — they're labelled, but treat with care.
- Demand charges are modelled best-effort. Battery storage is simulated with a simple
  greedy daily charge/discharge cycle (90% round-trip, no power limit or tariff arbitrage).
- A representative weekday/weekend day is scaled to the year (no seasonal variation yet).

Always confirm a real quote on Energy Made Easy before switching.
