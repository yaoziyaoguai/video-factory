# Loop 10: Web Operator Studio

Date: 2026-08-21
Status: Complete

## Objective

Turn the Loop 9 production engine into a daily-use Web Studio. The user must be able to create, observe, review, and complete a real video run without editing JSON, copying ids, browsing artifact directories, or invoking CLI commands.

## Loop Semantics

This loop has no iteration limit. It ends when every exit condition is supported by fresh evidence. A visual or behavioral defect starts another implementation -> run -> inspect -> correct cycle.

## Approved Product Direction

- Desktop-first operational workspace with mobile review support.
- Production queue as the first screen, not a landing page.
- Read-only workflow state, real video, evidence, and human action as the main content.
- React/Vite browser client and Fastify local API over existing TS/Python production services.
- Claude Design methodology is adopted through design-system-first inputs, multiple directions, complete states, and visual iteration. Claude Design access is optional and not a runtime dependency.

## Inputs

- `DESIGN.md`
- `docs/superpowers/specs/2026-08-21-web-studio-design.md`
- `docs/guides/production-workflow.md`
- `docs/adr/002-local-production-runtime.md`
- `examples/briefs/life-avoidance-local.json`
- Real Loop 9 run `run-d8ed8ff7-2ba1-470b-8ad1-e1af6dab1f56`

## Exit Conditions

- [x] Web form dispatches a real run and returns after the first checkpoint.
- [x] Queue and run detail survive refresh by reading persisted `run.json` files.
- [x] SSE updates workflow progress without full-page reload.
- [x] Browser streams and plays the real render with byte-range support.
- [x] Manual approve/reject completes through Web UI and guards duplicate decisions.
- [x] Successful approval exposes the publish package.
- [x] Provider page reports local runtime and external key availability without secrets.
- [x] Empty, loading, running, waiting, failed, rejected, and succeeded states are implemented.
- [x] Desktop, tablet, and mobile layouts have no overlap, clipping, or unreadable controls.
- [x] Python, TS, package, Studio, and real-media E2E tests pass.
- [x] 本次开发会话使用 Playwright 完成真实用户流并检查控制台与网络；仓库尚未包含可重复执行的 Playwright 测试套件。
- [x] Code review and design review blockers are fixed and rerun.

## Loop Evidence

Evidence is recorded in `docs/loops/010-web-operator-studio-results.md`. Screenshots belong under ignored `output/playwright/loop-10/` and generated run media remains under ignored `workspace/`.

## External Dependencies

- Pexels/Pixabay keys remain optional; the local editorial provider proves the zero-key path.
- Platform upload credentials are outside this loop.
- Claude Design subscription is optional; no acceptance criterion depends on it.
