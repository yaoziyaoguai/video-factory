# VideoFactory Creative OS Shell Design

Date: 2026-08-22
Status: Approved
Selected direction: Director Desk structure with Signal Room data language

## 1. Objective

Replace the current operator console with the first coherent Creative OS surface for one serious short-video creator. The application must make the daily decision obvious: identify a defensible opportunity, inspect its evidence, choose a creative direction, and move it into production without losing provenance, cost, or workflow state.

This change is a product-information-architecture redesign, not a visual reskin. It preserves the working production pipeline and moves it behind a creative workflow that exposes real data only.

## 2. Success Criteria

1. The first screen answers three questions without opening another page: what is worth making today, why the system believes that, and what action is next.
2. Opportunity scores always identify their source and collection time. Missing trend connectors produce a designed unconfigured state, never invented metrics.
3. A user can create or import an opportunity manually, inspect its evidence, and use it to prefill the existing production brief.
4. Active and review-blocked production runs remain visible from the daily workspace.
5. Provider and model readiness is visible in context without exposing secret values.
6. The interface has no horizontal page overflow at 390, 768, 1440, and 1920 CSS pixels.
7. Existing run creation, run streaming, review decisions, artifact download, and byte-range video playback continue to work.

## 3. Product Boundary

This implementation unit owns the Creative OS shell and an honest opportunity workflow.

Included:

- New application navigation and responsive shell.
- `Today` opportunity workspace using the approved A+C visual direction.
- Persistent manually entered or imported opportunity candidates.
- Evidence and score display using the existing topic scoring domain model.
- Opportunity-to-production handoff into the existing `StudioProductionInput` flow.
- Production projects page built from real workflow runs.
- Resource/model readiness page built from real provider health.
- Experiment page with real run history and an explicit analytics-unconfigured state.
- Redesigned run workbench using the same design system.

Not included in this unit:

- Automated scraping of platform pages.
- A production LLM, VLM, embedding, TTS, image, or video model invocation.
- Automated platform publishing.
- Fabricated trend, account, cost, or performance data.
- Replacing the workflow runtime with Temporal or LangGraph.

Those capabilities remain separate implementation units because they introduce external contracts, credentials, cost controls, and durable orchestration decisions.

## 4. Information Architecture

### Today (`/`)

The default workspace uses a three-pane desktop layout:

1. Opportunity rail: ranked candidates with score, source count, freshness, and status.
2. Opportunity focus: title, evidence, score breakdown, reference links, and creative angle.
3. Director panel: production recommendation, provider readiness, expected production mode, and the primary action.

On mobile, the rail becomes a horizontally scrollable candidate strip, followed by the focus and director sections. The selected candidate remains visually stable while content loads.

When no opportunities exist, the focus area becomes an unframed empty workspace with two actions: create manually and import structured JSON. It also names the missing automated signal capability without claiming that it exists.

### Projects (`/projects`)

This page replaces the current production queue route. It preserves scan-friendly rows and adds:

- active, waiting-for-review, completed, and failed filters;
- current node and elapsed time;
- a compact production strip reused by the Today page;
- direct access to run review.

### Run Workbench (`/projects/:runId`)

The workbench keeps video as the primary visual surface. Desktop uses a video monitor, a compact workflow rail, and a sticky review/director panel. Artifacts are grouped by production phase rather than displayed as one long undifferentiated file list.

### Resources (`/resources`)

The page groups providers by capability: intelligence, script, assets, voice, generation, render, review, and publishing. Only capabilities currently supported by the backend appear as available. Missing model gateways are represented as missing capabilities, not fake providers.

### Experiments (`/experiments`)

The initial page derives counts and outcomes only from persisted workflow runs. Platform performance areas display an analytics connector setup state until authorized account metrics exist.

## 5. Domain And API Contracts

### Opportunity DTO

The Studio API exposes a UI-focused contract derived from `TopicCandidate`:

```ts
interface StudioOpportunity {
  id: string;
  title: string;
  platform: string;
  track: string;
  audience: string;
  painPoint: string;
  hook: string;
  status: "draft" | "shortlisted" | "approved" | "rejected" | "tested";
  score: TopicScore;
  scoreProvenance: {
    source: string;
    scoredAt: string;
  };
  evidence: Array<{
    source: string;
    platform: string;
    keyword: string;
    strength: number;
    evidenceUrl?: string;
    collectedAt?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}
```

`title` is an explicit display title. It must not be reconstructed from `painPoint` or `hook` in the client.

### Endpoints

