# VideoFactory Web Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished local Web Studio that creates, observes, reviews, and completes real VideoFactory production runs without CLI or JSON interaction.

**Architecture:** Add a React/Vite client and Fastify API in `apps/studio`. Extend the production service with persisted run listing and asynchronous dispatch while preserving `workflow-core` and CLI behavior. Serve browser-safe run DTOs, SSE snapshots, and range-capable artifact media from the local API.

**Tech Stack:** TypeScript, React 19, Vite 8, Fastify 5, Lucide React, vanilla CSS, Vitest, Testing Library, Node test runner, Playwright CLI.

**Spec:** `docs/superpowers/specs/2026-08-21-web-studio-design.md`

## Global Constraints

- `DESIGN.md` is the visual source of truth.
- Bind the Studio server to `127.0.0.1` by default.
- Never expose environment values or secrets to the browser.
- Keep `ProductionPipeline.start()` and the production CLI backward compatible.
- Write every behavior test first and observe the expected failure before production code.
- Do not commit or push unless the user explicitly requests it.

---

### Task 1: Persisted Run Discovery And Asynchronous Dispatch

**Files:**
- Modify: `packages/workflow-core/src/workflow-runner.ts`
- Modify: `packages/production-pipeline/src/run-store.ts`
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Modify: `packages/production-pipeline/src/index.ts`
- Test: `packages/production-pipeline/test/run-store.test.ts`
- Test: `packages/production-pipeline/test/production-pipeline.test.ts`

**Interfaces:**
- Produces: `FileRunStore.list<T>(): Promise<WorkflowRun<T>[]>`
- Produces: `ProductionPipeline.dispatch(input, listener?): Promise<{runId: string; completion: Promise<WorkflowRun<ProductionBrief>>}>`
- Preserves: `ProductionPipeline.start(input): Promise<WorkflowRun<ProductionBrief>>`

- [ ] Write a failing test that lists persisted runs newest first and ignores unrelated directories.
- [ ] Run the focused store test and verify the missing `list` behavior fails.
- [ ] Implement safe directory discovery and deterministic sorting.
- [ ] Write a failing test that `dispatch` returns after the initial running checkpoint while completion continues.
- [ ] Run the focused pipeline test and verify the missing `dispatch` behavior fails.
- [ ] Implement preallocated run id, first-checkpoint rendezvous, and optional snapshot listener.
- [ ] Run production-pipeline tests and typecheck.

### Task 2: Studio API And Media Boundary

**Files:**
- Create: `apps/studio/package.json`
- Create: `apps/studio/tsconfig.json`
- Create: `apps/studio/src/shared/api.ts`
- Create: `apps/studio/src/server/studio-service.ts`
- Create: `apps/studio/src/server/app.ts`
- Create: `apps/studio/src/server/main.ts`
- Test: `apps/studio/test/server.test.ts`

**Interfaces:**
- Produces: `buildStudioApp(options): FastifyInstance`
- Produces: `StudioService.listRuns/getRun/startRun/decide/listProviders`
- Produces: API routes defined in the specification.

- [ ] Scaffold the Studio package and write a failing health/provider response test.
- [ ] Implement browser-safe shared DTOs and provider availability discovery.
- [ ] Write failing tests for list, start, detail, 404, validation, and decision resolution.
- [ ] Implement routes and map domain failures to 400/404/409 responses.
- [ ] Write failing SSE tests for immediate snapshot and terminal close.
- [ ] Implement an event hub and background completion ownership.
- [ ] Write failing range tests for full content, valid range, invalid range, and path confinement.
- [ ] Implement artifact lookup, realpath confinement, content type, and byte ranges.
- [ ] Run Studio server tests and typecheck.

### Task 3: Design System And Application Shell

**Files:**
- Create: `apps/studio/index.html`
- Create: `apps/studio/vite.config.ts`
- Create: `apps/studio/src/client/main.tsx`
- Create: `apps/studio/src/client/app.tsx`
- Create: `apps/studio/src/client/styles/tokens.css`
- Create: `apps/studio/src/client/styles/global.css`
- Create: `apps/studio/src/client/components/app-shell.tsx`
- Create: `apps/studio/src/client/components/status.tsx`
- Test: `apps/studio/test/app-shell.test.tsx`

**Interfaces:**
- Produces: responsive `AppShell`, `StatusBadge`, `StatusIcon`, and route outlet.

- [ ] Write a failing component test for navigation, active route, accessible create command, and mobile header.
- [ ] Implement design tokens exactly from `DESIGN.md` and the responsive shell.
- [ ] Add Lucide icons with labels/tooltips and visible focus states.
- [ ] Run component tests, browser build, and typecheck.

