# Model Routing And Semantic Workspaces Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-28-model-routing-semantic-workspaces-design.md`

## Task 1: Stabilize Baseline And Add Model Catalog Contracts

- Reproduce the two existing Studio timeout failures independently.
- Add shared API contracts and parsers for model profiles, defaults, overrides, resolved snapshots and safe public metadata.
- Add server tests for old settings compatibility and invalid model selections.

## Task 2: Decouple Ark Provider From Seedance Model Selection

- Generalize the existing Ark video adapter identity without duplicating the Provider protocol.
- Register allowlisted Seedance profiles and keep the historical ID as a compatibility alias.
- Resolve global, template, run and node defaults deterministically.
- Bind spend authorization and execution receipts to the resolved model and bounded parameters.

## Task 3: Add Optional Semantic Production Nodes

- Introduce `AssetSemanticRanker` with deterministic fallback and inspectable ranking evidence.
- Introduce editable `ShotGrammar` and the optional reference-video analysis node.
- Feed effective human versions into downstream director and asset decisions.

## Task 4: Add Resource Manifest And Template Experiments

- Add resource manifest storage/API for BGM, SFX, fonts and media provenance.
- Add scorecards for the three selected built-in templates without mutating published template versions.
- Expose both through the configuration and template surfaces.

## Task 5: Upgrade Node Preview And Editing

- Add role-specific structured editors for brief, script, director plan, semantic ranking, reference grammar and review reports.
- Keep raw JSON as an expert disclosure and route all saves through existing immutable version APIs.
- Improve source labels, empty states, cost language and stale dependency explanations.

## Task 6: Verification And Red-Team Loop

- Run unit, integration, type, build and browser tests.
- Run read-only Claude Code red-team audits with GLM-5.3-Flash and GLM-5.3 separately.
- Run an independent Codex red-team audit and a final cross-audit against all findings.
- Fix every confirmed finding and rerun scoped plus full verification.

## Task 7: Cloud Release And Bounded Paid Canary

- Deploy through GitHub Actions only after all preflight checks pass.
- Run authenticated cloud API and browser canaries.
- Authorize exactly one minimum-duration Seedance 2.5 generation with a maximum CNY 10 ceiling, no automatic retry, and retain its receipt and artifact.
- Do not publish the generated video to any external platform.