- `GET /api/opportunities`: list persisted opportunities ordered by final score and freshness.
- `POST /api/opportunities`: validate, score, and persist a manual or imported opportunity.
- `GET /api/opportunities/:opportunityId`: return one candidate or `404`.
- `PATCH /api/opportunities/:opportunityId/status`: update editorial status with conflict validation.
- Existing `POST /api/runs`: remains the production entry point. The client maps the selected opportunity into an editable production brief before dispatch.

### Persistence

Use an append-safe JSON repository under the configured workspace root. Writes use a temporary file followed by atomic rename. The service receives the repository through dependency injection so tests use an in-memory substitute.

Opportunity provenance is immutable after creation. Editorial status and display title may change. Score changes require a new scoring event rather than silent mutation; score history can be added in the later trend-intelligence unit.

## 6. Component Boundaries

- `CreativeShell`: navigation, runtime health, responsive layout, and no domain fetching.
- `TodayPage`: coordinates opportunity, provider, and active-run queries.
- `OpportunityRail`: candidate selection and compact score display.
- `OpportunityFocus`: evidence and score breakdown; no mutation logic.
- `DirectorPanel`: provider-aware recommendation and production handoff.
- `OpportunityDialog`: manual/import entry and validation.
- `ProductionStrip`: shared active-run summary.
- `ProjectsPage`: run filtering and navigation.
- `RunWorkbench`: video review, workflow state, grouped artifacts, and decisions.
- `ResourcesPage`: provider capability inventory.
- `ExperimentsPage`: workflow-derived outcomes and analytics setup state.

Pages own asynchronous state. Presentational components receive typed props and callbacks. API DTO parsing remains in the shared contract layer.

## 7. Visual System

The shell uses the approved Director Desk composition:

- warm neutral canvas, near-black navigation, white work surfaces;
- vermilion for primary creation actions;
- cobalt for information and selection;
- green for verified readiness and positive signals;
- photography and video frames as the visual center;
- 4 to 6 pixel control radii, no gradients, glass effects, or decorative blobs;
- Manrope-compatible UI typography with system Chinese fallbacks;
- tabular numerals for scores, cost, duration, and run state.

Signal Room conventions apply to operational data:

- compact headers and stable table tracks;
- short inline bars for relevance and risk;
- explicit source/freshness labels;
- no decorative charts without a decision attached;
- no color-only status communication.

The design prototype is stored outside the repository at:

`~/.gstack/projects/yaoziyaoguai-vedio-factory/designs/creative-os-20260822/board.html`

## 8. Interaction And State

- Selecting an opportunity updates the focus and director panels without navigation.
- Creating a production opens a prefilled brief drawer; dispatch occurs only after explicit confirmation.
- Missing required providers disable dispatch and link to the relevant Resources capability group.
- External evidence links open in a new tab and show their source hostname.
- Loading uses stable skeleton geometry; it does not resize the three-pane grid.
- Network failure stays local to the affected panel and provides retry.
- Empty, unconfigured, unavailable, and error are separate states with different actions.
- Keyboard focus is visible, dialogs trap focus, and icon-only buttons have labels and tooltips.

## 9. Error Handling

- Invalid opportunity input returns `400` with a field-safe message.
- Duplicate opportunity IDs return `409`.
- Invalid status transitions return `409`.
- Repository I/O failures return `500` and are logged without leaking local paths to the client.
- A failed opportunity query does not block projects or provider health from rendering.
- Production dispatch preserves the existing provider availability validation.

## 10. Verification

### Unit and service tests

- Opportunity validation, scoring, ordering, persistence, and status transitions.
- Studio service mapping from domain candidates to DTOs.
- Empty, unconfigured, populated, and failure page states.
- Opportunity selection and production-brief prefill.
- Existing review and artifact behavior regression tests.

### Browser verification

- Desktop: 1440x900 and 1920x1080.
- Tablet: 768x1024.
- Mobile: 390x844.
- No horizontal page overflow.
- Long Chinese titles wrap without covering score or actions.
- Directional navigation, dialogs, disabled providers, run review, and video playback work.
- Console has no errors or unhandled promise rejections.

## 11. Delivery Sequence

1. Add opportunity contracts, repository, API, and service tests.
2. Replace the shell and implement Today with honest empty/unconfigured states.
3. Implement manual/import opportunity creation and production handoff.
4. Move the queue to Projects and redesign the run workbench.
5. Add Resources and Experiments surfaces using real backend state.
6. Run unit, integration, accessibility, and responsive browser verification.

The next product unit after this shell is Trend Intelligence: source adapters, normalization, clustering, velocity, saturation, and provenance-aware ranking. Agent Graph and Model Gateway follow once the intelligence inputs are real.
