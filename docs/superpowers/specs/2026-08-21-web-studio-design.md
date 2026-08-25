# VideoFactory Web Studio Design Specification

Date: 2026-08-21
Status: Approved direction, ready for implementation

## 1. Goal

Build a local Web Studio over the existing `ProductionPipeline` so one creator can complete the daily short-video workflow without editing JSON, copying a run id, locating files manually, or invoking the CLI.

The first release is an operator interface for the production engine already proven in Loop 9. It does not replace `@video-factory/workflow-core`; it exposes the same run, artifact, provider, intervention, and decision contracts through a browser.

## 2. Primary User And Job

The primary user is a solo Chinese short-video creator who has a full-time job and intends to make one reviewed video per day.

The job is:

> Create one production run from a clear form, see where it is, watch the real result, make a deliberate approve/reject decision, and leave with an auditable publish package.

The interface must remain useful when a run fails. A failed run is not a blank screen; it shows the failed node, persisted artifacts, and the actual error.

## 3. Product Scope

### 3.1 Production Queue

- List all persisted runs newest first.
- Filter by all, active, waiting, and finished.
- Show title, platform, status, current/terminal node, duration, start time, and next action.
- Open a run without requiring its id.
- Show a useful empty state with one `创建视频` command.

### 3.2 New Production

- Open from a global `创建视频` command.
- Collect title, angle, audience, niche, duration, platform, and review mode.
- Default to `douyin`, 24 seconds, manual review, and free local providers.
- Load provider choices and availability from the server.
- Prevent submission when a selected provider is unavailable.
- Return immediately after the first run checkpoint and navigate to run detail.

### 3.3 Run Detail

- Render a stable workflow track for brief, script, assets, voice, render, technical review, final review, and publish package.
- Update state through SSE without page reload.
- Play the persisted render artifact through an HTTP endpoint with byte-range support.
- Show run summary, technical review evidence, artifacts, provenance, errors, and human decisions.
- Keep file paths and hashes available in the artifact table, but do not make them primary content.

### 3.4 Human Review

- For `needs_human`, place video, review reason, technical evidence, and decision actions in one viewport.
- Approval requires actor and accepts an optional note.
- Rejection requires actor and a non-empty reason in the Web Studio, even though the lower-level domain contract permits an empty note.
- Prevent duplicate submission while the decision request is pending.
- Display the resulting terminal state and publish package without rerunning media nodes.

### 3.5 Provider Status

- Show providers grouped by capability.
- Show availability without exposing secret values.
- Mark `local-editorial-v1`, `python-template-v1`, `macos-say-v1`, `python-ffmpeg-v1`, and `python-technical-review-v1` according to local runtime checks.
- Mark Pexels/Pixabay according to key presence.
- This page is diagnostic. It does not edit `.env.local` or secrets.

## 4. Information Architecture

Routes:

- `/` - Production queue.
- `/runs/:runId` - Run detail and review.
- `/providers` - Provider/runtime availability.

Global UI:

- Desktop left rail and mobile top bar.
- New production drawer available from queue and run detail.
- Compact system health indicator.

No Topics navigation is exposed until topic intelligence is connected to `daily-production`.

## 5. Architecture

```text
React + Vite Studio
        | JSON / SSE / byte-range media
        v
Fastify Studio API
        |
        +-- StudioRunCoordinator
        +-- ProductionPipeline
        +-- FileRunStore
        +-- Provider/runtime discovery
        |
        v
Python worker -> FFmpeg / say / stock providers
```

### 5.1 Repository Shape

- `apps/studio/src/server/` owns HTTP, SSE, media streaming, and background run coordination.
- `apps/studio/src/client/` owns React screens, components, hooks, and CSS.
- `apps/studio/src/shared/` owns browser-safe API DTOs and runtime validators.
- `packages/production-pipeline` remains the domain-facing production service.
- `packages/workflow-core` remains the state machine and contract owner.

### 5.2 Technology

- React 19.
- Vite 8.
- Fastify 5 and `@fastify/static` 10.
- Lucide React icons.
- Vanilla CSS tokens based on `DESIGN.md`.
- Vitest, Testing Library, and Node test runner.
- Browser verification through Playwright CLI.

No UI framework or chart library is needed for the first release. A workflow canvas library is intentionally deferred because the graph is read-only.

## 6. API Contract

### `GET /api/health`

Returns server health and required runtime checks. It never returns secrets.

### `GET /api/providers`

Returns capability groups and provider descriptors:

```ts
interface StudioProvider {
  id: string;
  capability: string;
  label: string;
  available: boolean;
  kind: "local" | "external" | "test";
  requirement?: string;
}
```

