import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";
import { JsonTemplateStore, TemplateRevisionConflictError } from "../src/server/template-store.js";

describe("JsonTemplateStore", () => {
  it("creates a new draft without cloning a built-in template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const store = new JsonTemplateStore(path.join(root, "templates.json"), BUILTIN_TEMPLATES);
    const timestamp = "2026-08-29T10:00:00.000Z";

    const created = await store.create({
      ...structuredClone(BUILTIN_TEMPLATES[0]!),
      id: "original-format",
      name: "原创栏目",
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    }, 0);

    assert.equal(created.storeRevision, 1);
    assert.equal(created.template.id, "original-format");
    assert.equal(created.template.status, "draft");
  });

  it("clones a built-in to an editable draft and publishes an immutable version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const file = path.join(root, "templates.json");
    const store = new JsonTemplateStore(file, BUILTIN_TEMPLATES, () => "2026-08-27T10:00:00.000Z");

    const draft = await store.clone("knowledge-explainer", "my-explainer", "我的解释栏目", 0);
    assert.equal(draft.storeRevision, 1);
    assert.equal(draft.template.status, "draft");
    assert.equal(draft.template.id, "my-explainer");

    const saved = await store.saveDraft({
      ...draft.template,
      description: "用一个日常问题解释复杂概念。",
    }, 1);
    assert.equal(saved.storeRevision, 2);

    const published = await store.publish("my-explainer", 2);
    assert.equal(published.storeRevision, 3);
    assert.equal(published.template.status, "published");
    assert.equal(Object.isFrozen(published.template), true);
    assert.match(await readFile(file, "utf8"), /my-explainer/);
  });

  it("rejects stale writes and never edits a built-in in place", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const store = new JsonTemplateStore(path.join(root, "templates.json"), BUILTIN_TEMPLATES);

    await assert.rejects(
      () => store.saveDraft({ ...BUILTIN_TEMPLATES[0]!, name: "覆盖内置" }, 0),
      /built-in/,
    );
    await store.clone("photo-story", "my-photo-story", "我的照片故事", 0);
    await assert.rejects(
      () => store.clone("product-demo", "another-demo", "另一个教程", 0),
      (error) => error instanceof TemplateRevisionConflictError,
    );
  });

  it("keeps curated built-ins ahead of user versions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const file = path.join(root, "templates.json");
    const store = new JsonTemplateStore(file, BUILTIN_TEMPLATES);
    await store.clone("photo-story", "my-photo-story", "我的照片故事", 0);

    const snapshot = await new JsonTemplateStore(file, BUILTIN_TEMPLATES).list();
    assert.equal(snapshot.storeRevision, 1);
    assert.equal(snapshot.templates.length, 7);
    assert.equal(snapshot.templates[0]?.id, BUILTIN_TEMPLATES[0]?.id);
    assert.equal(snapshot.templates.at(-1)?.id, "my-photo-story");
  });

  it("resolves only published templates when a run asks for the latest version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const store = new JsonTemplateStore(path.join(root, "templates.json"), BUILTIN_TEMPLATES);
    await store.clone("photo-story", "my-photo-story", "我的照片故事", 0);
    assert.equal(await store.getPublished("my-photo-story"), undefined);

    await store.publish("my-photo-story", 1);
    const latest = await store.getPublished("my-photo-story");
    assert.equal(latest?.status, "published");
    assert.equal(latest?.version, 1);
  });

  it("recovers a lock left by a dead writer without weakening live-writer exclusion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const file = path.join(root, "templates.json");
    const store = new JsonTemplateStore(file, BUILTIN_TEMPLATES);

    await writeFile(`${file}.lock`, `${JSON.stringify({ pid: 2_147_483_647 })}\n`, { mode: 0o600 });
    const recovered = await store.clone("photo-story", "recovered-photo-story", "恢复后的照片故事", 0);
    assert.equal(recovered.storeRevision, 1);

    await writeFile(`${file}.lock`, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    await assert.rejects(
      () => store.clone("product-demo", "blocked-live-writer", "不应抢锁", 1),
      /locked by another writer/,
    );
  });
});
