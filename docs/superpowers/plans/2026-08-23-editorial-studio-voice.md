# Editorial Studio and Voice Direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn VideoFactory into an editorial creative studio with automatically discovered local capabilities and a configurable, previewable, mastered Chinese voice pipeline.

**Architecture:** Add a server-side local capability and voice catalogue boundary, extend the production brief with voice direction, and keep Python synthesis responsible for provider execution and mastering. Recompose the existing React UI around an editorial top navigation and creative library while preserving the workflow engine and provider contracts.

**Tech Stack:** TypeScript, React, Fastify, Python, FFmpeg, macOS `say`, optional local Kokoro, Vitest, Node test runner, unittest/pytest, Vite.

**Spec:** `docs/superpowers/specs/2026-08-23-editorial-studio-voice-design.md`

## Global Constraints

- Do not commit or expose API keys; a user-authorized key may live only in the ignored local `.env`.
- Keep macOS voice synthesis as a verified zero-install fallback.
- Mark optional local models ready only after runtime and model evidence exists.
- Use test-first development for service, contract, pipeline, and UI behavior.
- Preserve the existing workflow engine and paid video adapter boundaries.

---

### Task 1: Local Capability and Voice Catalogue

**Files:**
- Create: `apps/studio/src/server/local-capabilities.ts`
- Modify: `apps/studio/src/shared/api.ts`
- Modify: `apps/studio/src/server/app.ts`
- Modify: `apps/studio/src/server/studio-service.ts`
- Modify: `apps/studio/src/client/api.ts`
- Test: `apps/studio/test/local-capabilities.test.ts`
- Test: `apps/studio/test/server.test.ts`

**Interfaces:**
- Produces: `LocalCapabilityReport`, `StudioVoiceProfile`, `StudioVoicePreviewInput` and `/api/local-capabilities`, `/api/voices`, `/api/voices/preview`.

- [x] Write failing tests for Chinese `say` parsing, capability evidence, and preview input validation.
- [x] Run focused tests and confirm missing behavior fails.
- [x] Implement command probing, voice discovery, service methods, and API routes.
- [x] Run focused service and server tests until green.

### Task 2: Voice Direction Contract and Mastering

**Files:**
- Modify: `packages/production-pipeline/src/contracts.ts`
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Modify: `src/video_factory/voiceover.py`
- Modify: `src/video_factory/worker.py`
- Modify: `apps/studio/src/shared/api.ts`
- Test: `packages/production-pipeline/test/contracts.test.ts`
- Test: `packages/production-pipeline/test/production-pipeline.test.ts`
- Test: `tests/test_worker.py`

**Interfaces:**
- Consumes: `voiceDirection` from the brief.
- Produces: worker parameters and `video-factory/voiceover-plan-v2` with mastering metadata.

- [x] Write failing contract and worker tests for profile, rate, pauses, and mastering.
- [x] Confirm failures are caused by the absent direction contract.
- [x] Extend parsing and pipeline parameter mapping.
- [x] Implement deterministic punctuation pauses and FFmpeg mastering presets.
- [x] Run TypeScript and Python focused tests until green.

### Task 3: Optional Kokoro Local Provider

**Files:**
- Create: `scripts/setup-local-voice.sh`
- Create: `src/video_factory/kokoro_voice.py`
- Modify: `src/video_factory/voiceover.py`
- Modify: `apps/studio/src/server/provider-catalog.ts`
- Modify: `.gitignore`
- Modify: `Makefile`
- Test: `tests/test_worker.py`
- Test: `apps/studio/test/studio-service.test.ts`

**Interfaces:**
- Produces: `kokoro-local-v1` provider and a reproducible setup command.

- [x] Write failing provider readiness and worker dispatch tests.
- [x] Implement runtime/model detection and the Python provider adapter.
- [x] Add an idempotent setup command with a local manifest and smoke test.
- [x] Install locally, run the smoke test, and keep the provider unavailable with exact evidence if installation fails.

### Task 4: Voice Studio Interaction

**Files:**
- Create: `apps/studio/src/client/components/VoiceStudio.tsx`
- Modify: `apps/studio/src/client/components/NewRunDialog.tsx`
- Modify: `apps/studio/src/client/pages/ResourcesPage.tsx`
- Modify: `apps/studio/src/client/api.ts`
- Test: `apps/studio/test/client.test.tsx`
- Test: `apps/studio/test/creative-os.test.tsx`

**Interfaces:**
- Consumes: voice catalogue and preview endpoints.
- Produces: editable `voiceDirection` in production submissions.

- [x] Write failing interaction tests for voice selection, preview, rate, pause, and mastering.
- [x] Implement a compact voice cast with audio preview and advanced controls.
- [x] Add local capability evidence to the creative library.
- [x] Run client tests until green.

### Task 5: Editorial Visual System

**Files:**
- Modify: `apps/studio/package.json`
- Modify: `apps/studio/src/client/main.tsx`
- Modify: `apps/studio/src/client/components/AppShell.tsx`
- Modify: `apps/studio/src/client/pages/TodayPage.tsx`
- Modify: `apps/studio/src/client/pages/ResourcesPage.tsx`
- Modify: `apps/studio/src/client/styles.css`
- Modify: `DESIGN.md`

**Interfaces:**
- Preserves: existing page routes and accessible command names.
- Produces: top-level editorial studio shell and responsive creative-library layouts.

- [x] Add the local Chinese serif font dependency and update imports.
- [x] Replace the side rail with the editorial studio header.
- [x] Recompose page headers, empty states, resources, and production dialog around media-led sections.
- [x] Verify no horizontal overflow at mobile and desktop widths.

### Task 6: Local Trend Intelligence Stack

**Files:**
- Create: `apps/studio/src/server/trend-gateway.ts`
- Create: `apps/studio/src/server/trend-opportunity-agent.ts`
- Create: `scripts/setup-local-trends.sh`
- Create: `scripts/setup-local-agent.sh`
- Modify: `apps/studio/src/client/pages/TodayPage.tsx`
- Modify: `apps/studio/src/client/pages/ResourcesPage.tsx`

- [x] Normalize and deduplicate real DailyHotApi and NewsNow signals with independent service failure handling.
- [x] Deploy TrendRadar, NewsNow, DailyHotApi, RSSHub and expose truthful health evidence.
- [x] Add a structured local Qwen3 topic-agent boundary with a deterministic labelled fallback.
- [x] Require explicit human action before an Agent proposal enters the opportunity store.
- [x] Install Qwen3 locally and verify a real model-backed proposal.

### Task 7: End-to-End Verification

**Files:**
- Modify: `docs/loops/014-editorial-studio-voice-results.md`

**Interfaces:**
- Consumes: the complete integrated milestone.
- Produces: reproducible test evidence, generated audio/video paths, and visual QA notes.

- [x] Run the complete TypeScript, Studio, build, and Python test suites.
- [x] Generate previews from multiple local Chinese voices and inspect audio metadata.
- [x] Run a real local production through final review and inspect its `voiceover_plan.json` and MP4 streams.
- [x] Capture desktop and 390px mobile screenshots for all primary pages and check browser console output.
- [x] Review the final diff against every acceptance criterion and record caveats honestly.