### Task 4: Production Queue And New Production Drawer

**Files:**
- Create: `apps/studio/src/client/lib/api-client.ts`
- Create: `apps/studio/src/client/screens/production-screen.tsx`
- Create: `apps/studio/src/client/components/run-table.tsx`
- Create: `apps/studio/src/client/components/new-production-drawer.tsx`
- Create: `apps/studio/src/client/components/form-controls.tsx`
- Test: `apps/studio/test/production-screen.test.tsx`

**Interfaces:**
- Consumes: Studio API run/provider DTOs.
- Produces: queue filters and a typed `video-factory/brief-v1` submit payload.

- [ ] Write failing tests for loading, empty, populated, waiting, and API error queue states.
- [ ] Implement the scan-friendly queue and filters.
- [ ] Write failing form tests for defaults, required fields, 20-180 duration, unavailable provider, and successful dispatch navigation.
- [ ] Implement the drawer, progressive provider controls, validation, and submission state.
- [ ] Run focused tests and build.

### Task 5: Live Run Detail And Human Review

**Files:**
- Create: `apps/studio/src/client/hooks/use-run-stream.ts`
- Create: `apps/studio/src/client/screens/run-screen.tsx`
- Create: `apps/studio/src/client/components/workflow-track.tsx`
- Create: `apps/studio/src/client/components/video-review.tsx`
- Create: `apps/studio/src/client/components/run-tabs.tsx`
- Test: `apps/studio/test/run-screen.test.tsx`

**Interfaces:**
- Consumes: run snapshots and `EventSource`.
- Produces: live workflow, media URL, evidence/artifact tabs, and approve/reject commands.

- [ ] Write failing tests for partial running, waiting, failed, rejected, and succeeded run states.
- [ ] Implement the stable workflow track and state-specific detail layout.
- [ ] Write failing tests for SSE replacement/reconnect and preservation of the last snapshot.
- [ ] Implement `useRunStream` with cleanup and terminal close.
- [ ] Write failing review tests for actor, optional approval note, required rejection reason, pending disable, API error, and successful terminal update.
- [ ] Implement native video review and human decision panel.
- [ ] Run focused tests and build.

### Task 6: Provider Diagnostics And Responsive Completion

**Files:**
- Create: `apps/studio/src/client/screens/providers-screen.tsx`
- Create: `apps/studio/src/client/components/provider-table.tsx`
- Modify: Studio client styles and shell components as required by real content.
- Test: `apps/studio/test/providers-screen.test.tsx`

**Interfaces:**
- Consumes: `GET /api/providers`.
- Produces: capability-grouped runtime/key diagnostics without secret values.

- [ ] Write failing provider tests for available local, missing external key, and test-only labels.
- [ ] Implement the compact provider table and runtime health state.
- [ ] Add explicit long-title, long-error, empty-artifact, and disconnected-SSE fixtures.
- [ ] Run all Studio tests and production build.

### Task 7: Real Browser And Media Loop

**Files:**
- Modify: root `package.json`, `Makefile`, `.gitignore`, and `README.md` for Studio commands.
- Create: `output/playwright/loop-10/` artifacts during verification only.

**Interfaces:**
- Produces: `npm run studio:dev`, `npm run studio:build`, `npm run studio:test`, and `make studio`.

- [ ] Start the local Studio server on an available port.
- [ ] Use Playwright CLI to verify empty/list/provider views and capture 1440x900, 1920x1080, 768x1024, and 390x844 screenshots.
- [ ] Create a real local-provider run through the form and observe node progress through SSE.
- [ ] Verify nonblank video pixels, duration, controls, and audio-bearing media response.
- [ ] Approve through the browser and verify the publish package appears without duplicate artifacts.
- [ ] Repeat with rejection using a separate run.
- [ ] Inspect screenshots for hierarchy, overflow, overlap, spacing, color, typography, and mobile review reachability.
- [ ] Correct every visual/interaction defect and repeat this task until no blocker remains.

### Task 8: Review, Verification, And Loop Result

**Files:**
- Create: `docs/loops/010-web-operator-studio-results.md`
- Update: `docs/guides/production-workflow.md`
- Update: `CONTEXT.md`

- [ ] Run `make test`, Studio tests/build, and `make test-e2e` from a clean process state.
- [ ] Run `git diff --check` and inspect the full diff against the spec.
- [ ] Run independent correctness, security, reliability, API-contract, testing, and design reviews.
- [ ] Apply validated findings, rerun affected checks, and repeat review when changes are structural.
- [ ] Record exact test counts, browser evidence, real run ids, screenshots, limitations, and next external gate.
- [ ] Mark every Loop 10 exit condition only when its evidence exists.
