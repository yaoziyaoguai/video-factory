# Loop 14: Editorial Studio, Local Intelligence and Voice Results

## Outcome

The Studio now runs as a local-first editorial production system rather than a fixed demo form. Real trend services, a local topic model, two local voice engines, free stock footage, deterministic rendering, technical review and human final review are connected through the same provider-aware workflow.

## Local Stack

| Capability | Runtime | Local endpoint/evidence | Result |
| --- | --- | --- | --- |
| Trend archive | TrendRadar | `127.0.0.1:8080` | Ready |
| Trend MCP | TrendRadar MCP | `127.0.0.1:3333` | Ready; protocol handshake required |
| Trend API | NewsNow | `127.0.0.1:4444` | Ready; live items returned |
| Trend API | DailyHotApi | `127.0.0.1:6688` | Ready; live Douyin items returned |
| Feed routing | RSSHub | `127.0.0.1:1200` | Ready |
| Topic Agent | Ollama + `qwen3:4b` | `.local/agent/qwen3.ready.json` | Ready; real structured proposals verified |
| Neural voice | Kokoro `zf_001` | `.local/voice/kokoro.ready.json` | Ready; smoke WAV and Studio preview verified |
| Media runtime | Python 3.11 + Pillow + FFmpeg | `.local/python/python.ready.json` | Ready |
| Free stock | Pexels | ignored local `.env` | Ready; real search and downloads verified |

Studio reports four of four self-hosted trend services, two production-ready visual sources, six local runtime capabilities and 29 Chinese local voices. API responses expose readiness evidence but never return environment values.

## Topic Intelligence

- DailyHotApi and NewsNow signals are normalized, deduplicated and retain source URLs, rank, heat and collection time.
- Qwen3 chooses signals, classifies the angle and proposes bounded scoring. A deterministic fallback remains available when Ollama fails.
- A 10-minute cache avoids repeating the 35-60 second local-model cold request on page reload.
- Titles and hooks pass a grounding boundary. Unsupported numbers, quotes, interviews, acronyms and clickbait claims are removed. Working titles are reconstructed from the original signal plus a category-specific verification question.
- If a small model returns an all-zero scorecard, bounded baseline values restore meaningful ordering without pretending they came from the model.
- Real final smoke output returned six Qwen-backed candidates with differentiated final scores from 79.2 to 87.4.

## Voice and Media Proof

Studio API previews:

- Kokoro `zf_001`: AAC mono, 44.1 kHz, 5.90 seconds.
- macOS Tingting: AAC mono, 44.1 kHz, 5.20 seconds.

Real Pexels + Kokoro production:

- Run: `run-d210f2df-4299-45d0-8c13-42dacbc1afca`.
- Final video: `output/pexels-kokoro-smoke-v2/runs/run-d210f2df-4299-45d0-8c13-42dacbc1afca/nodes/render/attempt-1/renders/1/final.mp4`.
- Contact sheet: `output/pexels-kokoro-contact-sheet-v2.jpg`.
- Format: 1080x1920 H.264 video, mono AAC audio, 24.23 seconds, peak -1.5 dB.
- Voice plan: Kokoro `zf_001`, 185 characters/minute, `intimate` mastering, per-scene tempo capped at 1.35x without truncation.
- Assets: four downloaded portrait Pexels videos plus one owner-generated ending card. Each item records source URL, creator and license note.
- Technical review: passed all stream, resolution, codec, audio, duration, scene coverage, file existence and no-mock checks; workflow correctly stopped at human final review.

The first stock smoke exposed generic and mismatched queries. A second loop added Chinese-topic-to-shot-intent mapping for workplace, sports, weather, economy, school, rural life, food and sleep themes. The resulting sequence reads as office fatigue, evening commute, quiet reflection, journaling and ending card.

## Product and Visual QA

- Today is an editorial Agent pitch room with source-grounded proposals and explicit human admission to the opportunity pool.
- Projects is a production archive with real 9:16 video previews, workflow progress and next actions instead of a generic admin table.
- Resources shows live trend service evidence, 29 previewable local voices, two ready visual sources, paid-provider boundaries and local craft runtimes.
- The production dialog expresses content brief, economic recipe and replaceable workflow nodes instead of five fixed selects.
- Desktop and 390x844 Playwright screenshots were inspected for Today, Projects, Resources and the production dialog.
- Mobile document width equalled viewport width, checked headings/buttons/links had no clipped text, eight project videos decoded at 1080x1920, and browser console reported zero errors or warnings.

## Verification

- `npm test`: 44 core TypeScript tests passed, one real E2E test skipped in the unit phase; 23 frontend tests, 47 Studio/service tests and 3 package tests passed; typecheck and production build passed.
- `make test-py`: 31 tests passed.
- `make test-e2e`: one real audible 1080x1920 production and approval passed.
- Real Pexels + Kokoro smoke: reached `needs_human` after a passing technical review.

## Honest Boundaries

- Pexels relevance is better but still probabilistic; visual continuity, cultural fit and face selection require human review or a future vision-ranking node.
- TrendRadar and RSSHub are deployed and health-checked, but the ranked signal gateway currently normalizes DailyHotApi and NewsNow. TrendRadar history and selected RSSHub routes still need dedicated adapters.
- Qwen is used for topic intelligence. Formal script generation is still deterministic template logic.
- Kokoro is local and free but slower than macOS `say`; the first synthesis also pays model warm-up cost.
- Pixabay, Seedance and Wan remain unavailable until their keys, model IDs and conservative price estimates are configured. Kling, Hailuo and Vidu remain explicit planned providers.
- Platform publishing and metrics ingestion remain manual. No account automation is presented as ready.
