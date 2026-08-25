# Loop 20: Trustworthy Creator Workflow Results

Date: 2026-08-24

## Outcome

VideoFactory Studio now guides a first-time creator from topic discovery to a reviewed production without hiding the evidence, risk, cost, or human decisions. The same workflow supports trends, durable series, and creator-owned ideas while keeping sensitive public-event claims source-grounded.

## Delivered

- Added a persistent 15-step cross-page creator guide, a shorter current-page guide, a floating re-entry action, back navigation, and early exit.
- Added progressive candidate loading so series ideas remain usable while the local trend model is warming up.
- Added explicit verification states: ready, confirmation required, and blocked pending additional independent sources.
- Required two independent URL-backed sources before a high-risk public-event candidate can be adopted.
- Prevented local-model expansions from entering high-risk titles, hooks, or rationales when those facts are absent from source evidence.
- Added category, platform, freshness, and risk filters plus transparent score contribution and risk-penalty explanations.
- Added an executable three-beat visual plan to each candidate, with editable material strategy rather than a fixed Pexels-only path.
- Added persistent creator defaults for voice direction, asset provider, and economic production recipe; new runs inherit those defaults.
- Expanded the local voice catalog, preview controls, pacing, punctuation pause, and mastering presets.
- Refined mobile controls, review actions, terminology, and editorial styling without exposing internal IDs or implementation terms.

## Trust Boundaries

- The local model proposes framing; source evidence remains authoritative.
- Medium-risk adoption requires explicit human confirmation.
- High-risk adoption is blocked until two independent sources with evidence URLs are present.
- Production does not start until the creator submits the editable Brief.
- A publish package is not generated until machine checks pass and a human approves the rendered video.
- Platform publishing and platform metrics remain unimplemented and are not simulated in the UI.

## Production Evidence

- Created real run `run-fd126e6b-6f97-4a76-b1d6-72edbbcc0e77` from an adopted opportunity.
- Produced an audible 24-second, 1080x1920 video with browser `readyState=4`.
- Verified rejection requires a reason and can be cancelled without mutating the run.
- Approved the run through the real review action and generated its publish package.

## Browser Verification

The production build at `http://127.0.0.1:4317/` was exercised with real browser clicks.

- Completed all 15 steps of the full guide, including its page transition, and completed the current-page guide.
- Reopened the guide from the floating action and verified early exit.
- Opened and closed series advanced settings, manual creation, JSON import, production creation, and every advanced Provider control.
- Previewed a real macOS voice and verified saved voice and material defaults persist.
- Exercised production filters, search, review rejection validation, cancellation, approval, and publish-package completion.
- Confirmed a high-risk one-source public-event candidate is classified as society and blocked with `1/2` sources.
- Browser console errors: none.

Responsive evidence:

| Viewport | Document overflow | Result |
| --- | --- | --- |
| 1440x900 | No | Candidate workspace, guide, production review, and resource defaults fit the page |
| 390x844 | No | Home, projects, run detail, resource controls, navigation, and review action fit the viewport |

## Automated Verification

- `make test`: Python 31/31; workflow/package TypeScript 50 passed with 1 opt-in E2E skipped; Studio frontend 47/47; Studio server/domain 70/70; package entrypoints 3/3.
- `make test-e2e`: 1/1 passed and rendered an audible 1080x1920 production package.
- Production Vite and TypeScript builds completed successfully.

## Remaining Boundaries

- DailyHotApi and NewsNow provide normalized signals; TrendRadar and RSSHub currently contribute health evidence but not normalized items.
- The local Qwen model may need about one minute to warm after a cold start; the UI exposes progressive loading and the server caches completed proposals.
- Pexels, Pixabay, Seedance, Wan, Kling, and similar external providers remain disabled until their own credentials and cost controls are configured.
- Automatic platform publishing and post-publication metric ingestion remain intentionally outside this loop.
