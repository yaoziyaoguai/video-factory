# Loop 17: Guided Creator Canvas Results

Date: 2026-08-24

## Outcome

VideoFactory Studio now opens as a guided creator workspace instead of an unexplained operations console. A versioned, route-aware product tour walks a first-time user from a real opportunity through visual direction and the production recipe without submitting a run. The home workspace now presents cached real footage as an editorial contact sheet before the scorecard, so the visual idea is visible in the first desktop, tablet, and mobile viewport.

## Delivered

- Added Driver.js 1.8.0 as the only new runtime dependency.
- Added exception-safe, versioned tour completion storage.
- Added automatic first-run launch and replay from desktop sidebar or mobile header.
- Added nine Chinese tour steps with progress, keyboard support, missing-element skipping, and one real click-through action.
- Kept the final `开始生产` action manual; completing the tour leaves the production dialog open.
- Added stable `data-tour` anchors without coupling business components to Driver.js.
- Rebuilt the selected opportunity surface as a director contact sheet using three cached Pexels frames.
- Added serif editorial headings, a field-slate sidebar note, shot numbers, shot roles, timing labels, and reduced-motion-safe reveal motion.
- Compacted the mobile opportunity rail so real footage is visible before the fixed bottom navigation.
- Corrected the mobile production dialog to remain fully inside a 390x844 viewport.

## Architecture

- `creator-tour-state.ts` owns only versioned browser persistence.
- `use-creator-tour.ts` owns Driver.js lifecycle, steps, routing, and replay.
- `AppShell` owns the two help entry points.
- Business components expose only stable DOM anchors.
- Driver.js base styles and VideoFactory tour theming remain separate from the main Studio visual system.

## Browser Verification

The production build at `http://127.0.0.1:4317/` was tested in the in-app browser with real clicks.

- Completed all nine tour steps on desktop and mobile.
- Verified step 7 requires clicking the real `创建创意方案` button.
- Verified the production dialog appears and the tour continues to `制作配方` and `开始生产`.
- Verified tour completion does not click `开始生产` and leaves the dialog open.
- Verified Escape closes the production dialog.
- Verified replay from `/resources` returns to `/` and starts at the welcome step.
- Verified closing the tour suppresses automatic replay after refresh.
- Switched between both real opportunities and returned to the selected sports opportunity.
- Opened and closed the opportunity-entry dialog.
- Selected `免费实拍`, expanded advanced provider nodes, opened the voice node, switched to `系统音色19`, and cancelled safely.
- Navigated through `/projects`, `/resources`, `/experiments`, and back to `/`.
- Browser console warnings and errors: none.

Responsive evidence:

| Viewport | Horizontal overflow | Real shot board visible in first viewport |
| --- | --- | --- |
| 1440x900 | No | 258 px |
| 768x1024 | No | 214 px |
| 390x844 | No | About 85 px above bottom navigation |

All seven pre-dialog mobile popovers and both production-dialog popovers remained inside the 390x844 viewport. The final mobile production dialog has an 8 px viewport inset and no cropped edge.

## Automated Verification

- `npm test`: passed the complete TypeScript typecheck, package, workflow, Studio component, API, service, provider, and build suites.
- Studio frontend: 33/33 tests passed.
- Studio server and domain: 49/49 tests passed.
- Workflow/package suites: 44 passed with the opt-in real E2E skipped in the ordinary unit run; package entrypoint tests 3/3 passed.
- `make test-py`: 31/31 tests passed.
- `make test-e2e`: 1/1 passed; rendered and approved an audible 1080x1920 production package.
- `git diff --check`: passed.
- Health probe: Python, FFmpeg, ffprobe, and macOS `say` all ready.
- Cached frame probe: HTTP 200, `image/jpeg`, non-empty content.
- Persistent service: launchd job running and Node listening on `127.0.0.1:4317`.

## Remaining Boundaries

- Seedance, Kling, Wan, and other metered visual models remain visibly unavailable until their API configuration and cost estimates are supplied.
- The tour intentionally does not submit a production run, approve review decisions, download artifacts, or open external evidence links.
- The first neural voice discovery after a cold service restart can take several seconds; the UI reports that capability state honestly while loading.
