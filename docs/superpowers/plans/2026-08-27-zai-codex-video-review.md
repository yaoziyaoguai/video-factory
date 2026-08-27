# ZAI Codex Video Review Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an isolated ZAI-backed Codex CLI on Alibaba ECS and use GLM-5.3-Flash for safe, attributable visual review without depending on the user's Mac.

**Architecture:** Generalize the existing allowlisted Codex broker around named executor profiles while preserving separate services, credentials, sockets, task roots, and quotas. Add a visual-review task whose media is preprocessed into bounded review inputs and whose receipt flows into the editable node workspace.

**Tech Stack:** TypeScript, Codex CLI, GLM Coding Plan Responses endpoint, systemd, Unix sockets, FFmpeg, Docker Compose, Vitest

**Spec:** `docs/superpowers/specs/2026-08-27-editable-node-workspaces-and-zai-codex-design.md`

## Global Constraints

- Alibaba ECS is the only production runtime.
- OpenAI and ZAI credentials, homes, sockets, and task directories are isolated.
- Coding Plan keys never enter Git, containers, logs, process arguments, or Web responses.
- Broker task kinds and schemas are owned by the host, not the container.
- Native video transport is enabled only after a bounded real test succeeds.

---

### Task 1: Multi-Profile Broker Configuration

**Files:**
- Modify: `apps/codex-broker/src/main.ts`
- Modify: `apps/codex-broker/src/codex-executor.ts`
- Modify: `apps/codex-broker/test/codex-executor.test.ts`
- Modify: `apps/codex-broker/test/broker-server.test.ts`
- Create: `apps/codex-broker/deploy/vf-zai-codex-broker.service`
- Modify: `scripts/setup-codex-broker-host.sh`

**Interfaces:**
- Produces: system-managed profile selection with isolated `CODEX_HOME`, model provider, model id, socket, and task root.
- Consumes: existing broker protocol, allowlisted command builder, and systemd deployment pattern.

- [ ] Write failing command-builder tests proving ZAI profile loads only its system-managed config and never puts the Key in argv.
- [ ] Confirm the tests fail against the single-profile executor.
- [ ] Implement profile configuration while preserving disabled shell tools, ephemeral tasks, schemas, size limits, and timeouts.
- [ ] Add a second systemd service and host setup with 0600 credential/config permissions.
- [ ] Run broker tests and shell syntax validation.

### Task 2: Visual Review Task Contract

**Files:**
- Modify: `apps/codex-broker/src/task-definitions.ts`
- Modify: `apps/codex-broker/src/codex-executor.ts`
- Modify: `apps/codex-broker/test/task-definitions.test.ts`
- Modify: `packages/production-pipeline/src/codex-chat.ts`
- Create: `packages/production-pipeline/src/visual-review.ts`
- Create: `packages/production-pipeline/test/visual-review.test.ts`

**Interfaces:**
- Produces: allowlisted task `visual-review` and validated `VisualReviewReport` with timestamped findings, scores, confidence, and recommendation.
- Consumes: bounded media manifest, transcript, technical metrics, and execution receipt metadata.

- [ ] Write failing validation tests rejecting arbitrary paths, URLs, prompt text, oversized frame lists, unknown fields, and invalid timestamps.
- [ ] Confirm failures are caused by the missing visual-review contract.
- [ ] Implement strict request/output schemas and Chinese reviewer directives owned by the broker.
- [ ] Run focused broker and pipeline tests until green.

### Task 3: Bounded Media Preprocessor

**Files:**
- Create: `src/video_factory/review_media.py`
- Create: `tests/test_review_media.py`
- Modify: `src/video_factory/worker.py`
- Modify: `packages/production-pipeline/src/python-worker-client.ts`

**Interfaces:**
- Produces: `review_media_manifest.json`, scene-change frames, contact sheets, transcript reference, duration, and audio metrics within configured limits.
- Consumes: rendered MP4 located inside the run directory.

- [ ] Write failing Python tests for scene sampling, maximum frame count, run-root path confinement, deterministic manifests, and cleanup.
- [ ] Verify the tests fail before implementation.
- [ ] Implement FFmpeg-based preprocessing with no network access and bounded files.
- [ ] Run Python tests and worker-client contract tests.

### Task 4: Production Review Routing And Receipts

**Files:**
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Modify: `packages/production-pipeline/src/contracts.ts`
- Modify: `packages/production-pipeline/test/production-pipeline.test.ts`
- Modify: `apps/studio/src/server/provider-catalog.ts`
- Modify: `apps/studio/src/server/capability-studio.ts`
- Modify: `apps/studio/test/local-capabilities.test.ts`

**Interfaces:**
- Produces: deterministic technical review followed by ZAI artistic review, each with its own receipt and failure state.
- Consumes: visual-review task and media manifest from Tasks 2 and 3.

- [ ] Write failing pipeline tests proving technical review cannot substitute for failed artistic review and fallback receipts are visible.
- [ ] Implement the artistic-review node or subnode using the ZAI socket and GLM-5.3-Flash model id.
- [ ] Expose safe capability metadata and configuration readiness.
- [ ] Run focused pipeline and Studio tests.

### Task 5: Docker And Deployment Wiring

**Files:**
- Modify: `docker/docker-compose.prod.yml`
- Modify: `scripts/deploy-production.sh`
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `docs/guides/production-deployment.md`

**Interfaces:**
- Produces: read-only mounts for both socket directories and atomic deployment/rollback of both broker releases.
- Consumes: service files and model routing from earlier tasks.

- [ ] Add a failing compose/deployment assertion for the missing ZAI socket and health check.
- [ ] Wire the ZAI broker without mounting either Codex home into the container.
- [ ] Extend rollback so application deployment does not leave broker/application protocol versions mismatched.
- [ ] Run Compose config, shell syntax, actionlint, and deployment unit checks.

### Task 6: Alibaba ECS Configuration And Minimal Real Test

**Files:**
- No tracked secret files.
- Update: `docs/loops/021-zai-codex-editable-node-results.md` with redacted evidence.

**Interfaces:**
- Produces: live ZAI broker health and one minimal GLM-5.3-Flash structured response.
- Consumes: user-provided Coding Plan key through a non-echoing secure channel.

- [ ] Back up the server production configuration and install the Coding Plan Key with mode 0600 without printing it.
- [ ] Start the isolated ZAI broker and verify the socket health endpoint.
- [ ] Send one tiny structured text task to prove subscription routing and record only model id, success, latency, and usage category.
- [ ] Send one tiny image review; do not test full video until image transport is proven.
- [ ] Test a 2-4 second low-resolution video once; if native transport fails, record the keyframe fallback and do not repeat paid attempts.
- [ ] Verify OpenAI broker and existing VideoFactory remain healthy after the ZAI test.

### Task 7: Security, Full Verification, And Deployment Proof

**Files:**
- Create or modify targeted security tests discovered during review.
- Update: `docs/loops/021-zai-codex-editable-node-results.md`

**Interfaces:**
- Produces: final evidence for security, functionality, browser usability, and deployment readiness.
- Consumes: both implementation plans.

- [ ] Search tracked files, generated client payloads, logs, and process arguments for credential leakage.
- [ ] Run `npm test`, `make test-py`, integration tests, production build, Docker build, compose validation, `bash -n`, and `actionlint`.
- [ ] Run browser checks for provider/model/billing display and editable node workflows on desktop and mobile.
- [ ] Push the branch, wait for fresh GitHub CI, and verify the PR is clean and mergeable.
