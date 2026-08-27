# Loop 19: Topic Inbox and Series Results

Date: 2026-08-24

## Outcome

VideoFactory Studio now treats topic selection as a first-class editorial workflow. Trend proposals, persistent series, and creator-owned ideas are three peer entry modes, all converging on the same reviewed opportunity and production pipeline.

## Delivered

- Replaced the hidden two-opportunity start state with a unified candidate inbox that currently exposes all 8 grounded trend proposals and 6 upcoming series episodes.
- Added independent subject taxonomy, platform filtering, freshness, risk, source evidence, provider identity, and category facets.
- Added persistent series definitions with audience, premise, content pillars, tone, visual direction, platform, and a durable next-episode cursor.
- Added deterministic local series planning with six numbered upcoming episodes and no API cost.
- Preserved the existing trend and opportunity APIs while adding candidate inbox, adoption, series list, and series creation routes.
- Made candidate adoption idempotent through stable candidate IDs and monotonic series-cursor recovery when opportunity persistence gets ahead of series persistence.
- Added manual and JSON creator-owned entry paths to the same opportunity workflow.
- Updated the persistent creator guide to explain the three topic origins before production.
- Corrected Chinese-world topic classification for education signals such as `四六级` and `新生` without coupling category to a production track.

## Architecture

- `topic-taxonomy.ts` owns deterministic category, freshness, and risk classification.
- `series-store.ts` owns atomic JSON persistence, strict concurrency checks, and monotonic recovery.
- `series-planner.ts` turns a durable series promise into upcoming episode candidates.
- `series-studio.ts` owns series use cases and translates persistence errors into Studio errors.
- `candidate-inbox-studio.ts` composes trends, series, facets, filtering, deduplication, and adoption.
- `TopicEntryWorkspace.tsx` owns the three peer entry modes; `TodayPage.tsx` remains the page orchestrator.

## Production Evidence

- Live inbox: 14 candidates, including 8 Qwen3-backed trend proposals and 6 locally planned series episodes.
- Live facets after the final taxonomy pass: lifestyle 3, education 2, finance/career 1, society 2, and technology series 6.
- Created the real local series `普通人的 AI 真任务` and adopted episode 01 into the production opportunity store.
- Reloaded the application and verified the next available episode advanced to 02 while episode 01 no longer appeared in the inbox.

## Browser Verification

The production build at `http://127.0.0.1:4317/` was tested with real browser clicks.

- Selected the `社会 2` facet and saw exactly 2 high-risk candidates; restored all 8 trend candidates.
- Selected the Douyin platform and retained all 8 matching trend candidates.
- Opened the series mode and saw 6 candidates beginning at episode 02 plus the new-series action.
- Opened and cancelled both manual-entry and JSON-import dialogs.
- Opened the persistent creator guide, started the current-page walkthrough, and ended it with the visible `提前结束` action.
- Loaded `/projects`, `/resources`, `/experiments`, and `/` with the expected page headings.
- Browser console warnings and errors: none.

Responsive evidence:

| Viewport | Document overflow | Result |
| --- | --- | --- |
| 1440x1000 | No (`1440/1440`) | Two-column candidate list and detail panel fully visible |
| 390x844 | No (`390/390`) | Tabs, filters, candidate cards, guide trigger, and fixed navigation fit the viewport |

The mobile production shortlist intentionally uses an inner horizontal carousel; it does not create page-level overflow.

## Automated Verification

- `npm test`: passed full typecheck, workflow, Studio, production build, and package-entrypoint suites.
- Workflow/package TypeScript: 50 passed, 1 opt-in real E2E skipped by the ordinary test run.
- Studio frontend: 41/41 tests passed.
- Studio server and domain: 61/61 tests passed.
- Package entrypoints: 3/3 tests passed.
- `make test-py`: 31/31 tests passed.
- `make test-e2e`: 1/1 passed; rendered and approved an audible 1080x1920 production package.
- Health probe: Python, FFmpeg, ffprobe, and macOS `say` ready.

## Remaining Boundaries

- Trend generation can take up to about one minute after a cold local-model start; the UI exposes this loading state and subsequent reads use the server cache.
- The series planner is a deterministic, zero-cost local provider today. Its provider boundary can later be replaced or augmented by a model-backed planner without changing the inbox contract.
- Category classification is deterministic and auditable; adding a model classifier later should preserve this fallback and evidence boundary.
- Platform publishing and post-publication metrics remain outside this loop; opportunities still require explicit human adoption and production review.
