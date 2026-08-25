# Trend Source Landscape

Date: 2026-08-23

## Decision

Use one owned aggregation spine instead of coupling the product to many scrapers:

1. **TrendRadar** is the preferred intelligence store. It preserves Chinese hot-list snapshots, rank history, RSS, SQLite data, and exposes an MCP service.
2. **NewsNow** is the preferred current-list collector behind TrendRadar. Production should self-host it instead of depending on the public demonstration instance.
3. **DailyHotApi** is a fallback normalized JSON/RSS source when a required platform is absent or unstable in NewsNow.
4. **RSSHub** supplies attributable long-tail feeds for Hong Kong, Taiwan, Singapore, Malaysia, overseas Chinese media, and vertical communities.
5. **Official platform APIs** remain the highest-authority source when approved scopes are available. They do not get silently replaced by scraping.

## Why This Shape

| Source | Strength | Limitation | Role |
| --- | --- | --- | --- |
| TrendRadar | Docker, SQLite history, rank trajectory, RSS, MCP | GPL-3.0; upstream hot lists still rely on collectors | Primary trend intelligence store |
| NewsNow | MIT, self-hostable, broad Chinese current lists, MCP | Snapshot-oriented; public instance has no production SLA | Primary current-list collector |
| DailyHotApi | Consistent JSON/RSS shape, Docker, simple routes | Some routes scrape pages and can change or be blocked | Fallback collector |
| RSSHub | Broad Chinese/global route ecosystem, self-hostable | Feed freshness is not the same as trend strength; AGPL-3.0 | Long-tail and overseas Chinese coverage |
| GDELT DOC API | Free multilingual global news search | News coverage is not social-platform popularity | International corroboration later |
| Google Trends API | Consistent regional search-interest series | Still limited alpha access | Future authoritative search signal |

## Required Ingestion Boundary

Every adapter must produce the same versioned signal before any model sees it:

```ts
interface TrendSignalV1 {
  sourceId: string;
  sourceKind: "official" | "aggregator" | "rss" | "manual";
  platform: string;
  title: string;
  canonicalUrl?: string;
  rank?: number;
  heat?: number;
  collectedAt: string;
  rawSnapshotRef: string;
}
```

The collector writes immutable raw snapshots first. Normalization, URL/title deduplication, cross-source clustering, velocity scoring, compliance filtering, and opportunity generation are separate workflow nodes. A failed source must not erase signals from healthy sources.

## Rollout

- **Now:** sources are visible in the Studio and can enter through the existing evidence-preserving JSON import.
- **Next:** build a TrendRadar MCP/SQLite adapter and a NewsNow HTTP adapter behind the shared signal contract.
- **Then:** add scheduled collection, deduplication, clustering, velocity scoring, and a human approval queue.
- **Later:** apply for Google Trends API access and add GDELT only as an international corroboration source.

## Compliance Boundary

Open-source software does not grant rights to republish upstream platform data. Keep request rates conservative, retain source URLs and collection times, respect platform terms and robots controls, and use official APIs for publication-critical claims whenever available.
