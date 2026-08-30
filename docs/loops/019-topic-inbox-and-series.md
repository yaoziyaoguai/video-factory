# Loop 19: Topic Inbox and Series

Date: 2026-08-24

## Problem

The studio currently exposes three disconnected layers:

- the trend gateway can return 100 normalized signals;
- the topic agent can return 8 grounded proposals;
- the homepage only foregrounds 2 persisted opportunities and hides the proposals whenever any opportunity exists.

The existing `track` field is also overloaded. It is used both as a production series identifier and as a loose trend taxonomy, which prevents reliable filtering and future series planning.

## Product Decision

The first step of production has three peer entry modes:

1. `trend`: choose a classified, evidence-backed trend proposal;
2. `series`: continue a persistent editorial series with numbered episode candidates;
3. `custom`: enter a creator-owned idea or import structured research.

Each entry owns its visible candidate workspace. They share one server-owned adoption contract and the existing production engine, but opportunities and runs remain scoped by origin.

## Domain Boundaries

- `TopicCategory` describes subject matter and is independent of `track`.
- `Series` stores the durable editorial promise, season, Series Bible, Episode Roadmap, Canon Ledger, and episode state.
- `CandidateInbox` queries and adopts candidates for one requested origin; it is not a product-level merged screen.
- `Opportunity` remains the reviewed production brief boundary.
- `ProductionStudio` remains unchanged and only receives approved opportunities.

## Acceptance Criteria

- The homepage displays all current agent proposals even when persisted opportunities already exist.
- Trend candidates expose deterministic category, platform, freshness, and risk facets.
- Users can filter candidates by category and platform without losing the current production workspace.
- Users can create a series with at least two content pillars and receive numbered episode candidates.
- Adopting a series episode creates a normal opportunity exactly once, preserves the ordered roadmap, and blocks later episodes until the prior Internal Master exists.
- Trend, series, and custom are peer launch modes on the home page; after entry they share the production engine without sharing visible records.
- Existing trend-candidate and opportunity APIs remain compatible.
- The creator guide explains all three entry modes.
- Desktop and mobile views have no horizontal overflow and all new controls work by real browser clicks.

## Verification

- Contract, store, planner, service, route, and React interaction tests.
- Full TypeScript suite and production build.
- Existing Python and real rendering regression checks.
- Production browser walkthrough at desktop and mobile widths with console inspection.
