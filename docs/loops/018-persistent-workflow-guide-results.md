# Loop 18: Persistent Workflow Guide Results

Date: 2026-08-24

## Outcome

VideoFactory Studio now keeps a persistent, route-aware creator guide available throughout the product. The guide explains the complete short-video loop instead of stopping at the production recipe: choose an opportunity, set a recipe, run production, review the video, collect the publish package, and record real outcomes.

## Delivered

- Added a fixed `创作向导` entry on desktop and mobile.
- Added a compact six-step production map with complete-workflow and current-page actions.
- Kept the existing sidebar and mobile-header help buttons as additional guide entry points.
- Automatically opens the guide once when entering the project queue or a production workbench during the current app session.
- Added a visible `提前结束` action to every Driver.js popover while retaining the close button and keyboard controls.
- Expanded the complete walkthrough from 9 to 14 steps, including production monitoring, human review, publish packages, experiment review, and the persistent help entry.
- Added route-specific tours for the opportunity desk, project queue, production workbench, resources, and experiments.
- Added stable tour anchors to the queue, run workflow, preview, review actions, artifacts, trend services, voice studio, visual providers, and experiment outcomes.
- Versioned first-run completion as `creator-canvas-v2` so existing local users see the materially improved walkthrough once.

## Architecture

- `creator-tour-steps.ts` owns all walkthrough copy and route-specific step definitions.
- `use-creator-tour.ts` owns Driver.js lifecycle, route replay, completion persistence, and the early-exit control.
- `GuideDock.tsx` owns the persistent help surface and session-scoped project prompts.
- `AppShell` owns only the open state and connects the guide surface to the tour controls.
- Business pages expose stable `data-tour` anchors without importing the onboarding implementation.

## Browser Verification

The production build at `http://127.0.0.1:4317/` was tested with real browser clicks.

- Ended the automatic first-run walkthrough with the visible `提前结束` action.
- Opened the floating guide and started the current-page tour.
- Entered `/projects` and verified the guide opened automatically with the correct next action.
- Completed all 6 project-queue steps.
- Opened a real completed run and verified the production-workbench prompt.
- Completed all 6 production-workbench steps.
- Started the complete walkthrough from the run page, returned to `/`, clicked the real `创建创意方案` control, and completed all 14 steps.
- Verified the walkthrough did not click `开始生产` and left the production recipe open for the operator.
- Reopened the guide from the desktop sidebar and from the mobile header.
- Completed all 4 resource-page steps and all 3 experiment-page steps.
- Browser console warnings and errors: none.

Responsive evidence:

| Viewport | Horizontal overflow | Guide panel | Fixed navigation clearance |
| --- | --- | --- | --- |
| 1440x1000 | No | Fully visible | 22 px canvas inset |
| 390x844 | No (`390/390`) | `360x327`, fully visible | Trigger ends at `768`, navigation starts at `778` |

## Automated Verification

- Studio typecheck: passed.
- Studio production build: passed.
- Studio frontend: 35/35 tests passed.
- Studio server and domain: 49/49 tests passed.
- Health probe: Python, FFmpeg, ffprobe, and macOS `say` ready.

## Remaining Boundaries

- The guide intentionally never starts a paid production, approves a human-review decision, downloads an artifact, or publishes externally.
- Automatic guide prompts are session-scoped; the permanent floating, sidebar, and mobile-header entries remain available after dismissal.
- Project tours skip a missing first-item highlight when the queue is empty, while the queue-level explanation remains available.
