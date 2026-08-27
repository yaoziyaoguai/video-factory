# Editable Node Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build versioned, editable node workspaces that show the actual capability, provider, model, transport, billing, cost, artifacts, and dependency freshness for every production role.

**Architecture:** Extend workflow-core with immutable execution receipts and versioned effective outputs, then expose those contracts through Studio APIs. Add artifact-kind preview/editor adapters in React and rerun only the stale dependency subgraph after a human edit.

**Tech Stack:** TypeScript, Node.js, React, Vitest, Vite, file-backed workflow store

**Spec:** `docs/superpowers/specs/2026-08-27-editable-node-workspaces-and-zai-codex-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-08-27-video-template-studio.md` Tasks 1-3 establish the immutable run snapshot consumed by node workspaces.

## Global Constraints

- Production must not depend on the user's Mac.
- Generated artifacts are immutable; edits create a new human version.
- Actual execution provenance is displayed, never credentials.
- Upstream edits mark dependent outputs stale.
- Final publishing requires fresh outputs and human approval.

---

### Task 1: Execution Receipts And Version Contracts

**Files:**
- Modify: `packages/workflow-core/src/types.ts`
- Modify: `packages/workflow-core/src/workflow-runner.ts`
- Modify: `packages/workflow-core/test/workflow-runner.test.ts`
- Modify: `packages/production-pipeline/src/run-store.ts`
- Modify: `packages/production-pipeline/test/run-store.test.ts`

**Interfaces:**
- Produces: `NodeExecutionReceipt`, `NodeOutputVersion`, `NodeOutputState`, and node status `stale`.
- Consumes: existing `WorkflowRun`, `NodeRun`, `Artifact`, and optimistic run revisions.

- [ ] Write failing tests proving a successful provider call records actual provider/model/transport/billing metadata without credentials.
- [ ] Run `npm test -- packages/workflow-core/test/workflow-runner.test.ts` and confirm the new assertions fail.
- [ ] Add the minimal receipt and version contracts and populate generated output versions during checkpoints.
- [ ] Run focused workflow-core tests and confirm they pass.
- [ ] Write failing store tests proving old run files without version metadata still load and new versions persist atomically.
- [ ] Implement backward-compatible normalization in `FileRunStore` and rerun focused tests.

### Task 2: Human Override And Dependency Invalidation

**Files:**
- Modify: `packages/workflow-core/src/workflow-runner.ts`
- Modify: `packages/workflow-core/test/workflow-runner.test.ts`
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Modify: `packages/production-pipeline/test/production-pipeline.test.ts`

**Interfaces:**
- Produces: `applyNodeOverride(runId, nodeId, artifactDraft, expectedRevision)` and `rerunStale(runId, fromNodeId)`.
- Consumes: version contracts from Task 1 and the workflow dependency graph.

- [ ] Write a failing test where overriding `script` keeps its generated version, selects a human effective version, and marks `assets`, `voice`, `render`, both reviews, and publish output stale.
- [ ] Run the focused test and confirm it fails because override behavior is absent.
- [ ] Implement graph-based downstream invalidation without special-casing node ids.
- [ ] Run focused tests and confirm they pass.
- [ ] Write a failing test proving a stale subgraph rerun consumes the effective script version while preserving unaffected artifacts.
- [ ] Implement targeted rerun and verify the test passes.

### Task 3: Studio API For Node Workspaces

**Files:**
- Modify: `apps/studio/src/shared/api.ts`
- Modify: `apps/studio/src/server/production-studio.ts`
- Modify: `apps/studio/src/server/app.ts`
- Modify: `apps/studio/src/client/api.ts`
- Modify: `apps/studio/test/api-contract.test.ts`
- Modify: `apps/studio/test/server.test.ts`

**Interfaces:**
- Produces: `StudioNodeWorkspace`, `StudioExecutionReceipt`, `StudioNodeVersion`, `GET /api/runs/:runId/nodes/:nodeId`, `PUT /api/runs/:runId/nodes/:nodeId/effective-output`, and `POST /api/runs/:runId/nodes/:nodeId/rerun-stale`.
- Consumes: pipeline override and rerun methods from Task 2.

- [ ] Write failing contract tests for safe provenance fields, editable documents, expected revision, and stale dependencies.
- [ ] Confirm the tests fail against the existing run-detail-only API.
- [ ] Implement parsers and server methods with artifact schema validation and optimistic locking.
- [ ] Add routes that never serialize secrets, paths, raw headers, or internal task payloads.
- [ ] Run Studio API and server tests until green.

### Task 3A: Per-Node Spend Gates

