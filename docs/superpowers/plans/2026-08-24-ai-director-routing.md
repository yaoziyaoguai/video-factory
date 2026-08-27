# AI Director And Adaptive Shot Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a selectable AI director role and make every shot's material source an AI decision within verified cost and licensing boundaries.

**Architecture:** Add an explicit director node between script and assets. The node writes a validated visual bible and per-shot routing plan; the asset worker executes that plan across local, stock, and metered providers without deriving a fixed mix from the economic recipe.

**Tech Stack:** TypeScript, React, Node test runner, Vitest, Python unittest, Ollama structured JSON, FFmpeg.

**Spec:** `docs/superpowers/specs/2026-08-24-ai-director-routing-design.md`

## Global Constraints

- Economic recipes constrain budget only; they never prescribe a material mix.
- New production behavior requires an AI-generated director plan and has no static routing fallback.
- Existing briefs without a director remain readable and executable through the legacy path.
- Every new behavior is introduced with a failing test before production code.

---

### Task 1: Director contracts and validation

**Files:**
- Modify: `packages/production-pipeline/src/contracts.ts`
- Create: `packages/production-pipeline/src/visual-director.ts`
- Modify: `packages/production-pipeline/src/index.ts`
- Test: `packages/production-pipeline/test/contracts.test.ts`
- Test: `packages/production-pipeline/test/visual-director.test.ts`

- [ ] Add failing tests for director profile parsing, source-pool validation, complete scene coverage, allowed Provider IDs and cost limits.
- [ ] Run the focused tests and confirm failures are caused by missing director contracts.
- [ ] Implement `ProductionDirectorDirection`, `VisualDirectorPlan`, `ShotDecision` and plan validation.
- [ ] Run the focused tests until they pass.

### Task 2: AI director workflow node and role metadata

**Files:**
- Modify: `packages/workflow-core/src/types.ts`
- Modify: `packages/workflow-core/src/workflow-runner.ts`
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Create: `packages/production-pipeline/src/ollama-visual-director.ts`
- Test: `packages/workflow-core/test/workflow-runner.test.ts`
- Test: `packages/production-pipeline/test/production-pipeline.test.ts`
- Test: `packages/production-pipeline/test/ollama-visual-director.test.ts`

- [ ] Add failing tests showing node roles persist and the director node writes a plan before assets.
- [ ] Add a failing structured-output test for the Ollama adapter.
- [ ] Implement role metadata, `VisualDirectorAgent`, the director artifact and Ollama JSON-schema adapter.
- [ ] Run focused tests until they pass.

### Task 3: Execute per-shot routes

**Files:**
- Modify: `packages/production-pipeline/src/generative-asset-worker.ts`
- Modify: `src/video_factory/worker.py`
- Modify: `src/video_factory/stock_assets.py`
- Test: `packages/production-pipeline/test/generative-asset-worker.test.ts`
- Test: `tests/test_worker.py`
- Test: `tests/test_pipeline.py`

- [ ] Add failing tests where one plan routes separate scenes to local, stock and generated providers.
- [ ] Add failing tests for paid-shot and cost enforcement using server estimates.
- [ ] Implement routed baseline preparation and metered scene replacement.
- [ ] Run TypeScript and Python focused tests until they pass.

### Task 4: Director selection and production roles in Studio

**Files:**
- Modify: `apps/studio/src/shared/api.ts`
- Create: `apps/studio/src/shared/director-profiles.ts`
- Modify: `apps/studio/src/client/components/NewRunDialog.tsx`
- Modify: `apps/studio/src/client/components/RunWorkbench.tsx`
- Modify: `apps/studio/src/client/presentation.ts`
- Modify: `apps/studio/src/client/studio-v3.css`
- Modify: `apps/studio/src/server/provider-catalog.ts`
- Modify: `apps/studio/src/server/production-studio.ts`
- Modify: `apps/studio/src/server/main.ts`
- Modify: `apps/studio/src/server/production-worker.ts`
- Test: `apps/studio/test/client.test.tsx`
- Test: `apps/studio/test/server.test.ts`

- [ ] Add failing UI tests for director selection, role labels and budget-only recipes.
- [ ] Add failing server tests for source-pool normalization and unavailable director capabilities.
- [ ] Implement the director selector, source-pool controls, role copy and server assembly.
- [ ] Run Studio tests until they pass.

### Task 5: Local model and end-to-end verification

**Files:**
- Modify: `scripts/setup-local-agent.sh`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/loops/021-ai-director-routing-results.md`

- [ ] Configure and smoke-test the local director model independently from the lightweight topic model.
- [ ] Run `npm run typecheck`, focused suites, `make test`, and the production build.
- [ ] Start the production server, click the director workflow in the browser, and create a real run.
- [ ] Inspect `director_plan.json`, `asset_plan.json`, the rendered video, console errors and responsive layout.
- [ ] Record exact evidence and remaining external-API boundaries in the loop result.
