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

  it("revises a built-in as the next version under the same template id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const store = new JsonTemplateStore(
      path.join(root, "templates.json"),
      BUILTIN_TEMPLATES,
      () => "2026-09-04T10:00:00.000Z",
    );

    const revised = await store.revise("knowledge-explainer", 0);

    assert.equal(revised.storeRevision, 1);
    assert.equal(revised.template.id, "knowledge-explainer");
    assert.equal(revised.template.version, 3);
    assert.equal(revised.template.status, "draft");

    const catalog = await store.list();
    assert.equal(catalog.templates.filter((template) => template.id === "knowledge-explainer").length, 1);
    assert.equal(catalog.templates.find((template) => template.id === "knowledge-explainer")?.version, 3);
    assert.equal(catalog.publishedTemplates.find((template) => template.id === "knowledge-explainer")?.version, 2);
    assert.equal((await store.get("knowledge-explainer", 2))?.status, "published");
    assert.equal((await store.getPublished("knowledge-explainer"))?.version, 2);

    const saved = await store.saveDraft({ ...revised.template, name: "知识解释新版" }, revised.storeRevision);
    const published = await store.publish(saved.template.id, saved.storeRevision);
    assert.equal(published.template.version, 3);
    assert.equal(published.template.name, "知识解释新版");
  });

  it("keeps a persisted user version ahead of a future same-version built-in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-template-version-collision-"));
    const file = path.join(root, "templates.json");
    const originalStore = new JsonTemplateStore(file, BUILTIN_TEMPLATES, () => "2026-09-04T10:00:00.000Z");
    const revised = await originalStore.revise("knowledge-explainer", 0);
    const futureBuiltIns = BUILTIN_TEMPLATES.map((template) => template.id === "knowledge-explainer"
      ? { ...template, version: revised.template.version, name: "未来内置知识解释" }
      : template);

    const upgradedDraftStore = new JsonTemplateStore(file, futureBuiltIns, () => "2026-09-05T10:00:00.000Z");
    assert.equal((await upgradedDraftStore.get("knowledge-explainer"))?.status, "draft");
    const saved = await upgradedDraftStore.saveDraft({ ...revised.template, name: "用户自定义知识解释" }, revised.storeRevision);
    assert.equal(saved.template.name, "用户自定义知识解释");

    await new JsonTemplateStore(file, BUILTIN_TEMPLATES).publish("knowledge-explainer", saved.storeRevision);
    const upgradedStore = new JsonTemplateStore(file, futureBuiltIns);
    assert.equal((await upgradedStore.list()).templates.find((template) => template.id === "knowledge-explainer")?.name, "用户自定义知识解释");
    assert.equal((await upgradedStore.get("knowledge-explainer", revised.template.version))?.name, "用户自定义知识解释");
    assert.equal((await upgradedStore.getPublished("knowledge-explainer"))?.name, "用户自定义知识解释");
  });

  it("keeps an earlier published custom version readable after publishing its same-id revision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const store = new JsonTemplateStore(path.join(root, "templates.json"), BUILTIN_TEMPLATES);
    const created = await store.create({
      ...structuredClone(BUILTIN_TEMPLATES[0]!),
      id: "city-story",
      version: 1,
      status: "draft",
    }, 0);
    const first = await store.publish(created.template.id, created.storeRevision);
    const revision = await store.revise(first.template.id, first.storeRevision);
    const saved = await store.saveDraft({ ...revision.template, name: "城市故事第二版" }, revision.storeRevision);
    const second = await store.publish(saved.template.id, saved.storeRevision);

    assert.equal(second.template.id, "city-story");
    assert.equal(second.template.version, 2);
    assert.equal((await store.get("city-story", 1))?.name, BUILTIN_TEMPLATES[0]!.name);
    assert.equal((await store.getPublished("city-story"))?.name, "城市故事第二版");
  });

  it("persists a built-in tombstone until that exact template is explicitly restored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const file = path.join(root, "templates.json");
    const store = new JsonTemplateStore(file, BUILTIN_TEMPLATES);

    const deleted = await store.delete("knowledge-explainer", 0);
    assert.equal(deleted.storeRevision, 1);
    const hidden = await new JsonTemplateStore(file, BUILTIN_TEMPLATES).list();
    assert.equal(hidden.templates.some((template) => template.id === "knowledge-explainer"), false);
    assert.deepEqual(hidden.deletedBuiltIns.map((template) => template.id), ["knowledge-explainer"]);
    assert.equal(await store.getPublished("knowledge-explainer"), undefined);

    const restored = await store.restoreBuiltIn("knowledge-explainer", hidden.storeRevision);
    assert.equal(restored.template.id, "knowledge-explainer");
    assert.equal(restored.storeRevision, 2);
    assert.equal((await store.list()).templates.some((template) => template.id === "knowledge-explainer"), true);
  });

  it("deletes a custom template only after an explicit mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const store = new JsonTemplateStore(path.join(root, "templates.json"), BUILTIN_TEMPLATES);
    const created = await store.create({
      ...structuredClone(BUILTIN_TEMPLATES[0]!),
      id: "temporary-format",
      version: 1,
      status: "draft",
    }, 0);

    await store.delete(created.template.id, created.storeRevision);

    assert.equal((await store.list()).templates.some((template) => template.id === "temporary-format"), false);
    assert.equal(await store.get("temporary-format"), undefined);
  });

  it("keeps explicitly QA-only templates out of the production catalog and run resolution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const file = path.join(root, "templates.json");
    const store = new JsonTemplateStore(file, BUILTIN_TEMPLATES);
    const created = await store.create({
      ...structuredClone(BUILTIN_TEMPLATES[0]!),
      id: "qa-template-flow",
      version: 1,
      status: "draft",
      name: "模板流程验收",
    }, 0, "qa");
    await store.publish(created.template.id, created.storeRevision);

    assert.equal((await store.list()).templates.some((template) => template.id === "qa-template-flow"), false);
    assert.equal(await store.getPublished("qa-template-flow"), undefined);
    assert.match(await readFile(file, "utf8"), /qaOnlyTemplateIds/);
  });

  it("migrates the known legacy browser-acceptance templates out of the production catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-templates-"));
    const file = path.join(root, "templates.json");
    await writeFile(file, JSON.stringify({
      revision: 13,
      templates: [{
        ...structuredClone(BUILTIN_TEMPLATES[0]!),
        id: "knowledge-explainer-copy-legacy",
        name: "夜间验收·知识解释模板",
        description: "用于验证模板编辑、保存与发布流程，不调用付费模型。",
      }],
    }));

    const catalog = await new JsonTemplateStore(file, BUILTIN_TEMPLATES).list();

    assert.equal(catalog.templates.some((template) => template.id === "knowledge-explainer-copy-legacy"), false);
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
