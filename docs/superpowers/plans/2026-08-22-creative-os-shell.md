# VideoFactory Creative OS Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Web Studio operator console with the approved A+C Creative OS, backed by persisted opportunity candidates and the existing real production pipeline.

**Architecture:** Add a small opportunity repository and Studio API boundary around the existing `TopicCandidate` scoring model. Rebuild the React shell around Today, Projects, Resources, Experiments, and a redesigned run workbench; keep page-level data ownership and reuse the current production dispatch and SSE contracts.

**Tech Stack:** TypeScript, React 19, React Router, Fastify, Vitest, Node test runner, Lucide, JSON file persistence, existing workflow-core and production-pipeline packages.

**Spec:** `docs/superpowers/specs/2026-08-22-creative-os-shell-design.md`

## Global Constraints

- Runtime data must be real or explicitly marked unconfigured; do not ship fabricated trends, cost, or account metrics.
- Preserve existing run dispatch, SSE updates, review decisions, artifact download, and byte-range playback.
- Primary viewport checks are 390x844, 768x1024, 1440x900, and 1920x1080.
- Use the approved Director Desk composition with Signal Room data conventions.
- Use Lucide icons, radii no larger than 8px, no gradients, glass effects, decorative blobs, or nested cards.
- Work in the current branch and do not commit unless the user asks.

---

### Task 1: Opportunity Contracts And Persistence

**Files:**
- Modify: `apps/studio/src/shared/api.ts`
- Create: `apps/studio/src/server/opportunity-store.ts`
- Create: `apps/studio/test/opportunity-store.test.ts`

**Interfaces:**
- Consumes: `TopicCandidate`, `TopicScoringInput`, and `scoreTopicCandidate` from `@video-factory/workflow-core`.
- Produces: `StudioOpportunity`, `StudioOpportunityInput`, `StudioOpportunityRepository`, `JsonOpportunityStore`.

- [x] Write repository tests for empty storage, score-based ordering, atomic persistence, lookup, duplicate rejection, and status transitions.
- [x] Run `npm --workspace @video-factory/studio test -- opportunity-store` and confirm the new tests fail because the store is absent.
- [x] Add strict opportunity DTO/input parsing to `shared/api.ts`; validation requires display title, platform, track, audience, pain point, hook, at least one evidence signal, and scores from 0 to 100.
- [x] Implement the injected repository interface and JSON store. Write through a sibling temporary file and atomically rename it.
- [x] Run the focused repository tests and typecheck.

### Task 2: Opportunity Studio API

**Files:**
- Modify: `apps/studio/src/server/studio-service.ts`
- Modify: `apps/studio/src/server/app.ts`
- Modify: `apps/studio/src/server/main.ts`
- Modify: `apps/studio/test/studio-service.test.ts`
- Modify: `apps/studio/test/server.test.ts`

**Interfaces:**
- Consumes: `StudioOpportunityRepository` from Task 1.
- Produces: `listOpportunities()`, `createOpportunity(input)`, `getOpportunity(id)`, and `updateOpportunityStatus(id, status)` service methods plus `/api/opportunities` routes.

- [x] Add failing service tests for domain-to-DTO mapping, score ordering, create, not-found, duplicate, and invalid status transition.
- [x] Add failing Fastify tests for `GET /api/opportunities`, `POST /api/opportunities`, `GET /api/opportunities/:id`, and `PATCH /api/opportunities/:id/status`.
- [x] Inject the opportunity repository into `StudioService`; use the workspace `opportunities/opportunities.json` store in `main.ts`.
- [x] Implement service methods and HTTP routes with `400`, `404`, and `409` behavior.
- [x] Run server and service tests, then Studio typecheck.

### Task 3: Creative Shell And Core Pages

**Files:**
- Modify: `apps/studio/src/client/App.tsx`
- Modify: `apps/studio/src/client/components/AppShell.tsx`
- Create: `apps/studio/src/client/components/ProductionStrip.tsx`
- Create: `apps/studio/src/client/pages/TodayPage.tsx`
- Create: `apps/studio/src/client/pages/ProjectsPage.tsx`
- Create: `apps/studio/src/client/pages/ResourcesPage.tsx`
- Create: `apps/studio/src/client/pages/ExperimentsPage.tsx`
- Modify: `apps/studio/src/client/api.ts`
- Modify: `apps/studio/src/client/styles.css`
- Modify: `apps/studio/test/client.test.tsx`