### `GET /api/runs`

Returns lightweight run summaries, newest first.

### `POST /api/runs`

Accepts `video-factory/brief-v1`. Returns HTTP 202 after the initial `run.json` checkpoint:

```ts
interface StartRunResponse {
  runId: string;
  status: "running";
}
```

The media workflow continues in the server process.

### `GET /api/runs/:runId`

Returns a browser-safe run detail DTO. Artifact file paths are retained for local diagnostics but media consumption uses API URLs.

### `GET /api/runs/:runId/events`

Sends named `run` events containing the latest run detail DTO. It sends the current snapshot immediately, heartbeats while open, and closes after a terminal status.

### `POST /api/runs/:runId/decisions`

Accepts:

```ts
interface StudioDecisionInput {
  action: "approve" | "reject";
  actor: string;
  note?: string;
}
```

The API resolves the active intervention. Clients never copy an intervention id.

### `GET /api/runs/:runId/artifacts/:artifactId/content`

Streams one file artifact after validating that the artifact belongs to the run and resolves inside that run directory. Video responses support one `Range` interval and return HTTP 206.

## 7. Background Execution And Events

`ProductionPipeline.dispatch()` starts a run with a preallocated id, waits for the first persisted checkpoint, then returns `{ runId, completion }`. Existing `start()` remains compatible and awaits `completion`.

`StudioRunCoordinator` owns background completions and an in-process event hub. Every pipeline checkpoint publishes a snapshot. Run listing and page refresh still read `run.json`, so the event hub is an optimization rather than the source of truth.

If the server stops during an automatic node, the run remains discoverable as `running`, matching the Loop 9 contract. Automatic retry/resume is not added in this release.

## 8. Error Handling

- Invalid form input returns HTTP 400 with field-safe error text.
- Unknown runs/artifacts return HTTP 404.
- Stale or duplicate human decisions return HTTP 409.
- Missing provider/runtime returns HTTP 400 before dispatch.
- Background failures that reach the workflow state appear in the run detail.
- Unexpected background promise rejection is logged and an event attempts to refresh persisted state.
- The client preserves the last valid run snapshot when SSE reconnects.

## 9. Security And Privacy

- The browser never receives API keys or complete environment data.
- Run ids and artifact ids are validated against persisted state.
- Artifact realpaths must remain inside the selected run directory.
- HTML responses receive a restrictive local-app Content Security Policy where compatible with Vite output.
- The server binds to `127.0.0.1` by default.
- No external publish, OAuth, account system, or remote access is introduced.

## 10. Visual And Interaction Requirements

`DESIGN.md` is the visual source of truth.

Required design states:

- Empty queue.
- Running with partial node completion.
- Waiting for human review with playable video.
- Technical rejection with retained review artifact.
- Worker failure with node error.
- Approved success with publish package.
- Missing external provider key.
- Long Chinese title and narrow mobile viewport.

Required viewports:

- 1440x900 desktop.
- 1920x1080 wide desktop.
- 768x1024 tablet.
- 390x844 mobile review.

## 11. Testing And Verification

- TDD for store listing, dispatch lifecycle, API validation, decision resolution, SSE, and range streaming.
- Component tests for empty queue, create form validation, run workflow state, and review action behavior.
- Existing Python, workflow-core, production-pipeline, package, and real media E2E remain green.
- Playwright executes create -> observe -> play -> approve -> publish package through the Web Studio.
- Desktop and mobile screenshots are inspected after every visual review pass.
- Console errors, failed network calls, overflow, overlap, and video non-rendering are blockers.

## 12. Out Of Scope

- Visual workflow graph editing.
- Node retry, edit, replace-asset, or choose-provider interventions.
- Automatic platform publishing.
- Platform metrics ingestion in the Studio.
- Topic intelligence integration.
- Authentication, multi-user collaboration, or remote deployment.
- Distributed queue, database migration, or cross-host locks.

## 13. Acceptance Criteria

The release is complete only when all are true:

1. A user creates a valid run from the Web form without JSON or CLI.
2. The run page appears after the first checkpoint and updates through SSE.
3. The real 1080x1920 render plays in the browser with audio.
4. Approve and reject work without intervention ids and prevent duplicate submission.
5. Approval creates and exposes `publish_package.json` without rerunning media nodes.
6. Queue, provider status, workflow, artifacts, errors, and decisions are usable on desktop.
7. A waiting run can be reviewed and decided at 390x844 without overlap.
8. Loading, empty, error, running, waiting, rejected, and succeeded states are visibly designed.
9. Automated suites and real-media E2E pass.
10. Playwright functional and screenshot review finds no unresolved blocker.
