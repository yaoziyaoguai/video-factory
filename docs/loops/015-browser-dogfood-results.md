# Loop 15: Browser Dogfood and First-Run Usability Results

## Outcome

The deployed Studio was exercised through its real browser UI, from choosing a topic through producing, reviewing and approving a finished video. The default path is now intentionally short: choose a topic, confirm the creative brief, then generate and review. Expert controls remain available as progressive disclosures.

## Usability Fixes

- Added a visible three-step "make one video today" path to the Today page.
- Replaced the blocking local-model cold-start screen with a progressive state and a direct manual-topic action.
- Reduced manual opportunity entry to four required creative fields; series, evidence and scoring are optional advanced controls with conservative defaults.
- Replaced raw JSON parser output with a Chinese, accessible validation message.
- Collapsed per-node Provider configuration by default while preserving every replaceable workflow node.
- Reduced the initial voice cast from 29 choices to a curated shortlist, with tabs for neural female, neural male and system voices.
- Added accessible labels to voice-rate and pause controls.
- Renamed the inverted compliance metric from "risk" to "safety".
- Normalized invalid model-generated track slugs and surfaced candidate-adoption failures in the UI.

## Browser Click Matrix

| Surface | Controls exercised | Result |
| --- | --- | --- |
| Today | Main navigation, opportunity selection, opportunity entry, JSON/manual tabs, advanced entry, cancel | Passed |
| Topic Agent | Adopt a real Qwen proposal into the opportunity pool | Passed after slug normalization fix |
| Production dialog | Four recipes, advanced disclosure, five workflow nodes, review mode, cancel | Passed |
| Voice direction | Four filters, voice selection, Kokoro preview, mastering preset | Passed; preview audio decoded |
| Projects | Four filters, search and clear, new production and cancel, completed-run link | Passed |
| Run review | Video preview, artifact links, reject dialog validation/cancel, approval | Passed |
| Resources | Refresh, four local trend services, voice filters and Tingting preview | Passed |
| Experiments | Real production statistics and honest empty platform-metrics state | Passed |
| Routes | `/providers`, `/runs/:id`, unknown run and back navigation | Passed |
| Responsive | Today and production dialog at desktop and `390x844` | Passed; no blocked or overlapping controls found |

The rejection mutation was not committed during dogfood because it would deliberately change the approved reference run. Its dialog, required-note gate and cancel path were clicked; the actual rejection transition is covered by automated workflow and UI tests.

## Real Production Proof

- Browser-created run: `run-ee4ad324-0d31-4557-a71f-3ef3826e343f`.
- Path: Pexels free stock + local Kokoro voice + FFmpeg render + technical review + human approval.
- Final state: `succeeded`, all eight workflow nodes succeeded, publish package created.
- Output: 1080x1920 H.264, AAC audio, 24.00 seconds, 4,672,714 bytes.
- Technical review: all 11 checks passed, including audible audio, target duration, scene coverage and no mock assets.

## Automated Verification

- `npm test`: exit 0; typecheck, 44 core TypeScript tests, 28 frontend tests, 48 Studio/service tests, production build and 3 package tests passed. The real E2E case is intentionally skipped in this unit command.
- `make test-py`: 31 tests passed.
- `make test-e2e`: one real audible 1080x1920 production and approval passed.
- `git diff --check`: passed.

## Honest Boundaries

- Paid Seedance, Wan, Kling, Hailuo and Vidu calls were not exercised because their credentials and explicit cost estimates are intentionally absent.
- Automated publishing and platform analytics remain unavailable; the UI states this instead of presenting simulated metrics.
- Browser automation could not move native range inputs through its driver. Real keyboard/value behavior is covered by the frontend component test, while every surrounding voice control was clicked in the browser.