**Files:**
- Modify: `packages/workflow-core/src/types.ts`
- Modify: `packages/workflow-core/src/workflow-runner.ts`
- Modify: `packages/workflow-core/test/workflow-runner.test.ts`
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Modify: `packages/production-pipeline/test/production-pipeline.test.ts`
- Modify: `apps/studio/src/shared/api.ts`
- Modify: `apps/studio/src/server/production-studio.ts`
- Modify: `apps/studio/src/client/node-workspace/NodeWorkspace.tsx`

**Interfaces:**
- Produces: `SpendPlan`, `SpendAuthorization`, node states `awaiting_spend_approval` and `approval_invalidated`.
- Consumes: effective input version hashes, execution routing, provider billing, run cost policy.

- [ ] Write a failing workflow test proving free A/B execute, metered C pauses, and C cannot run without an exact authorization.
- [ ] Write a failing test proving editing A/B, changing Provider/model, increasing max cost, or increasing attempts invalidates authorization.
- [ ] Write a failing test proving paid C completes and paid D pauses again with C's effective version in its review inputs.
- [ ] Implement runtime-generated spend plans and immutable authorizations without placing credentials or raw prompts in run JSON.
- [ ] Add Studio endpoints and a Spend Gate workspace with preview, edit, free-route, skip, and confirm actions.
- [ ] Verify retries and paid fallback cannot exceed the approved scope.

### Task 4: Artifact Preview And Editor Registry

**Files:**
- Create: `apps/studio/src/client/node-workspace/artifact-presenters.ts`
- Create: `apps/studio/src/client/node-workspace/NodeWorkspace.tsx`
- Create: `apps/studio/src/client/node-workspace/StructuredDocumentEditor.tsx`
- Create: `apps/studio/src/client/node-workspace/MediaPreview.tsx`
- Modify: `apps/studio/src/client/components/RunWorkbench.tsx`
- Create: `apps/studio/test/node-workspace.test.tsx`

**Interfaces:**
- Produces: presenter registry keyed by artifact kind and a node workspace drawer/page.
- Consumes: `StudioNodeWorkspace` and node edit/rerun client methods from Task 3.

- [ ] Write failing component tests proving clicking every completed node opens role, provenance, preview, versions, and actions.
- [ ] Confirm tests fail because nodes are currently non-interactive.
- [ ] Implement the workspace shell and presenter registry for JSON, image, audio, video, and review reports.
- [ ] Implement structured script, director-plan, and publish-copy editors with validation errors shown before submission.
- [ ] Show template expectation, effective value, source layer, and deviation reason beside each editable field.
- [ ] Run focused component tests and confirm they pass.

### Task 5: Role-Specific Workspaces And Freshness UX

**Files:**
- Create: `apps/studio/src/client/node-workspace/ScriptWorkspace.tsx`
- Create: `apps/studio/src/client/node-workspace/DirectorWorkspace.tsx`
- Create: `apps/studio/src/client/node-workspace/AssetWorkspace.tsx`
- Create: `apps/studio/src/client/node-workspace/VoiceWorkspace.tsx`
- Create: `apps/studio/src/client/node-workspace/ReviewWorkspace.tsx`
- Create: `apps/studio/src/client/node-workspace/PublishWorkspace.tsx`
- Modify: `apps/studio/src/client/studio-v3.css`
- Modify: `apps/studio/test/node-workspace.test.tsx`

**Interfaces:**
- Produces: role-specific renderers and visible stale/fallback/billing states.
- Consumes: the workspace registry from Task 4.

- [ ] Add failing tests for scene editing, director shot editing, audio/video playback, timestamped review findings, version switching, stale notices, and downstream rerun confirmation.
- [ ] Implement role-specific workspaces with compact typography, accessible controls, and stable responsive dimensions.
- [ ] Verify desktop and mobile component behavior with focused tests.

### Task 6: Browser Workflow Verification

**Files:**
- Modify: `apps/studio/test/client.test.tsx`
- Modify: `docs/guides/production-workflow.md`

**Interfaces:**
- Produces: browser-verifiable end-to-end editing flow and updated operator documentation.
- Consumes: all preceding tasks.

- [ ] Add an integration test that starts a run, opens script workspace, saves an edit, observes stale descendants, reruns them, previews the new video, and reaches human review.
- [ ] Run the integration test and fix only defects exposed by the flow.
- [ ] Run Playwright against desktop and mobile viewports, capture screenshots, and verify every node and action is reachable without overlap.
- [ ] Update the production workflow guide with generated/effective version semantics.
