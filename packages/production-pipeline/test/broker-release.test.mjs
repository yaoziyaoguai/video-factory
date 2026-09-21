import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('the exact Docker host-broker subset imports outside the monorepo', async () => {
  const root = process.cwd();
  const staging = await mkdtemp(path.join(tmpdir(), 'vf-host-broker-'));
  try {
    await cp(path.join(root, 'apps/codex-broker/dist'), path.join(staging, 'dist'), { recursive: true });
    await cp(path.join(root, 'apps/codex-broker/package.json'), path.join(staging, 'package.json'));
    await cp(path.join(root, 'node_modules/undici'), path.join(staging, 'node_modules/undici'), { recursive: true });
    const target = path.join(staging, 'node_modules/@video-factory/production-pipeline');
    await mkdir(path.join(target, 'dist'), { recursive: true });
    await cp(path.join(root, 'packages/production-pipeline/package.json'), path.join(target, 'package.json'));
    const dockerfile = await readFile(path.join(root, 'docker/Dockerfile'), 'utf8');
    const files = [...dockerfile.matchAll(/^COPY --from=builder \/app\/packages\/production-pipeline\/dist\/(\S+\.js) apps\/codex-broker\/node_modules\/[^\n]+$/gm)];
    assert.ok(files.length > 0);
    for (const [, file] of files) await cp(path.join(root, 'packages/production-pipeline/dist', file), path.join(target, 'dist', file));
    const module = await import(pathToFileURL(path.join(staging, 'dist/model-registry.js')).href);
    assert.equal(typeof module.ModelRegistry, 'function');
  } finally { await rm(staging, { recursive: true, force: true }); }
});
