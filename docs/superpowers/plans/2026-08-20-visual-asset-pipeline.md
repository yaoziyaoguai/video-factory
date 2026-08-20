# Visual Asset Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a free-stock-asset pipeline that can prepare per-scene assets and render with real visuals instead of text-card-only video.

**Architecture:** Add a provider layer that normalizes Pexels/Pixabay results and writes an asset plan. Update rendering to consume that plan, generate caption overlays, and require assets for publish-quality output when requested.

**Tech Stack:** Python 3.9, SQLite, urllib, Pillow, FFmpeg, unittest.

**Spec:** `docs/superpowers/specs/2026-08-20-visual-asset-pipeline-design.md`

## Global Constraints

- Do not commit API keys, downloaded media, or generated render artifacts.
- Provider keys are read from `PEXELS_API_KEY` and `PIXABAY_API_KEY`.
- `render-job --require-assets` must fail when scene assets are missing.
- Tests must not call external APIs.

---

### Task 1: Provider Normalization And Asset Plans

**Files:**
- Create: `src/video_factory/stock_assets.py`
- Modify: `src/video_factory/domain.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Produces: `StockAssetCandidate`, `SceneAsset`, `prepare_scene_assets(...)`, `write_asset_plan(...)`, `load_asset_plan(...)`.
- Consumes: `Scene.search_terms` from existing script generation.

- [ ] Add dataclasses for normalized stock candidates and prepared scene assets.
- [ ] Implement provider result normalization for Pexels and Pixabay JSON.
- [ ] Implement a mock provider for deterministic tests.
- [ ] Write tests proving an asset plan contains provider, source URL, license note, dimensions, and local path.

### Task 2: CLI Asset Commands

**Files:**
- Modify: `src/video_factory/cli.py`
- Test: `tests/test_pipeline.py`
- Create: `.env.example`

**Interfaces:**
- Produces commands: `asset-search <job_id>`, `prepare-assets <job_id>`.
- Consumes: `stock_assets.prepare_scene_assets`.

- [ ] Add CLI arguments for provider, limit, media type, and output path.
- [ ] Add `.env.example` with placeholder provider key names.
- [ ] Test `prepare-assets --provider mock` writes `workspace/assets/job-<id>/asset_plan.json`.

### Task 3: Asset-Aware Rendering

**Files:**
- Modify: `src/video_factory/renderer.py`
- Modify: `src/video_factory/cli.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Produces: `render_job_manifest(..., require_assets: bool = False)`.
- Consumes: asset plan JSON from `workspace/assets/job-<id>/asset_plan.json`.

- [ ] Generate transparent caption overlays with Pillow.
- [ ] Render video/image scene clips through FFmpeg when assets exist.
- [ ] Keep text-card preview fallback only when assets are not required.
- [ ] Test missing assets fail with `--require-assets`.
- [ ] Test asset-aware render writes manifest `visual_quality: stock_asset`.

### Task 4: Docs, Loop Evidence, And Browser Attempt

**Files:**
- Modify: `README.md`
- Create: `docs/loops/006-visual-quality-assets.md`

**Interfaces:**
- Produces: human-readable setup and provider notes.

- [ ] Document free provider choices and environment variables.
- [ ] Record browser/API-key attempt outcomes.
- [ ] Run full tests, compile check, real local render check.
- [ ] Complete Loop 6 and commit/push.
