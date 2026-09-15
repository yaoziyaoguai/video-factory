// 只读：查 MiniMax TTS 在本环境的真实可用性 + 返工 run 现状。
import { writeFileSync } from 'node:fs';
import { withSession, BASE } from './browser.mjs';

const RUN_ID = 'run-e204cd6c-2365-4cda-bb1d-c50e6e69bb8a';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);

  const providers = await page.evaluate(async () => {
    const r = await fetch('/api/providers', { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  });
  console.log('=== /api/providers status', providers.status);
  const pj = JSON.parse(providers.body);
  const list = Array.isArray(pj) ? pj : (pj.providers ?? []);
  for (const p of list) {
    if (p.capability !== 'voice.synthesize') continue;
    console.log(JSON.stringify({
      id: p.id, label: p.label, available: p.available, status: p.status,
      kind: p.kind, billing: p.billing, requirement: p.requirement,
      defaultModelId: p.defaultModelId,
      models: (p.modelProfiles ?? []).map((m) => ({ id: m.id, available: m.available })),
    }, null, 0));
  }
  writeFileSync('/tmp/vf-providers-voice.json', JSON.stringify(list.filter((p) => p.capability === 'voice.synthesize'), null, 2));

  const caps = await page.evaluate(async () => {
    const r = await fetch('/api/local-capabilities', { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  });
  console.log('=== /api/local-capabilities status', caps.status);
  writeFileSync('/tmp/vf-local-caps.json', caps.body);
  try {
    const cj = JSON.parse(caps.body);
    const voice = (cj.capabilities ?? cj.providers ?? []).filter?.((c) => /voice|配音|say|tts/i.test(JSON.stringify(c))) ?? [];
    for (const v of voice.slice(0, 6)) console.log('  cap:', JSON.stringify(v).slice(0, 400));
  } catch { console.log('  raw:', caps.body.slice(0, 600)); }

  const run = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}`);
  writeFileSync('/tmp/vf-rework-run.json', run.body);
  const rj = JSON.parse(run.body);
  console.log('=== rework run', rj.id, 'status', rj.status, 'revision', rj.revision);
  for (const n of rj.nodeRuns ?? []) console.log('  node', n.nodeId, n.status, String(n.error ?? '').slice(0, 160));
  const cr = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}/creative-review`);
  writeFileSync('/tmp/vf-rework-creative-review.json', cr.body);
  console.log('=== creative-review status', cr.status);
  try {
    const c = JSON.parse(cr.body);
    console.log('  reviewRevision', c.reviewRevision, 'phase', c.phase, 'allowedActions', JSON.stringify(c.allowedActions));
    let total = 0;
    for (const sh of c.draft?.shots ?? []) {
      total += sh.estimatedCostCny ?? 0;
      console.log('   ', JSON.stringify({ scene: sh.scenePosition, delivery: sh.deliveryType, provider: sh.preferredProviderId, reuseFrom: sh.reuseFromScenePosition ?? null, est: sh.estimatedCostCny }));
    }
    console.log('  TOTAL est =', total);
  } catch { console.log('  raw:', cr.body.slice(0, 400)); }
});
