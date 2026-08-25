# Guided Creator Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-run interactive product tour and strengthen the Studio with a media-first director desk visual language.

**Architecture:** A storage-only state module and a route-aware React hook own onboarding behavior. Existing business components expose stable `data-tour` anchors while Driver.js owns overlay positioning and keyboard behavior; visual changes remain in focused CSS and presentational components.

**Tech Stack:** React 19, React Router 7, TypeScript, Driver.js, Vitest, Testing Library, local Chrome/browser QA.

**Spec:** `docs/superpowers/specs/2026-08-24-guided-creator-canvas-design.md`

## Global Constraints

- Tour completion uses a versioned localStorage key and degrades when storage is unavailable.
- No tour step may submit production, review decisions, downloads, or external navigation.
- Driver.js is the only new runtime dependency.
- All icon commands use Lucide and accessible names.
- Cards stay at 8px radius or less; no gradients, glass, decorative orbs, or nested cards.
- Real cached media must be visible in the first desktop and mobile viewport.

---

### Task 1: Versioned Tour State

**Files:**
- Create: `apps/studio/src/client/onboarding/creator-tour-state.ts`
- Test: `apps/studio/test/creator-tour.test.tsx`

**Interfaces:**
- Produces: `CREATOR_TOUR_STORAGE_KEY`, `hasCompletedCreatorTour(storage?)`, `completeCreatorTour(storage?)`.

- [ ] Write tests for a missing key, matching version, stale version, and storage exceptions.
- [ ] Run `npx vitest run apps/studio/test/creator-tour.test.tsx` and verify failure.
- [ ] Implement the storage helpers with exception-safe reads and writes.
- [ ] Rerun the focused test and verify pass.

### Task 2: Route-Aware Interactive Tour

**Files:**
- Create: `apps/studio/src/client/onboarding/use-creator-tour.ts`
- Create: `apps/studio/src/client/creator-tour.css`
- Modify: `apps/studio/src/client/components/AppShell.tsx`
- Modify: `apps/studio/src/client/main.tsx`
- Modify: `apps/studio/src/client/components/OpportunityRail.tsx`
- Modify: `apps/studio/src/client/components/OpportunityFocus.tsx`
- Modify: `apps/studio/src/client/components/DirectorPanel.tsx`
- Modify: `apps/studio/src/client/components/NewRunDialog.tsx`
- Test: `apps/studio/test/creator-tour.test.tsx`

**Interfaces:**
- Consumes: Task 1 completion helpers.
- Produces: `useCreatorTour(): { startCreatorTour(): void }` and stable `data-tour` anchors.

- [ ] Mock `driver()` and write failing tests for automatic start, completion persistence, replay, and route return.
- [ ] Install `driver.js` in `@video-factory/studio` and verify the package lock changes only for that dependency.
- [ ] Implement the hook with Chinese controls, progress, missing-element skipping, `advanceOnClick`, and dynamic modal waiting.
- [ ] Add desktop/mobile help buttons and tour anchors without coupling business components to Driver.js.
- [ ] Add the field-clapper themed popover and spotlight CSS.
- [ ] Run the focused and full Studio frontend tests.

### Task 3: Media-First Director Desk

**Files:**
- Modify: `apps/studio/src/client/components/OpportunityFocus.tsx`
- Modify: `apps/studio/src/client/pages/TodayPage.tsx`
- Modify: `apps/studio/src/client/components/AppShell.tsx`
- Modify: `apps/studio/src/client/studio-v3.css`
- Test: `apps/studio/test/creative-os.test.tsx`

**Interfaces:**
- Consumes: existing cached media under `apps/studio/public/media/`.
- Produces: first-viewport contact sheet and selected-opportunity reveal motion.

- [ ] Write a failing component assertion for the visual contact sheet and shot labels.
- [ ] Move the three real frames into a primary contact sheet with semantic figures and tour anchor.
- [ ] Key the focus surface by opportunity id and add reduced-motion-safe reveal styling.
- [ ] Refine sidebar slate, color balance, typography, and responsive contact-sheet tracks.
- [ ] Run frontend tests and typecheck.

### Task 4: Browser Loop And Delivery

**Files:**
- Create: `docs/loops/017-guided-creator-canvas-results.md`

**Interfaces:**
- Consumes: complete guided Creator Canvas.
- Produces: verified build, screenshots, click matrix, and durable result record.

- [ ] Build the Studio and restart the launchd-managed service.
- [ ] Clear the tour key, reload, and click every tour step through the production dialog without submitting.
- [ ] Verify skip, refresh suppression, help-button replay, desktop/mobile navigation and Escape.
- [ ] Capture 1440x900, 768x1024 and 390x844 screenshots; assert viewport width equals document width and collect browser warnings/errors.
- [ ] Run `npm test`, `make test-py`, `git diff --check`, static asset MIME and health probes.
- [ ] Record exact results and remaining paid-provider boundaries in Loop 17.
