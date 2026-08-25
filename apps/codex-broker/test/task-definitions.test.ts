import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CODEX_BRIDGE_PROTOCOL_VERSION } from "../src/codex-executor.js";
import { BROKER_TASK_KINDS, outputSchemaFor, taskPromptFor } from "../src/task-definitions.js";

describe("broker-owned task definitions", () => {
  it("pins protocol v2 and owns prompts for every allowed task kind", () => {
    assert.equal(CODEX_BRIDGE_PROTOCOL_VERSION, "video-factory/codex-bridge-v2");
    assert.deepEqual(BROKER_TASK_KINDS, ["topic-ideas", "director-plan", "script-draft", "publish-copy"]);

    assert.match(taskPromptFor("topic-ideas").directive, /中文短视频选题总编/);
    assert.match(taskPromptFor("director-plan").directive, /导演不是素材配方/);
    assert.match(taskPromptFor("script-draft").directive, /中文短视频的编剧/);
    assert.match(taskPromptFor("publish-copy", "douyin").directive, /抖音/);

    const neutral = taskPromptFor("publish-copy", "somewhere-else").directive;
    assert.match(neutral, /中性/);
    assert.doesNotMatch(neutral, /抖音/);
  });

  it("owns a strict output schema for every allowed task kind", () => {
    const requiredByKind = new Map([
      ["topic-ideas", ["ideas"]],
      ["director-plan", ["version", "requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]],
      ["script-draft", ["scenes"]],
      ["publish-copy", ["title", "description", "hashtags"]],
    ] as const);

    for (const kind of BROKER_TASK_KINDS) {
      const schema = outputSchemaFor(kind) as { additionalProperties?: boolean; required?: string[] };
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, requiredByKind.get(kind));
    }
  });
});
