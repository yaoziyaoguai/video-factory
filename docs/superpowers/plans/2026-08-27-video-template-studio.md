# Video Template Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a template-first creation experience with versioned production blueprints, explainable inheritance, visual editing, and immutable run snapshots.

**Architecture:** Introduce a small `template-core` package that owns template validation, inheritance, versioning, and snapshot resolution. Studio owns persistence and UI; production-pipeline consumes only a resolved snapshot and remains unaware of authoring concerns.

**Tech Stack:** TypeScript, React, Fastify, Vitest, file-backed stores

**Spec:** `docs/superpowers/specs/2026-08-27-editable-node-workspaces-and-zai-codex-design.md`

## Global Constraints

- Templates describe production grammar and capability requirements, not fixed providers or assets.
- Published versions are immutable; editing creates a draft or a new version.
- A run stores a self-contained snapshot and source-layer receipts.
- Template preview must not trigger paid APIs.
- The default UX is a template gallery and guided editor, not a raw node graph.

### Task 1: Template Contracts And Resolution

**Files:**
- Create: `packages/template-core/package.json`
- Create: `packages/template-core/src/types.ts`
- Create: `packages/template-core/src/template-parser.ts`
- Create: `packages/template-core/src/resolve-template.ts`
- Create: `packages/template-core/src/index.ts`
- Create: `packages/template-core/test/template-parser.test.ts`
- Create: `packages/template-core/test/resolve-template.test.ts`

- [ ] Write failing tests for schema validation, immutable published versions, inheritance precedence, source-layer receipts, capability requirements, and cost limits.
- [ ] Implement the smallest typed contracts and resolver that pass the tests.
- [ ] Build the package and verify its package entrypoint.

### Task 2: Built-In Catalog And File Store

**Files:**
- Create: `apps/studio/src/server/template-catalog.ts`
- Create: `apps/studio/src/server/template-store.ts`
- Create: `apps/studio/test/template-catalog.test.ts`
- Create: `apps/studio/test/template-store.test.ts`

- [ ] Write failing tests for six built-in templates, clone-to-draft, publish-new-version, archive, optimistic revision, and atomic persistence.
- [ ] Implement concise built-ins with distinct story/shot/visual/sound/quality strategies.
- [ ] Implement a file-backed store; built-ins remain read-only and user drafts are persisted separately.

### Task 3: Template APIs And Run Snapshot

**Files:**
- Modify: `apps/studio/src/shared/api.ts`
- Modify: `apps/studio/src/server/app.ts`
- Modify: `apps/studio/src/server/production-studio.ts`
- Modify: `packages/production-pipeline/src/contracts.ts`
- Modify: `packages/production-pipeline/test/contracts.test.ts`
- Modify: `apps/studio/test/server.test.ts`

- [ ] Write failing API tests for list/get/clone/save/publish/archive/preview and safe validation errors.
- [ ] Add `templateSnapshot` to a production brief and prove parse/serialize preserves it without allowing arbitrary provider injection.
- [ ] Resolve system, platform, template, series and run layers at project creation; store the immutable snapshot in the run.
- [ ] Verify existing briefs load through an explicit legacy/default snapshot normalizer.

### Task 4: Template Gallery And Guided Creation

**Files:**
- Create: `apps/studio/src/client/templates/TemplateGallery.tsx`
- Create: `apps/studio/src/client/templates/TemplatePreview.tsx`
- Create: `apps/studio/src/client/templates/TemplateStudio.tsx`
- Modify: `apps/studio/src/client/components/NewRunDialog.tsx`
- Modify: `apps/studio/src/client/pages/ProjectsPage.tsx`
- Modify: `apps/studio/src/client/studio-v3.css`
- Create: `apps/studio/test/template-studio.test.tsx`

- [ ] Write failing interaction tests for choosing a template, previewing story beats and shots, creating a run, cloning a built-in, editing a draft, publishing, and keyboard/mobile access.
- [ ] Implement a visual gallery with compact filters, real content previews, stable dimensions, and clear cost/automation/platform metadata.
- [ ] Implement the seven-area Template Studio using domain controls rather than raw JSON or a node graph.
- [ ] Keep advanced routing collapsed and preserve the existing quick-create path for legacy deep links.

### Task 5: Template Context In Node Workspaces

**Files:**
- Modify: `apps/studio/src/shared/api.ts`
- Modify: `apps/studio/src/server/production-studio.ts`
- Modify: `apps/studio/src/client/node-workspace/NodeWorkspace.tsx`
- Modify: `apps/studio/test/node-workspace.test.tsx`

- [ ] Write failing tests proving every node exposes template expectation, effective value, source layer, and deviation reason.
- [ ] Add a safe diff projection from run snapshot to node workspace.
- [ ] Add “save project as template draft” without mutating the source template.

### Task 6: Browser And Regression Verification

**Files:**
- Modify: `apps/studio/test/client.test.tsx`
- Modify: `docs/guides/production-workflow.md`

- [ ] Test template selection through final run creation on desktop and mobile.
- [ ] Verify template editing never calls metered providers.
- [ ] Capture screenshots for gallery, preview, studio, and run workbench; fix overflow, overlap, focus, and empty-state defects.
- [ ] Run full TypeScript, Studio, build, package, and deployment checks.