**Interfaces:**
- Consumes: opportunity API from Task 2, current provider and run endpoints.
- Produces: routes `/`, `/projects`, `/resources`, `/experiments`, shared Creative OS shell and production strip.

- [x] Add client tests for navigation, Today empty/unconfigured/error states, provider readiness, project filtering, and analytics-unconfigured state.
- [x] Run the client tests and confirm they fail against the old shell.
- [x] Replace the two-item shell with the approved four-destination navigation and responsive compact rail.
- [x] Add API client methods for opportunities and status mutation.
- [x] Implement Today with stable empty, loading, error, selected-opportunity, director, and active-run regions.
- [x] Implement Projects from real runs, Resources from real providers, and Experiments from persisted run outcomes only.
- [x] Replace the old CSS with scoped Creative OS tokens and responsive layouts while keeping shared dialog and status behavior.
- [x] Run client tests and both TypeScript checks.

### Task 4: Opportunity Creation And Production Handoff

**Files:**
- Create: `apps/studio/src/client/components/OpportunityDialog.tsx`
- Create: `apps/studio/src/client/components/OpportunityRail.tsx`
- Create: `apps/studio/src/client/components/OpportunityFocus.tsx`
- Create: `apps/studio/src/client/components/DirectorPanel.tsx`
- Modify: `apps/studio/src/client/components/NewRunDialog.tsx`
- Modify: `apps/studio/src/client/pages/TodayPage.tsx`
- Modify: `apps/studio/test/client.test.tsx`

**Interfaces:**
- Consumes: `StudioOpportunity`, `StudioOpportunityInput`, provider readiness, and current `StudioProductionInput` dispatch.
- Produces: manual and JSON-import creation, selected-opportunity display, editable prefilled production brief.

- [x] Add tests for manual creation, structured JSON import validation, candidate selection, evidence links, disabled dispatch when providers are unavailable, and brief prefill.
- [x] Run focused client tests and confirm failure.
- [x] Implement the opportunity rail, focus panel, director panel, and creation/import dialog.
- [x] Add `initialValues?: Partial<StudioProductionInput>` to `NewRunDialog` and reset form identity when the selected opportunity changes.
- [x] Map title, hook, audience, track, and platform into an editable brief; retain explicit confirmation before `POST /api/runs`.
- [x] Run client tests and typecheck.

### Task 5: Run Workbench Redesign

**Files:**
- Modify: `apps/studio/src/client/components/RunWorkbench.tsx`
- Modify: `apps/studio/src/client/pages/RunPage.tsx`
- Modify: `apps/studio/src/client/styles.css`
- Modify: `apps/studio/test/client.test.tsx`

**Interfaces:**
- Consumes: existing `StudioRunDetail`, SSE updates, decision API, and artifact content URLs.
- Produces: video-first review workspace, compact workflow rail, grouped artifacts, sticky review action area.

- [x] Add tests for video-first rendering, grouped artifacts, active intervention, approval, rejection reason, terminal state, and long title layout classes.
- [x] Run focused tests and confirm failure where markup changes are expected.
- [x] Recompose the workbench around the approved Director Desk monitor and grouped production evidence.
- [x] Preserve native video controls, download actions, range playback URL, and current decision semantics.
- [x] Add responsive styles for desktop split view and mobile stacked review.
- [x] Run client, server range, and service regression tests.

### Task 6: Documentation And End-To-End Verification

**Files:**
- Modify: `DESIGN.md`
- Modify: `README.md`
- Modify: `docs/guides/web-studio.md`
- Create: `docs/loops/011-creative-os-results.md`

**Interfaces:**
- Consumes: all implemented behavior.
- Produces: current usage instructions, Mermaid flow, capability matrix, verification evidence, and known external blockers.

- [x] Update the design system to the approved A+C language and remove obsolete two-route assumptions.
- [x] Update run instructions, route map, opportunity import format, and honest capability limits.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build` at the repository root.
- [x] Start the Studio on an available local port and run browser checks at 390x844, 768x1024, 1440x900, and 1920x1080.
- [x] Verify no horizontal overflow, text overlap, blank runtime states, or broken interactions on Today, Projects, Resources, Experiments, and a real run page. The browser control surface did not expose console capture; automated tests and rendered error states covered runtime failures.
- [x] Review the final diff against the approved spec and fix findings before reporting completion.
