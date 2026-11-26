import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import {
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  type JsonValue,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { buildFrameApp } from "../src/server/agent/app.js";
import { openAgentDatabase } from "../src/server/agent/db.js";
import { EventHub } from "../src/server/agent/event-log.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, OFFLINE_QUOTE_CATALOG, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { RENDER_CATALOG_KEY, type QuoteCatalog } from "../src/server/agent/artifact-store.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { ProductionService } from "../src/server/agent/production-service.js";
import { ProductionWorker } from "../src/server/agent/production-worker.js";
import { expandToolIntent } from "../src/server/agent/pi-tools.js";
import type { ToolProductionIntent } from "../src/shared/agent/generated/contracts.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { ArkMediaPort, RealMediaGateway } from "../src/server/agent/ark-media.js";
import { MiniMaxVideoPort } from "../src/server/agent/minimax-video.js";
import { WanVideoPort } from "../src/server/agent/wan-video.js";
import {
  COLAB_EXECUTOR_RELATIVE_PATH,
  ColabLtxVideoPort,
} from "../src/server/agent/colab-ltx-video.js";
import {
  arkVideoCatalog,
  arkVideoModelView,
  initializeArkVideoSettings,
  readArkVideoCurrent,
  resolveArkBinding,
} from "../src/server/agent/ark-video-settings.js";
import {
  additionalMediaCatalog,
  additionalMediaModelViews,
  readAdditionalMediaCurrent,
  resolveColabVideoBinding,
  resolveMinimaxVideoBinding,
  resolveWanVideoBinding,
} from "../src/server/agent/additional-media-settings.js";
import {
  connectedColabVideoChoices,
  connectedMediaEnabled,
  listAvailableProviderModels,
  readProviderConnections,
  saveProviderConnection,
} from "../src/server/agent/provider-connections.js";
import { initializeTextModelSettings } from "../src/server/agent/text-model-settings.js";
import { issueSubmitPermit } from "../src/server/agent/submit-permit.js";
import { finalVideoTarget, seedConfirmedWork } from "./helpers/creative-work-fixture.js";
import type { OperationSpec, ProductionIntent, ProviderUsage } from "../src/shared/agent/generated/contracts.js";

const asJsonArgs = <T>(value: T): Record<string, JsonValue> =>
  JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COLAB_EXECUTOR_PATH = path.join(REPO_ROOT, COLAB_EXECUTOR_RELATIVE_PATH);
const VERIFIED_SAMPLE_MP4 = path.join(
  REPO_ROOT,
  "workspace/ultra-media/outputs/colab-ltx/ltx-dev-sample-720p-01.mp4",
);
const VERIFIED_SAMPLE_SHA256 = "798d2d390c573a4c7c47fd639a00baeb7afa353d387ec63d5f5bdab908490f76";

async function makeFirstFramePng(dest: string, size = "1280x720"): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=navy:s=${size}:d=1`,
    "-frames:v",
    "1",
    dest,
  ]);
}

async function makeSampleFallbackClip(dest: string): Promise<void> {
  if (existsSync(VERIFIED_SAMPLE_MP4)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=teal:s=1280x720:r=24:d=5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=5",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    dest,
  ]);
}

/**
 * Local stateful fake `colab` CLI binary written in Python.
 * Simulates Google Colab backend assignments (including an anonymous `[?]` session and another
 * user's session to prove strict ownership!), isolated `--config` session store, `upload`,
 * `exec`, `download`, `stop`, and `usage` without touching network or spending any CU.
 */
function writeFakeColabCli(dir: string): {
  colabBin: string;
  backendFile: string;
  callsFile: string;
  remoteRoot: string;
} {
  const colabBin = path.join(dir, "fake-colab");
  const backendFile = path.join(dir, "colab-backend.json");
  const callsFile = path.join(dir, "colab-calls.jsonl");
  const remoteRoot = path.join(dir, "remote-vm");
  mkdirSync(remoteRoot, { recursive: true });

  writeFileSync(
    backendFile,
    JSON.stringify(
      {
        usageCu: 18.9,
        nextId: 1,
        newMode: "normal", // "normal" | "timeout_unconfirmed" | "crash_after_store" | "unauthorized"
        assignments: [
          // Pre-existing anonymous `[?]` session belonging to user's manual notebook!
          { endpoint: "gpu-t4-s-orphan-manual", accelerator: "T4", variant: "GPU", shape: "STANDARD" },
          // Pre-existing named session in another config!
          { endpoint: "gpu-l4-s-other-task", accelerator: "L4", variant: "GPU", shape: "STANDARD" },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(callsFile, "");

  const script = `#!/usr/bin/env python3
import json, os, pathlib, shutil, subprocess, sys

BACKEND = pathlib.Path(${JSON.stringify(backendFile)})
CALLS = pathlib.Path(${JSON.stringify(callsFile)})
REMOTE_ROOT = pathlib.Path(${JSON.stringify(remoteRoot)})

argv = sys.argv[1:]
config_path = os.path.expanduser("~/.config/colab-cli/sessions.json")
auth_mode = "oauth2"
rest = []
i = 0
while i < len(argv):
    if argv[i] == "--config":
        config_path = argv[i + 1]
        i += 2
    elif argv[i] == "--auth":
        auth_mode = argv[i + 1]
        i += 2
    else:
        rest.append(argv[i])
        i += 1

cmd = rest[0] if rest else ""
with CALLS.open("a", encoding="utf-8") as cf:
    cf.write(json.dumps({"cmd": cmd, "args": rest, "config": config_path}) + "\\n")

state = json.loads(BACKEND.read_text(encoding="utf-8"))
if state.get("newMode") == "unauthorized":
    sys.stderr.write("[colab] Not authenticated. Run colab auth login.\\n")
    sys.exit(1)

cfg_file = pathlib.Path(config_path)
cfg_file.parent.mkdir(parents=True, exist_ok=True)
store = json.loads(cfg_file.read_text(encoding="utf-8")) if cfg_file.is_file() else {}
# Pre-populate other-task in store only if requested
def save_store():
    cfg_file.write_text(json.dumps(store, indent=2), encoding="utf-8")

def map_remote(rpath: str) -> pathlib.Path:
    rel = rpath.lstrip("/")
    return REMOTE_ROOT / rel

if cmd == "usage":
    print(f"Available balance: {state['usageCu']:.2f} compute units")
    sys.exit(0)

if cmd == "sessions":
    ep_to_name = {v["endpoint"]: k for k, v in store.items() if isinstance(v, dict) and "endpoint" in v}
    if not state["assignments"]:
        print("[colab] No active sessions found on server.")
        sys.exit(0)
    for a in state["assignments"]:
        nm = ep_to_name.get(a["endpoint"], "?")
        print(f"[{nm}] {a['endpoint']} | Hardware: {a['accelerator']} | Shape: {a['shape']} | Variant: {a['variant']}")
    sys.exit(0)

if cmd == "status":
    sname = rest[rest.index("-s") + 1] if "-s" in rest else ""
    s = store.get(sname)
    live_eps = {a["endpoint"] for a in state["assignments"]}
    if not s or s["endpoint"] not in live_eps:
        print(f"[colab] Session '{sname}' not found.")
        sys.exit(0)
    print(f"[{sname}] {s['endpoint']} | Hardware: {s['accelerator']} | Shape: STANDARD | Variant: GPU | Status: IDLE")
    sys.exit(0)

if cmd == "new":
    sname = rest[rest.index("-s") + 1]
    gpu = rest[rest.index("--gpu") + 1].upper() if "--gpu" in rest else "T4"
    mode = state.get("newMode", "normal")
    if mode == "timeout_unconfirmed":
        sys.stderr.write("ReadTimeout while waiting for Colab assignment\\n")
        sys.exit(124)
    idx = int(state["nextId"])
    state["nextId"] = idx + 1
    ep = f"gpu-{gpu.lower()}-s-owned-{idx}"
    state["assignments"].append({"endpoint": ep, "accelerator": gpu, "variant": "GPU", "shape": "STANDARD"})
    state["usageCu"] = round(float(state["usageCu"]) - 0.15, 2)
    BACKEND.write_text(json.dumps(state, indent=2), encoding="utf-8")
    store[sname] = {"name": sname, "endpoint": ep, "accelerator": gpu, "variant": "GPU", "url": "https://localhost", "token": "tok"}
    save_store()
    if mode == "crash_after_store":
        sys.stderr.write("Simulated local crash immediately after store write\\n")
        sys.exit(1)
    print("[colab] Session READY.")
    sys.exit(0)

if cmd == "stop":
    if "--all" in rest:
        sys.stderr.write("FORBIDDEN: --all called!\\n")
        sys.exit(99)
    sname = rest[rest.index("-s") + 1]
    s = store.get(sname)
    if not s:
        sys.stderr.write(f"[colab] Session '{sname}' not found.\\n")
        sys.exit(1)
    for ddir in (REMOTE_ROOT / "content" / "batch_daemons").glob("*"):
        if ddir.is_dir():
            (ddir / "STOP").write_text("1", encoding="utf-8")
    ep = s["endpoint"]
    state["assignments"] = [a for a in state["assignments"] if a["endpoint"] != ep]
    BACKEND.write_text(json.dumps(state, indent=2), encoding="utf-8")
    store.pop(sname, None)
    save_store()
    print("[colab] Session terminated.")
    sys.exit(0)

if cmd == "upload":
    sname = rest[rest.index("-s") + 1]
    src, dst = rest[-2], rest[-1]
    target = map_remote(dst)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_target = target.with_name(target.name + ".uploading")
    shutil.copyfile(src, tmp_target)
    if target.suffix == ".json":
        txt = tmp_target.read_text(encoding="utf-8").replace('"/content/', f'"{REMOTE_ROOT}/content/')
        data = json.loads(txt)
        if isinstance(data, dict):
            data.setdefault("work_root", str(REMOTE_ROOT / "content" / "ltx25-workspace"))
            if state.get("slowInferenceSec"):
                data["mock_infer_sleep_sec"] = float(state["slowInferenceSec"])
            if state.get("mockInferenceMp4"):
                data.setdefault("mock_inference_mp4", state["mockInferenceMp4"])
            txt = json.dumps(data, ensure_ascii=False, indent=2)
        tmp_target.write_text(txt, encoding="utf-8")
    tmp_target.replace(target)
    sys.exit(0)

if cmd == "download":
    sname = rest[rest.index("-s") + 1]
    src, dst = rest[-2], rest[-1]
    source = map_remote(src)
    if not source.is_file():
        sys.stderr.write(f"Remote file not found: {src}\\n")
        sys.exit(1)
    target = pathlib.Path(dst)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    sys.exit(0)

if cmd == "exec":
    sname = rest[rest.index("-s") + 1]
    f_idx = rest.index("-f")
    py_file = pathlib.Path(rest[f_idx + 1])
    code = py_file.read_text(encoding="utf-8")
    # Rewrite /content paths inside executed snippet/config to REMOTE_ROOT/content so real worker runs locally!
    rewritten = code.replace("'/content", f"'{REMOTE_ROOT}/content").replace('"/content', f'"{REMOTE_ROOT}/content')
    for cfg_json in (REMOTE_ROOT / "content").rglob("*.json"):
        try:
            txt = cfg_json.read_text(encoding="utf-8")
            if '"/content/' in txt:
                cfg_json.write_text(txt.replace('"/content/', f'"{REMOTE_ROOT}/content/'), encoding="utf-8")
        except Exception:
            pass
    env = dict(os.environ)
    for j, tok in enumerate(rest):
        if tok == "--env" and j + 1 < len(rest):
            k, v = rest[j + 1].split("=", 1)
            env[k] = v.replace("/content/", f"{REMOTE_ROOT}/content/")
    proc = subprocess.run([sys.executable, "-c", rewritten], env=env, capture_output=True, text=True)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    sys.exit(proc.returncode)

sys.stderr.write(f"Unknown command: {cmd}\\n")
sys.exit(2)
`;
  writeFileSync(colabBin, script, { encoding: "utf8" });
  chmodSync(colabBin, 0o755);
  return { colabBin, backendFile, callsFile, remoteRoot };
}

async function createColabReplayWebFixture(t: TestContext, dir: string, clockIso: string) {
  const fallbackSample = path.join(dir, "fallback-sample.mp4");
  await makeSampleFallbackClip(fallbackSample);
  const sampleMp4 = existsSync(VERIFIED_SAMPLE_MP4) ? VERIFIED_SAMPLE_MP4 : fallbackSample;
  const firstFramePng = path.join(dir, "first-frame.png");
  await makeFirstFramePng(firstFramePng);

  const renderFacts = { available: true, probeAvailable: true, aacAvailable: true, reason: "ok" };
  const clock = () => clockIso;
  const workRoot = path.join(dir, "media-work");

  const runtime = await createAgentRuntime({
    dataDir: dir,
    skillsRoot: defaultSkillsRoot,
    providerConnections: true,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [
      {
        binding: {
          providerId: FAUX_PROVIDER,
          modelId: FAUX_TEXT_MODEL,
          connectionId: "offline-fixture",
          configurationRevisionId: "colab-web-faux-text",
        },
        name: "Faux Text",
        kind: "text",
        features: [],
        availability: "configured",
        verificationNote: "网页回归替身",
        isDefault: true,
      },
    ],
    defaultModelId: FAUX_TEXT_MODEL,
    clock,
    media: {
      pollMs: 30,
      factory: (db, blobs) => {
        initializeArkVideoSettings(db, { clock });
        const arkPort = new ArkMediaPort(db, blobs, clock, { resolve: b => resolveArkBinding(db, b), workRoot });
        const mmPort = new MiniMaxVideoPort(db, blobs, clock, { resolve: b => resolveMinimaxVideoBinding(db, b), workRoot });
        const wanPort = new WanVideoPort(db, blobs, clock, { resolve: b => resolveWanVideoBinding(db, b), workRoot });
        const colabPort = new ColabLtxVideoPort(db, blobs, clock, {
          resolve: b => resolveColabVideoBinding(db, b),
          workRoot,
          executorScriptPath: COLAB_EXECUTOR_PATH,
          stateDir: path.join(dir, "colab-state"),
          replaySampleMp4Path: sampleMp4,
        });
        return {
          port: new RealMediaGateway(new LocalRenderPort(db, blobs, clock, { workRoot }), {
            resolveProviderPort: b => {
              if (resolveColabVideoBinding(db, b)) return colabPort;
              if (resolveMinimaxVideoBinding(db, b)) return mmPort;
              if (resolveWanVideoBinding(db, b)) return wanPort;
              if (resolveArkBinding(db, b)) return arkPort;
              return null;
            },
            clock,
            closeables: [colabPort],
          }),
          catalog: () => ({
            ...arkVideoCatalog(connectedMediaEnabled(db, "video") ? readArkVideoCurrent(db) : null, renderFacts),
            ...additionalMediaCatalog(db, true),
            ...connectedColabVideoChoices(db, true).catalog,
          }),
          models: () => {
            const entries = additionalMediaModelViews(db, true);
            for (const choice of connectedColabVideoChoices(db, true).models) {
              if (!entries.some(e => e.binding.configurationRevisionId === choice.binding.configurationRevisionId)) {
                entries.push(choice);
              }
            }
            const video = readArkVideoCurrent(db);
            if (video && connectedMediaEnabled(db, "video")) entries.unshift(arkVideoModelView(video, renderFacts));
            return entries;
          },
        };
      },
    },
  });
  const app = buildFrameApp({
    logger: false,
    agent: {
      service: runtime.service,
      resolveOwner: () => "local-owner",
      localOwnerOnly: true,
      uiOrigin: "http://127.0.0.1:4318",
    },
  });
  t.after(async () => {
    await app.close();
    await runtime.close();
  });
  const writeHeaders = {
    origin: "http://127.0.0.1:4318",
    "x-video-factory-request": "studio",
    "content-type": "application/json",
  };
  return { runtime, app, sampleMp4, firstFramePng, clock, writeHeaders };
}

describe("Native Colab/LTX-2.5 Video Channel, Ownership, Recovery & Warm Batch Reuse", () => {
  it("COLAB-01 与 Ark/MiniMax/Wan 视频通道共存、目录同步、单当前切换与旧提案自动作废（含 v35 迁移）", async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vf-colab-coexist-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const db = openAgentDatabase(dir);
    t.after(() => db.close());

    const versions = (db.prepare("SELECT MAX(version) AS maxVer FROM agent_schema_migrations").get() as { maxVer: number }).maxVer;
    assert.ok(versions >= 35, "数据库已应用 v35 colab-video 通道约束迁移");

    initializeArkVideoSettings(db, { clock: () => "2026-11-25T16:00:00.000Z" });
    initializeTextModelSettings(db, () => "2026-11-25T16:00:00.000Z");
    db.prepare("INSERT INTO provider_connection_settings(id,revision) VALUES(1,0)").run();

    const clock = () => "2026-11-25T16:05:00.000Z";
    // 1) Save Ark (default), MiniMax, Wan, and Colab video connections simultaneously
    saveProviderConnection(db, clock, "owner", {
      commandId: "save-ark",
      expectedRevision: readProviderConnections(db).revision,
      connection: {
        id: "conn-ark",
        name: "火山方舟",
        protocol: "ark",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "ark-key-1",
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-ark-video",
            kind: "video",
            name: "Seedance 2.5",
            modelId: "doubao-seedance-2-5-260628",
            features: [],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: true,
          },
        ],
      },
    });
    saveProviderConnection(db, clock, "owner", {
      commandId: "save-minimax",
      expectedRevision: readProviderConnections(db).revision,
      connection: {
        id: "conn-minimax",
        name: "MiniMax",
        protocol: "minimax",
        baseUrl: "https://api.minimax.cn",
        apiKey: "mm-key-1",
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-mm-video",
            kind: "video",
            name: "MiniMax H3",
            modelId: "MiniMax-H3",
            features: [],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: false,
          },
        ],
      },
    });
    saveProviderConnection(db, clock, "owner", {
      commandId: "save-wan",
      expectedRevision: readProviderConnections(db).revision,
      connection: {
        id: "conn-wan",
        name: "阿里万相",
        protocol: "wan",
        baseUrl: "https://ws-prod.cn-beijing.maas.aliyuncs.com",
        apiKey: "wan-key-1",
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-wan-video",
            kind: "video",
            name: "万相 3.0",
            modelId: "wan3.0-video",
            features: [],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: false,
          },
        ],
      },
    });
    saveProviderConnection(db, clock, "owner", {
      commandId: "save-colab",
      expectedRevision: readProviderConnections(db).revision,
      connection: {
        id: "conn-colab",
        name: "Google Colab (LTX-2.5)",
        protocol: "colab",
        baseUrl: "https://colab.research.google.com",
        apiKey: "hf_synthetic_read_token_12345",
        credentialConfigured: true,
        enabled: true,
        models: [],
      },
    });

    // Directory sync for Colab returns adapted LTX-2.5 model without hitting external HTTP
    const dirResult = await listAvailableProviderModels(db, "conn-colab", async () => {
      throw new Error("Colab 本地目录不应发外部 HTTP 请求");
    });
    assert.deepEqual(
      dirResult.models.map(m => ({ id: m.id, kinds: m.kinds, status: m.status })),
      [{ id: "Lightricks/LTX-2.5-distilled", kinds: ["video"], status: "listed" }],
    );

    // Switch default video model to Colab -> clears Ark current row, writes colab-video current row
    saveProviderConnection(db, clock, "owner", {
      commandId: "activate-colab",
      expectedRevision: readProviderConnections(db).revision,
      connection: {
        id: "conn-colab",
        name: "Google Colab (LTX-2.5)",
        protocol: "colab",
        baseUrl: "https://colab.research.google.com",
        apiKey: null,
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-colab-ltx25",
            kind: "video",
            name: "LTX-2.5 Distilled (Colab)",
            modelId: "Lightricks/LTX-2.5-distilled",
            features: ["首帧生视频", "Colab CU"],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: true,
          },
        ],
      },
    });

    assert.equal(readArkVideoCurrent(db), null, "切到 Colab 后 Ark 当前行已清理");
    assert.equal(readAdditionalMediaCurrent(db, "minimax-video"), null);
    assert.equal(readAdditionalMediaCurrent(db, "wan-video"), null);
    const colabCurrent = readAdditionalMediaCurrent(db, "colab-video");
    assert.ok(colabCurrent, "Colab 当前行已激活");

    const catalog = additionalMediaCatalog(db, true);
    const colabEntry = catalog["video:Lightricks/LTX-2.5-distilled"];
    assert.ok(colabEntry, "目录暴露 Colab LTX-2.5 视频条目");
    assert.equal(colabEntry.quoteMinor, 0, "人民币 API 报价为 0 分（消耗 Colab CU）");
    assert.match(colabEntry.estimateNote ?? "", /计算单元（CU）/);

    const views = additionalMediaModelViews(db, true);
    assert.equal(views.length, 1);
    assert.equal(views[0]!.binding.providerId, "colab");

    // Switch back to MiniMax -> clears colab-video current row while preserving frozen binding for in-flight runs!
    const frozenColabBinding = colabEntry.binding!;
    saveProviderConnection(db, clock, "owner", {
      commandId: "switch-to-minimax",
      expectedRevision: readProviderConnections(db).revision,
      connection: {
        id: "conn-minimax",
        name: "MiniMax",
        protocol: "minimax",
        baseUrl: "https://api.minimax.cn",
        apiKey: null,
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-mm-video",
            kind: "video",
            name: "MiniMax H3",
            modelId: "MiniMax-H3",
            features: [],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: true,
          },
        ],
      },
    });
    assert.equal(readAdditionalMediaCurrent(db, "colab-video"), null, "切到 MiniMax 后 Colab 当前行清空");
    assert.ok(readAdditionalMediaCurrent(db, "minimax-video"), "MiniMax 成为唯一当前视频模型");
    const resolvedFrozen = resolveColabVideoBinding(db, frozenColabBinding);
    assert.ok(resolvedFrozen, "已受理运行的冻结 Colab 绑定仍可准确解析回原版本");
    assert.equal(resolvedFrozen.apiKey, "hf_synthetic_read_token_12345");
  });

  it("COLAB-02 零额度已验样片走完网页提案→用户批准→Worker→唯一正式产物→Range 播放完整闭环，无重复 uploads", async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vf-colab-e2e-sample-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { runtime, app, sampleMp4, firstFramePng, clock, writeHeaders } = await createColabReplayWebFixture(
      t,
      dir,
      "2026-11-25T16:10:00.000Z",
    );

    // Configure Colab connection via HTTP Settings API
    const initSettings = await app.inject({ method: "GET", url: "/api/agent/v1/settings/model-connections" });
    assert.equal(initSettings.statusCode, 200);
    const saveRes = await app.inject({
      method: "POST",
      url: "/api/agent/v1/settings/model-connections",
      headers: writeHeaders,
      payload: {
        commandId: "http-save-colab",
        expectedRevision: initSettings.json().revision,
        connection: {
          id: "provider-colab",
          name: "Google Colab (LTX-2.5)",
          protocol: "colab",
          baseUrl: "https://colab.research.google.com",
          apiKey: "hf_test_token_001",
          credentialConfigured: true,
          enabled: true,
          models: [
            {
              id: "model-colab-ltx",
              kind: "video",
              name: "LTX-2.5 Distilled (720p)",
              modelId: "Lightricks/LTX-2.5-distilled",
              features: ["首帧生视频", "Colab CU"],
              contextWindowTokens: null,
              maxOutputTokens: null,
              enabled: true,
              isDefault: true,
            },
          ],
        },
      },
    });
    assert.equal(saveRes.statusCode, 200);

    // Create conversation & upload first-frame PNG via real HTTP multipart route
    const convRes = await app.inject({
      method: "POST",
      url: "/api/agent/v1/conversations",
      headers: writeHeaders,
      payload: { commandId: "create-conv-colab", title: "Colab 原生回归" },
    });
    assert.equal(convRes.statusCode, 201);
    const convJson = convRes.json();
    const conv = (convJson.conversation ?? convJson) as { id: string; revision: number };

    const boundary = "----ColabTestBoundary12345";
    const pngBytes = readFileSync(firstFramePng);
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="commandId"\r\n\r\nupload-first-frame\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n${conv.revision}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="rights"\r\n\r\nowned_or_licensed\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="first-frame.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      pngBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const ulRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${conv.id}/uploads`,
      headers: {
        origin: "http://127.0.0.1:4318",
        "x-video-factory-request": "studio",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    });
    assert.equal(ulRes.statusCode, 201);
    const ulBody = ulRes.json() as { attachment: { source: { artifactId: string; revisionId: string } } };
    const revDigest = runtime.database
      .prepare("SELECT digest FROM artifact_revisions WHERE id = ?")
      .pluck()
      .get(ulBody.attachment.source.revisionId) as string;
    const uploadedRev = {
      artifactId: ulBody.attachment.source.artifactId,
      id: ulBody.attachment.source.revisionId,
      digest: revDigest,
    };

    // Seed confirmed work & prepare Colab LTX-2.5 proposal
    const db = runtime.database;
    const work = seedConfirmedWork(db, clock(), { ownerId: "local-owner", conversationId: conv.id }, "Colab 样片成片");
    const bootstrapRes = await app.inject({ method: "GET", url: "/api/agent/v1/bootstrap" });
    const colabModel = (bootstrapRes.json().models as { binding: any }[]).find(
      m => m.binding.providerId === "colab",
    )!;
    assert.ok(colabModel, "Bootstrap 暴露已配置的 Colab LTX-2.5 模型");

    const intent: ProductionIntent = {
      workId: work.workId,
      title: "Colab LTX 原生镜头",
      inputSources: [
        {
          kind: "artifact_revision",
          artifactId: uploadedRev.artifactId,
          revisionId: uploadedRev.id,
          digest: uploadedRev.digest,
        },
      ],
      reviewInputs: [work.reviewInput],
      purpose: "production",
      scope: "Colab 原生单镜头验证",
      operations: [
        {
          operationId: "shot-1",
          outputSlot: "video",
          kind: "video",
          model: colabModel.binding,
          inputs: [
            {
              kind: "artifact_revision",
              artifactId: uploadedRev.artifactId,
              revisionId: uploadedRev.id,
              digest: uploadedRev.digest,
            },
            { kind: "text", text: "镜头缓慢向前推进，柔和自然环境声。" },
          ],
          maxCreateAttempts: 1,
          parameters: {
            durationSeconds: 5,
            aspectRatio: "16:9",
            resolution: "720p",
            audioMode: "native",
            firstFrameSlot: 0,
          },
        },
      ],
      finalOutput: { operationId: "shot-1", outputSlot: "video" },
      outputTarget: finalVideoTarget(),
      maxSpend: { currency: "CNY", amountMinor: 0 },
    };

    // Create proposal via real HTTP endpoint & verify persisted + HTTP proposal contract fields
    const createPropRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${conv.id}/proposals`,
      headers: writeHeaders,
      payload: { commandId: "prepare-colab-1", spec: intent },
    });
    assert.equal(createPropRes.statusCode, 201);
    const createdProposal = createPropRes.json();
    assert.equal(createdProposal.state, "ready");
    assert.equal(createdProposal.acceptanceBlocker, null);
    assert.deepEqual(createdProposal.spec.maxSpend, { currency: "CNY", amountMinor: 0 });
    assert.deepEqual(createdProposal.spec.operations[0].quotePerAttempt, { currency: "CNY", amountMinor: 0 });
    assert.equal(createdProposal.spec.operations[0].priceKind, "estimate");
    assert.match(createdProposal.priceDisclosure, /计算单元（CU）/);

    const readPropRes = await app.inject({
      method: "GET",
      url: `/api/agent/v1/proposals/${createdProposal.id}`,
    });
    assert.equal(readPropRes.statusCode, 200);
    assert.deepEqual(readPropRes.json().spec.maxSpend, { currency: "CNY", amountMinor: 0 });

    const persistedPropRow = db
      .prepare("SELECT state, spec_json, price_disclosure FROM proposals WHERE id = ?")
      .get(createdProposal.id) as { state: string; spec_json: string; price_disclosure: string };
    const persistedPropSpec = JSON.parse(persistedPropRow.spec_json);
    assert.equal(persistedPropRow.state, "ready");
    assert.deepEqual(persistedPropSpec.maxSpend, { currency: "CNY", amountMinor: 0 });
    assert.deepEqual(persistedPropSpec.operations[0].quotePerAttempt, { currency: "CNY", amountMinor: 0 });
    assert.match(persistedPropRow.price_disclosure, /计算单元（CU）/);

    // User approves proposal via HTTP endpoint
    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${createdProposal.id}/acceptances`,
      headers: writeHeaders,
      payload: { commandId: "accept-colab-1", proposalDigest: createdProposal.digest },
    });
    assert.equal(acceptRes.statusCode, 202);
    const runId = acceptRes.json().run.id as string;

    // Wait for ProductionWorker to settle run
    let finalRun: any = null;
    for (let i = 0; i < 80; i++) {
      const runsRes = await app.inject({
        method: "GET",
        url: `/api/agent/v1/conversations/${conv.id}/runs`,
      });
      const body = runsRes.json();
      const runs = (body.items ?? body.runs ?? []) as any[];
      const current = runs.find(r => r.id === runId);
      if (current && (current.state === "succeeded" || current.state === "failed")) {
        finalRun = current;
        break;
      }
      await new Promise(r => setTimeout(r, 40));
    }

    assert.ok(finalRun, "Worker 已收敛 Colab 运行");
    assert.equal(finalRun.state, "succeeded");
    assert.deepEqual(finalRun.finance, {
      state: "settled",
      currency: "CNY",
      reservedMinor: 0,
      pendingUnknownMinor: 0,
      settledMinor: 0,
      priceKind: "estimate",
    });
    assert.equal(finalRun.outputRevisions.length, 1, "只产生唯一正式产物修订，无额外手工 upload 副本");

    // Verify no extra `user_upload` video revisions were created (only the initial PNG upload + 1 `production_output`)
    const revRows = db
      .prepare(
        `SELECT r.id, r.origin_kind, r.content_json, b.digest AS blob_digest
         FROM artifact_revisions r
         JOIN artifacts a ON a.id = r.artifact_id
         LEFT JOIN production_blobs b ON b.id = json_extract(r.content_json, '$.blobId')
         WHERE a.conversation_id = ? AND a.kind = 'video'`,
      )
      .all(conv.id) as { id: string; origin_kind: string; content_json: string; blob_digest: string }[];
    assert.equal(revRows.length, 1);
    assert.equal(revRows[0]!.origin_kind, "production_output");
    if (sampleMp4 === VERIFIED_SAMPLE_MP4) {
      assert.equal(revRows[0]!.blob_digest, VERIFIED_SAMPLE_SHA256);
    }

    // Verify ProviderUsage records explicit sample_replay metadata with 0 external CU
    const attemptRow = db
      .prepare("SELECT usage_json, billing_json, billing_final FROM production_attempts WHERE run_id = ?")
      .get(runId) as { usage_json: string; billing_json: string | null; billing_final: number };
    assert.equal(attemptRow.billing_final, 1, "仅测试注入样片回放从未触达外部服务，允许 0 元结清");
    const usage = JSON.parse(attemptRow.usage_json) as ProviderUsage;
    assert.equal(usage.externalUnit, "colab_cu");
    assert.equal(usage.cacheSource, "sample_replay");
    assert.equal(usage.estimatedExternalAmount, 0);
    assert.equal(usage.observedBalanceDelta, undefined);
    assert.equal(usage.width, 1280);
    assert.equal(usage.height, 720);
    assert.ok(usage.stageTimingsMs);

    // Verify artifact revision HTTP endpoint & HTTP byte-range playback for web <video> player
    const mediaContent = JSON.parse(revRows[0]!.content_json) as { blobId: string };
    const outRef = finalRun.outputRevisions[0] as { artifactId: string; revisionId: string };
    assert.equal(outRef.revisionId, revRows[0]!.id);
    const artRevRes = await app.inject({
      method: "GET",
      url: `/api/agent/v1/artifacts/${outRef.artifactId}/revisions/${outRef.revisionId}`,
    });
    assert.equal(artRevRes.statusCode, 200);
    const artRevJson = artRevRes.json();
    assert.equal(artRevJson.revisionId, outRef.revisionId);
    assert.equal(artRevJson.runId, runId);
    assert.equal(artRevJson.content.blobId, mediaContent.blobId);
    assert.equal(artRevJson.content.mimeType, "video/mp4");
    const playRes = await app.inject({
      method: "GET",
      url: `/api/agent/v1/blobs/${mediaContent.blobId}/content`,
      headers: { range: "bytes=0-63" },
    });
    assert.equal(playRes.statusCode, 206);
    assert.equal(playRes.headers["accept-ranges"], "bytes");
    assert.match(String(playRes.headers["content-range"] ?? ""), /^bytes 0-63\/\d+$/);
    assert.equal(playRes.headers["content-type"], "video/mp4");
    assert.equal(playRes.rawPayload.length, 64);
    assert.equal(playRes.rawPayload.subarray(4, 8).toString("ascii"), "ftyp");
  });

  it("COLAB-03 真实运行配置在缺依赖或未授权时返回真实 0 元拒绝状态，绝不静默回退样片", async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vf-colab-real-auth-fail-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fake = writeFakeColabCli(dir);
    // Flip fake colab into unauthorized state
    const backend = JSON.parse(readFileSync(fake.backendFile, "utf8"));
    backend.newMode = "unauthorized";
    writeFileSync(fake.backendFile, JSON.stringify(backend));

    const firstFramePng = path.join(dir, "frame.png");
    await makeFirstFramePng(firstFramePng);

    const db = openAgentDatabase(dir);
    t.after(() => db.close());
    const clock = () => "2026-11-25T16:15:00.000Z";
    const blobs = new ProductionBlobs(db, dir, clock);
    initializeArkVideoSettings(db, { clock });
    initializeTextModelSettings(db, clock);
    db.prepare("INSERT INTO provider_connection_settings(id,revision) VALUES(1,0)").run();

    saveProviderConnection(db, clock, "owner", {
      commandId: "cfg-colab-real",
      expectedRevision: 0,
      connection: {
        id: "c-colab",
        name: "Colab",
        protocol: "colab",
        baseUrl: "https://colab.research.google.com",
        apiKey: "hf_real_looking_secret_99999",
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-ltx",
            kind: "video",
            name: "LTX-2.5",
            modelId: "Lightricks/LTX-2.5-distilled",
            features: [],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: true,
          },
        ],
      },
    });

    const catalog = additionalMediaCatalog(db, true);
    const binding = catalog["video:Lightricks/LTX-2.5-distilled"]!.binding!;

    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('conv','owner','t',1,'pi',?,?)",
    ).run(clock(), clock());
    const frameBlob = await blobs.persistFromFileAsync("owner", "conv", firstFramePng, "image/png", null);

    const op: OperationSpec = {
      operationId: "op1",
      outputSlot: "video",
      kind: "video",
      model: binding,
      inputs: [
        { kind: "blob", blobId: frameBlob.id, digest: frameBlob.digest },
        { kind: "text", text: "A calm ocean wave." },
      ],
      maxCreateAttempts: 1,
      quotePerAttempt: { currency: "CNY", amountMinor: 0 },
      priceKind: "estimate",
      parameters: {
        durationSeconds: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        audioMode: "native",
        firstFrameSlot: 0,
      },
    };

    db.prepare("INSERT INTO works(id,owner_id,conversation_id) VALUES('w','owner','conv')").run();
    db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES('snap','{}','d',?)").run(clock());
    db.prepare(
      "INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,created_seq,created_at,updated_at) VALUES('p','conv','owner','d','{}','ready','x',?,1,?,?)",
    ).run(clock(), clock(), clock());
    db.prepare(
      "INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,title,state,created_seq,created_at,updated_at) VALUES('run','owner','conv','w','snap','p','t','running',1,?,?)",
    ).run(clock(), clock());
    db.prepare("INSERT INTO production_operations(run_id,id,spec_json,state) VALUES('run','op1',?,'running')").run(
      JSON.stringify(op),
    );
    db.prepare(
      "INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES('att-auth','run','op1',1,'req-auth','submit_started','unknown',0)",
    ).run();

    const port = new ColabLtxVideoPort(db, blobs, clock, {
      resolve: b => resolveColabVideoBinding(db, b),
      workRoot: path.join(dir, "work"),
      executorScriptPath: COLAB_EXECUTOR_PATH,
      stateDir: path.join(dir, "state"),
      colabBin: fake.colabBin,
    });

    const obs = await port.submit(
      {
        runId: "run",
        snapshotId: "snap",
        operationId: "op1",
        attemptId: "att-auth",
        requestIdentity: "req-auth",
        operation: op,
        resolvedInputs: [{ slot: 0, blobId: frameBlob.id, digest: frameBlob.digest }],
      },
      issueSubmitPermit("att-auth", 1),
    );

    assert.equal(obs.state, "failed");
    assert.equal(obs.providerTaskId, null);
    assert.equal(obs.usage, undefined, "未提交拒绝无远端 GPU/CU 消耗");
    assert.equal(obs.billing?.kind, "authoritative");
    assert.equal(obs.billing?.billingFactId, "zero-att-auth");
    assert.equal(obs.billing?.netAmount.amountMinor, 0);
    assert.equal(obs.billing?.final, true);
    assert.match(obs.message ?? "", /未授权|Not authenticated/);
    assert.ok(!(obs.message ?? "").includes("hf_real_looking_secret_99999"), "绝不泄露 HF Token");

    // Pre-allocation cancel (never allocated in Colab ledger) also settles with authoritative CNY 0
    const preCancelObs = await port.cancel({
      kind: "provider",
      runId: "run",
      operationId: "op1",
      attemptId: "att-never-allocated",
      requestIdentity: "req-never-allocated",
      providerTaskId: null,
      accountBinding: binding,
    });
    assert.equal(preCancelObs.state, "cancelled");
    assert.equal(preCancelObs.billing?.kind, "authoritative");
    assert.equal(preCancelObs.billing?.billingFactId, "zero-att-never-allocated");
    assert.equal(preCancelObs.billing?.netAmount.amountMinor, 0);
    assert.equal(preCancelObs.usage, undefined);
  });

  it("COLAB-04 严格实例归属与全中断窗口恢复：不接管/不停掉 [?] 匿名实例，submit_started 无 taskId 取消只停本单 GPU，下载后崩溃可恢复", async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vf-colab-ownership-crash-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fake = writeFakeColabCli(dir);
    const sampleFallback = path.join(dir, "clip.mp4");
    await makeSampleFallbackClip(sampleFallback);
    const clipMp4 = existsSync(VERIFIED_SAMPLE_MP4) ? VERIFIED_SAMPLE_MP4 : sampleFallback;
    const firstFramePng = path.join(dir, "frame.png");
    await makeFirstFramePng(firstFramePng);

    const db = openAgentDatabase(dir);
    t.after(() => db.close());
    let nowIso = "2026-11-25T16:20:00.000Z";
    const clock = () => nowIso;
    const hub = new EventHub();
    t.after(() => hub.close());
    const blobs = new ProductionBlobs(db, dir, clock);
    const workRoot = path.join(dir, "work");
    const stateDir = path.join(dir, "state");

    initializeArkVideoSettings(db, { clock });
    initializeTextModelSettings(db, clock);
    db.prepare("INSERT INTO provider_connection_settings(id,revision) VALUES(1,0)").run();
    saveProviderConnection(db, clock, "owner", {
      commandId: "cfg-colab",
      expectedRevision: 0,
      connection: {
        id: "c-colab",
        name: "Colab",
        protocol: "colab",
        baseUrl: "https://colab.research.google.com",
        apiKey: "hf_token_ownership",
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-ltx",
            kind: "video",
            name: "LTX-2.5",
            modelId: "Lightricks/LTX-2.5-distilled",
            features: [],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: true,
          },
        ],
      },
    });
    const catalog = () => additionalMediaCatalog(db, true);
    const binding = catalog()["video:Lightricks/LTX-2.5-distilled"]!.binding!;

    const colabPort = new ColabLtxVideoPort(db, blobs, clock, {
      resolve: b => resolveColabVideoBinding(db, b),
      workRoot,
      executorScriptPath: COLAB_EXECUTOR_PATH,
      stateDir,
      colabBin: fake.colabBin,
      mockRemoteMp4Path: clipMp4,
    });
    const gateway = new RealMediaGateway(new LocalRenderPort(db, blobs, clock, { workRoot }), {
      resolveProviderPort: b => (resolveColabVideoBinding(db, b) ? colabPort : null),
      clock,
    });
    const service = new ProductionService(db, clock, hub, catalog, blobs);

    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('conv','owner','归属验证',1,'pi',?,?)",
    ).run(clock(), clock());
    const frameBlob = await blobs.persistFromFileAsync("owner", "conv", firstFramePng, "image/png", null);
    db.prepare(
      "INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES('art-frame','conv','owner','首帧','image','rev-frame',1,1,?,?)",
    ).run(clock(), clock());
    db.prepare(
      "INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,origin_kind,created_at) VALUES('rev-frame','art-frame',1,?,?, 'user_upload', ?)",
    ).run(frameBlob.digest, JSON.stringify({ format: "media", blobId: frameBlob.id, mimeType: "image/png", durationMs: null }), clock());
    db.prepare("INSERT INTO revision_blob_links(revision_id,blob_id) VALUES('rev-frame',?)").run(frameBlob.id);
    const work = seedConfirmedWork(db, clock(), { ownerId: "owner", conversationId: "conv" }, "归属验证");

    const makeProposal = async (cmdId: string, title: string) => {
      // Seed request/message pair for applyPrepareProposal via ProductionService/runtime pattern
      const { applyPrepareProposal, rowToProposal } = await import("../src/server/agent/artifact-store.js");
      const { emptyReferences, insertMessage, insertQueuedRequest, nextQueueSeq, nextSeq } = await import(
        "../src/server/agent/conversation-store.js"
      );
      const reqId = `req-${cmdId}`;
      const msgId = `msg-${cmdId}`;
      insertMessage(db, clock(), {
        id: msgId,
        conversationId: "conv",
        ownerId: "owner",
        requestId: reqId,
        role: "system_notice",
        kind: "notice",
        state: "completed",
        text: title,
        target: null,
        createdSeq: nextSeq(db, "messages", "conv"),
        references: emptyReferences(),
      });
      insertQueuedRequest(db, clock(), {
        id: reqId,
        conversationId: "conv",
        ownerId: "owner",
        commandId: reqId,
        text: "",
        target: null,
        skillId: null,
        modelId: null,
        queueSeq: nextQueueSeq(db, "conv"),
        messageId: msgId,
      });
      db.prepare("UPDATE requests SET state='completed', delivery_closed=1 WHERE id=?").run(reqId);
      const res = applyPrepareProposal(
        db,
        clock(),
        { ownerId: "owner", conversationId: "conv" },
        {
          workId: work.workId,
          title,
          inputSources: [],
          reviewInputs: [work.reviewInput],
          purpose: "production",
          scope: title,
          operations: [
            {
              operationId: `shot-${cmdId}`,
              outputSlot: "video",
              kind: "video",
              model: binding,
              inputs: [
                { kind: "blob", blobId: frameBlob.id, digest: frameBlob.digest },
                { kind: "text", text: "Camera pans right." },
              ],
              maxCreateAttempts: 1,
              parameters: {
                durationSeconds: 5,
                aspectRatio: "16:9",
                resolution: "720p",
                audioMode: "native",
                firstFrameSlot: 0,
              },
            },
          ],
          finalOutput: { operationId: `shot-${cmdId}`, outputSlot: "video" },
          outputTarget: finalVideoTarget(),
          maxSpend: { currency: "CNY", amountMinor: 0 },
        },
        catalog(),
        { requestId: reqId, messageId: msgId },
      );
      return rowToProposal(res.proposal, db);
    };

    // --- Case A: Timeout during `colab new` BEFORE store confirmation ---
    // Even though `[?] gpu-t4-s-orphan-manual` exists on the account, executor MUST NOT adopt or stop it,
    // and MUST NOT call `colab new` a second time on poll/cancel!
    const setBackendMode = (mode: string, slowInferenceSec?: number) => {
      const st = JSON.parse(readFileSync(fake.backendFile, "utf8"));
      st.newMode = mode;
      if (slowInferenceSec !== undefined) st.slowInferenceSec = slowInferenceSec;
      writeFileSync(fake.backendFile, JSON.stringify(st, null, 2));
    };
    setBackendMode("timeout_unconfirmed");

    const pA = await makeProposal("caseA", "中断未确认分配");
    const runA = service.accept("owner", pA.id, { commandId: "acc-A", proposalDigest: pA.digest }).run;
    const worker = new ProductionWorker(db, clock, hub, blobs, gateway, { leaseMs: 1000 });
    t.after(() => worker.close());

    await worker.pollOnce(); // submits -> timeout_unconfirmed -> unknown
    nowIso = "2026-11-25T16:20:05.000Z";
    await worker.pollOnce(); // duplicate query -> stays unknown without calling `colab new` again!

    const callsAfterA = readFileSync(fake.callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const newCallsA = callsAfterA.filter(c => c.cmd === "new");
    assert.equal(newCallsA.length, 1, "未确认分配绝不二次调用 colab new");
    assert.equal(callsAfterA.filter(c => c.cmd === "stop").length, 0, "未确认分配绝不误停任何会话");

    // Cancel runA -> converges cleanly to cancelled (CANCEL_UNSUPPORTED) without touching `[?]`!
    service.cancel("owner", runA.id, {
      commandId: "cancel-A",
      expectedRevision: service.get("owner", runA.id).revision,
    });
    nowIso = "2026-11-25T16:20:10.000Z";
    await worker.pollOnce();
    const afterCancelA = service.get("owner", runA.id);
    assert.equal(afterCancelA.state, "cancelled");
    assert.equal(afterCancelA.issue?.code, "CANCEL_UNSUPPORTED");
    assert.equal(afterCancelA.finance?.state, "pending_reconciliation", "未确认分配保持待对账，不伪造 0 元结清");
    const rowA = db
      .prepare("SELECT billing_json, billing_final, usage_json FROM production_attempts WHERE run_id=?")
      .get(runA.id) as { billing_json: string | null; billing_final: number; usage_json: string | null };
    assert.equal(rowA.billing_json, null);
    assert.equal(rowA.billing_final, 0);
    assert.equal(rowA.usage_json, null, "分配未确认时不编造 CU 用量");

    const backendAfterA = JSON.parse(readFileSync(fake.backendFile, "utf8"));
    assert.equal(backendAfterA.assignments.length, 2, "账号上原有的 [?] 与他单实例分毫无损");

    // --- Case B: Crash AFTER `colab-sessions.json` recorded owned endpoint, then user cancels ---
    setBackendMode("crash_after_store", 30.0);
    const pB = await makeProposal("caseB", "分配落盘后返回前崩溃并取消");
    const runB = service.accept("owner", pB.id, { commandId: "acc-B", proposalDigest: pB.digest }).run;
    nowIso = "2026-11-25T16:20:20.000Z";
    await worker.pollOnce(); // Reconciles `gpu-t4-s-owned-1` from isolated `colab-sessions.json` without 2nd `colab new`!
    service.cancel("owner", runB.id, {
      commandId: "cancel-B",
      expectedRevision: service.get("owner", runB.id).revision,
    });
    nowIso = "2026-11-25T16:20:25.000Z";
    await worker.pollOnce(); // Cancels & releases ONLY `gpu-t4-s-owned-1`!
    const afterB = service.get("owner", runB.id);
    assert.equal(afterB.state, "cancelled");
    assert.equal(afterB.finance?.state, "pending_reconciliation", "真实已分配 GPU 取消后保持待对账，绝不写 CNY 0 权威结清");
    const rowB = db
      .prepare("SELECT id, billing_json, billing_final, usage_json FROM production_attempts WHERE run_id=?")
      .get(runB.id) as { id: string; billing_json: string | null; billing_final: number; usage_json: string | null };
    assert.equal(rowB.billing_json, null);
    assert.equal(rowB.billing_final, 0);
    const usageB = JSON.parse(rowB.usage_json!) as ProviderUsage;
    assert.equal(usageB.externalUnit, "colab_cu");
    assert.equal(usageB.providerReceiptId, "gpu-t4-s-owned-1");
    assert.equal(usageB.observedBalanceDelta, 0.15, "记录释放后观测到的真实账户余额差值");
    assert.equal(usageB.estimatedExternalAmount, undefined, "远端阶段未完成时不虚报 0 CU 估算值");

    // Verify `gpu-t4-s-owned-1` was reconciled from isolated `colab-sessions.json` and immediately released,
    // while `[?] gpu-t4-s-orphan-manual` and `gpu-l4-s-other-task` remain untouched!
    const backendAfterB = JSON.parse(readFileSync(fake.backendFile, "utf8"));
    assert.deepEqual(
      backendAfterB.assignments.map((a: any) => a.endpoint),
      ["gpu-t4-s-orphan-manual", "gpu-l4-s-other-task"],
      "仅释放本单已确认归属的 GPU，不碰匿名 [?] 或其他任务 GPU",
    );

    // Also test explicit `submit_started` + `provider_task_id IS NULL` + user cancel when session IS active:
    const stSlow = JSON.parse(readFileSync(fake.backendFile, "utf8"));
    stSlow.newMode = "normal";
    stSlow.slowInferenceSec = 30.0;
    writeFileSync(fake.backendFile, JSON.stringify(stSlow, null, 2));
    const pC = await makeProposal("caseC", "正常提交后抹去Frame侧taskId再取消");
    const runC = service.accept("owner", pC.id, { commandId: "acc-C", proposalDigest: pC.digest }).run;
    nowIso = "2026-11-25T16:20:30.000Z";
    await worker.pollOnce(); // submits & launches slow job on `gpu-t4-s-owned-2`
    // Simulate Frame crash before `provider_task_id` was saved to `production_attempts`!
    db.prepare(
      "UPDATE production_attempts SET phase='submit_started', state='unknown', provider_task_id=NULL WHERE run_id=?",
    ).run(runC.id);
    db.prepare("DELETE FROM production_attempt_outputs WHERE attempt_id IN (SELECT id FROM production_attempts WHERE run_id=?)").run(
      runC.id,
    );
    const attC = (db.prepare("SELECT id FROM production_attempts WHERE run_id=?").get(runC.id) as { id: string }).id;

    service.cancel("owner", runC.id, {
      commandId: "cancel-C",
      expectedRevision: service.get("owner", runC.id).revision,
    });
    nowIso = "2026-11-25T16:20:35.000Z";
    await worker.pollOnce();
    // Duplicate cancel call on port is also idempotent and preserves non-zero-settled billing semantics
    const dupCancel = await colabPort.cancel({
      kind: "provider",
      runId: runC.id,
      operationId: `shot-caseC`,
      attemptId: attC,
      requestIdentity: attC,
      providerTaskId: null,
      accountBinding: binding,
    });
    assert.equal(dupCancel.state, "cancelled");
    assert.equal(dupCancel.billing, null, "已分配 GPU 后取消不得签发 CNY 0 权威结清");
    const finalC = service.get("owner", runC.id);
    assert.equal(finalC.state, "cancelled");
    assert.equal(finalC.issue, null, "凭本地 attemptId 账本成功停掉本单 GPU 并干净收敛为 cancelled");
    assert.equal(finalC.finance?.state, "pending_reconciliation");
    const rowC = db
      .prepare("SELECT billing_json, billing_final, usage_json FROM production_attempts WHERE id=?")
      .get(attC) as { billing_json: string | null; billing_final: number; usage_json: string | null };
    assert.equal(rowC.billing_json, null);
    assert.equal(rowC.billing_final, 0);
    const usageC = JSON.parse(rowC.usage_json!) as ProviderUsage;
    assert.equal(usageC.externalUnit, "colab_cu");
    assert.equal(usageC.providerReceiptId, "gpu-t4-s-owned-2");
    assert.equal(usageC.observedBalanceDelta, 0.15);
    assert.equal(usageC.estimatedExternalAmount, undefined);

    const backendAfterC = JSON.parse(readFileSync(fake.backendFile, "utf8"));
    assert.deepEqual(
      backendAfterC.assignments.map((a: any) => a.endpoint),
      ["gpu-t4-s-orphan-manual", "gpu-l4-s-other-task"],
      "取消仅释放本单归属实例 gpu-t4-s-owned-2",
    );

    // --- Case D: Crash AFTER `download.mp4` is on disk BEFORE DB publish -> settles without calling `colab` CLI ---
    const pD = await makeProposal("caseD", "下载落盘后入库前中断恢复");
    const runD = service.accept("owner", pD.id, { commandId: "acc-D", proposalDigest: pD.digest }).run;
    nowIso = "2026-11-25T16:20:40.000Z";
    // Prepare attempt in `observed/running` and pre-place verified `download.mp4` as if crash happened right before DB commit
    db.prepare(
      "INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES('att-dl-crash',?,'shot-caseD',1,'req-dl-crash','observed','running',0)",
    ).run(runD.id);
    db.prepare("UPDATE production_operations SET state='running' WHERE run_id=? AND id='shot-caseD'").run(runD.id);
    const dlDir = path.join(workRoot, "att-dl-crash");
    mkdirSync(dlDir, { recursive: true });
    writeFileSync(path.join(dlDir, "download.mp4"), readFileSync(clipMp4));
    const callCountBeforeD = readFileSync(fake.callsFile, "utf8").trim().split("\n").filter(Boolean).length;

    nowIso = "2026-11-25T16:20:45.000Z";
    await worker.pollOnce();
    const finalD = service.get("owner", runD.id);
    assert.equal(finalD.state, "succeeded");
    assert.equal(finalD.finance?.state, "pending_reconciliation", "真实下载恢复保持待对账，不写 CNY 0 权威结清");
    assert.equal(finalD.outputRevisions.length, 1);
    const callCountAfterD = readFileSync(fake.callsFile, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(callCountAfterD, callCountBeforeD, "已落盘 download.mp4 直接完成入库，零外部 colab 调用");
  });

  it("COLAB-05 同批多镜头（同一 runId 两镜头 + 本地拼接）热复用同一 GPU 与内存模型，单次分配、单次释放", async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vf-colab-warm-batch-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fake = writeFakeColabCli(dir);
    const sampleFallback = path.join(dir, "clip.mp4");
    await makeSampleFallbackClip(sampleFallback);
    const clipMp4 = existsSync(VERIFIED_SAMPLE_MP4) ? VERIFIED_SAMPLE_MP4 : sampleFallback;
    const firstFramePng = path.join(dir, "frame.png");
    await makeFirstFramePng(firstFramePng);

    const db = openAgentDatabase(dir);
    t.after(() => db.close());
    let currentMs = Date.parse("2026-11-25T16:30:00.000Z");
    const clock = () => new Date(currentMs).toISOString();
    const hub = new EventHub();
    t.after(() => hub.close());
    const blobs = new ProductionBlobs(db, dir, clock);
    const workRoot = path.join(dir, "work");
    const stateDir = path.join(dir, "state");

    initializeArkVideoSettings(db, { clock });
    initializeTextModelSettings(db, clock);
    db.prepare("INSERT INTO provider_connection_settings(id,revision) VALUES(1,0)").run();
    saveProviderConnection(db, clock, "owner", {
      commandId: "cfg-colab-batch",
      expectedRevision: 0,
      connection: {
        id: "c-colab",
        name: "Colab",
        protocol: "colab",
        baseUrl: "https://colab.research.google.com",
        apiKey: "hf_token_batch",
        credentialConfigured: true,
        enabled: true,
        models: [
          {
            id: "m-ltx",
            kind: "video",
            name: "LTX-2.5",
            modelId: "Lightricks/LTX-2.5-distilled",
            features: [],
            contextWindowTokens: null,
            maxOutputTokens: null,
            enabled: true,
            isDefault: true,
          },
        ],
      },
    });

    const catalog = (): QuoteCatalog => ({
      ...additionalMediaCatalog(db, true),
      [RENDER_CATALOG_KEY]: OFFLINE_QUOTE_CATALOG[RENDER_CATALOG_KEY]!,
    });
    const binding = catalog()["video:Lightricks/LTX-2.5-distilled"]!.binding!;

    const colabPort = new ColabLtxVideoPort(db, blobs, clock, {
      resolve: b => resolveColabVideoBinding(db, b),
      workRoot,
      executorScriptPath: COLAB_EXECUTOR_PATH,
      stateDir,
      colabBin: fake.colabBin,
      mockRemoteMp4Path: clipMp4,
    });
    const gateway = new RealMediaGateway(new LocalRenderPort(db, blobs, clock, { workRoot }), {
      resolveProviderPort: b => (resolveColabVideoBinding(db, b) ? colabPort : null),
      clock,
    });
    const service = new ProductionService(db, clock, hub, catalog, blobs);
    const worker = new ProductionWorker(db, clock, hub, blobs, gateway, { leaseMs: 1000 });
    t.after(async () => {
      await worker.close();
      await gateway.close();
    });

    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('conv','owner','多镜热复用',1,'pi',?,?)",
    ).run(clock(), clock());
    const frameBlob = await blobs.persistFromFileAsync("owner", "conv", firstFramePng, "image/png", null);
    db.prepare(
      "INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES('art-frame','conv','owner','首帧','image','rev-frame',1,1,?,?)",
    ).run(clock(), clock());
    db.prepare(
      "INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,origin_kind,created_at) VALUES('rev-frame','art-frame',1,?,?, 'user_upload', ?)",
    ).run(frameBlob.digest, JSON.stringify({ format: "media", blobId: frameBlob.id, mimeType: "image/png", durationMs: null }), clock());
    db.prepare("INSERT INTO revision_blob_links(revision_id,blob_id) VALUES('rev-frame',?)").run(frameBlob.id);
    const work = seedConfirmedWork(db, clock(), { ownerId: "owner", conversationId: "conv" }, "双镜热复用");

    const { applyPrepareProposal, rowToProposal } = await import("../src/server/agent/artifact-store.js");
    const { emptyReferences, insertMessage, insertQueuedRequest, nextQueueSeq, nextSeq } = await import(
      "../src/server/agent/conversation-store.js"
    );
    insertMessage(db, clock(), {
      id: "msg-b",
      conversationId: "conv",
      ownerId: "owner",
      requestId: "req-b",
      role: "system_notice",
      kind: "notice",
      state: "completed",
      text: "准备双镜热复用",
      target: null,
      createdSeq: nextSeq(db, "messages", "conv"),
      references: emptyReferences(),
    });
    insertQueuedRequest(db, clock(), {
      id: "req-b",
      conversationId: "conv",
      ownerId: "owner",
      commandId: "req-b",
      text: "",
      target: null,
      skillId: null,
      modelId: null,
      queueSeq: nextQueueSeq(db, "conv"),
      messageId: "msg-b",
    });
    db.prepare("UPDATE requests SET state='completed', delivery_closed=1 WHERE id='req-b'").run();

    const prep = applyPrepareProposal(
      db,
      clock(),
      { ownerId: "owner", conversationId: "conv" },
      {
        workId: work.workId,
        title: "双镜头热复用成片",
        inputSources: [],
        reviewInputs: [work.reviewInput],
        purpose: "production",
        scope: "两镜头热复用并拼接",
        operations: [
          {
            operationId: "shot-1",
            outputSlot: "clip1",
            kind: "video",
            model: binding,
            inputs: [
              { kind: "blob", blobId: frameBlob.id, digest: frameBlob.digest },
              { kind: "text", text: "Shot 1: morning mist over mountains." },
            ],
            maxCreateAttempts: 1,
            parameters: {
              durationSeconds: 5,
              aspectRatio: "16:9",
              resolution: "720p",
              audioMode: "native",
              firstFrameSlot: 0,
            },
          },
          {
            operationId: "shot-2",
            outputSlot: "clip2",
            kind: "video",
            model: binding,
            inputs: [
              { kind: "blob", blobId: frameBlob.id, digest: frameBlob.digest },
              { kind: "text", text: "Shot 2: sunlight breaking through clouds." },
            ],
            maxCreateAttempts: 1,
            parameters: {
              durationSeconds: 5,
              aspectRatio: "16:9",
              resolution: "720p",
              audioMode: "native",
              firstFrameSlot: 0,
            },
          },
          {
            operationId: "concat-final",
            outputSlot: "final",
            kind: "render",
            model: null,
            inputs: [
              { kind: "operation_output", producerOperationId: "shot-1", outputSlot: "clip1" },
              { kind: "operation_output", producerOperationId: "shot-2", outputSlot: "clip2" },
            ],
            maxCreateAttempts: 1,
            parameters: {
              assembly: "ordered_concat",
              format: "mp4",
              width: 1280,
              height: 720,
              fps: 24,
            },
          },
        ],
        finalOutput: { operationId: "concat-final", outputSlot: "final" },
        outputTarget: finalVideoTarget(),
        maxSpend: { currency: "CNY", amountMinor: 0 },
      },
      catalog(),
      { requestId: "req-b", messageId: "msg-b" },
    );
    const proposal = rowToProposal(prep.proposal, db);
    const run = service.accept("owner", proposal.id, {
      commandId: "accept-batch",
      proposalDigest: proposal.digest,
    }).run;

    // Drive worker until all 3 operations (shot-1, shot-2, concat-final) finish
    for (let step = 0; step < 30; step++) {
      currentMs += 2_000;
      await worker.pollOnce();
      const cur = service.get("owner", run.id);
      if (cur.state === "succeeded" || cur.state === "failed") break;
      await new Promise(r => setTimeout(r, 120));
    }

    const completed = service.get("owner", run.id);
    assert.equal(completed.state, "succeeded", JSON.stringify(completed.issue));
    assert.equal(completed.operations.length, 3);
    assert.ok(completed.operations.every(o => o.state === "succeeded"));
    assert.deepEqual(
      completed.finance,
      {
        state: "pending_reconciliation",
        currency: "CNY",
        reservedMinor: 0,
        pendingUnknownMinor: 0,
        settledMinor: 0,
        priceKind: "estimate",
      },
      "真实 GPU 已运行任务绝不签发人民币 0 元权威结清，保持 pending_reconciliation 并在 usage 保留 CU 证据",
    );

    // Inspect fake colab invocations: ONLY ONE `colab new` and ONLY ONE `colab stop` for the whole 2-shot batch!
    const calls = readFileSync(fake.callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(l => JSON.parse(l));
    const newCalls = calls.filter(c => c.cmd === "new");
    const stopCalls = calls.filter(c => c.cmd === "stop");
    assert.equal(newCalls.length, 1, "同一 runId 的两镜头只申请一次 Colab GPU");
    assert.equal(stopCalls.length, 1, "批次最后一镜完成后立即释放该 GPU");

    // Inspect per-attempt billing & ProviderUsage:
    const attempts = db
      .prepare(
        "SELECT id, operation_id, billing_json, billing_final, billed_minor, usage_json FROM production_attempts WHERE run_id=? ORDER BY rowid",
      )
      .all(run.id) as {
      id: string;
      operation_id: string;
      billing_json: string | null;
      billing_final: number;
      billed_minor: number;
      usage_json: string | null;
    }[];
    const shot1Att = attempts.find(a => a.operation_id === "shot-1")!;
    const shot2Att = attempts.find(a => a.operation_id === "shot-2")!;
    const renderAtt = attempts.find(a => a.operation_id === "concat-final")!;
    assert.equal(shot1Att.billing_json, null);
    assert.equal(shot1Att.billing_final, 0);
    assert.equal(shot2Att.billing_json, null);
    assert.equal(shot2Att.billing_final, 0);
    assert.equal(renderAtt.billing_final, 1, "仅本地 FFmpeg render 记 0 元结清");

    const unsettledIds = db
      .prepare("SELECT attempt_id FROM pending_reconciliation WHERE attempt_id IN (?, ?, ?) ORDER BY attempt_id")
      .pluck()
      .all(shot1Att.id, shot2Att.id, renderAtt.id) as string[];
    assert.deepEqual(unsettledIds.sort(), [shot1Att.id, shot2Att.id].sort());

    const shot1Usage = JSON.parse(shot1Att.usage_json!) as ProviderUsage;
    const shot2Usage = JSON.parse(shot2Att.usage_json!) as ProviderUsage;

    assert.equal(shot1Usage.externalUnit, "colab_cu");
    assert.equal(shot1Usage.providerReceiptId, "gpu-t4-s-owned-1");
    assert.ok((shot1Usage.stageTimingsMs?.modelLoadMs ?? 0) > 0, "首镜记录实际模型加载耗时");
    assert.equal(shot1Usage.observedBalanceDelta, undefined, "首镜保持批次热实例未释放，不提前伪造释放后余额差");

    assert.equal(shot2Usage.externalUnit, "colab_cu");
    assert.equal(shot2Usage.providerReceiptId, "gpu-t4-s-owned-1");
    assert.equal(shot2Usage.cacheSource, "warm_memory", "第二镜直接复用驻留内存模型（warm_memory）");
    assert.equal(shot2Usage.stageTimingsMs?.queueAllocMs, 0);
    assert.equal(shot2Usage.stageTimingsMs?.modelLoadMs, 0, "第二镜无需重复加载权重");
    assert.equal(shot2Usage.observedBalanceDelta, 0.15, "释放批次实例后准确记录批次整段账户余额差观测值 0.15 CU");

    // Pre-existing `[?]` and other-task sessions remain untouched!
    const backendFinal = JSON.parse(readFileSync(fake.backendFile, "utf8"));
    assert.deepEqual(
      backendFinal.assignments.map((a: any) => a.endpoint),
      ["gpu-t4-s-orphan-manual", "gpu-l4-s-other-task"],
    );
  });

  it("COLAB-06 npm start 编译产物（dist/server/server/main.js）以唯一仓库根注入 Colab 执行器与内置技能库，全链路 0 CU 收敛", async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vf-colab-npm-start-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 1) Verify authoritative repo-root executor exists & exits 0 on `--help`
    assert.equal(existsSync(COLAB_EXECUTOR_PATH), true, "仓库根受控 Colab 执行器存在");
    const helpRes = await execFileAsync("python3", [COLAB_EXECUTOR_PATH, "--help"]);
    assert.match(helpRes.stdout, /submit/);
    assert.match(helpRes.stdout, /query/);
    assert.match(helpRes.stdout, /cancel/);

    // 2) Single controlled server compilation matching `npm run build` / `npm start` (`tsconfig.server.build.json`)
    symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
    const prodOutDir = path.join(dir, "dist/server");
    await execFileAsync(process.execPath, [
      path.join(REPO_ROOT, "node_modules/typescript/bin/tsc"),
      "-p",
      path.join(REPO_ROOT, "apps/studio/tsconfig.server.build.json"),
      "--outDir",
      prodOutDir,
    ]);
    const mainJs = path.join(prodOutDir, "server/main.js");
    assert.equal(existsSync(mainJs), true, "产出 dist/server/server/main.js");

    // 3) Isolate PATH with 0-CU `colab` stub (excluding ~/.local/bin so real Colab CLI is unreachable)
    const fallbackSample = path.join(dir, "fallback.mp4");
    await makeSampleFallbackClip(fallbackSample);
    const clipMp4 = existsSync(VERIFIED_SAMPLE_MP4) ? VERIFIED_SAMPLE_MP4 : fallbackSample;
    const firstFramePng = path.join(dir, "first-frame.png");
    await makeFirstFramePng(firstFramePng);

    const fake = writeFakeColabCli(dir);
    const backendState = JSON.parse(readFileSync(fake.backendFile, "utf8"));
    backendState.mockInferenceMp4 = clipMp4;
    writeFileSync(fake.backendFile, JSON.stringify(backendState, null, 2));

    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeColabCmd = path.join(binDir, "colab");
    copyFileSync(fake.colabBin, fakeColabCmd);
    chmodSync(fakeColabCmd, 0o755);

    // Pick free loopback port & spawn real compiled `main.js` from `cwd = apps/studio` (exact `npm start` cwd)
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(err => (err ? reject(err) : resolve(p)));
      });
    });

    const agentDataDir = path.join(dir, "agent-data");
    const origin = `http://127.0.0.1:${port}`;
    let stderrBuf = "";
    const serverProc = spawn(process.execPath, [mainJs], {
      cwd: path.join(REPO_ROOT, "apps/studio"),
      env: {
        PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
        HOME: dir,
        STUDIO_DEV: "1",
        STUDIO_HOST: "127.0.0.1",
        STUDIO_PORT: String(port),
        AGENT_UI_ORIGIN: origin,
        VIDEO_FACTORY_WORKSPACE: path.join(dir, "workspace"),
        AGENT_DATA_DIR: agentDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stderr.setEncoding("utf8");
    serverProc.stderr.on("data", chunk => {
      stderrBuf += chunk;
    });
    t.after(async () => {
      if (serverProc.exitCode === null) {
        serverProc.kill("SIGTERM");
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            serverProc.kill("SIGKILL");
            resolve();
          }, 3000);
          serverProc.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    });

    // Wait for compiled `main.js` health endpoint
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      if (serverProc.exitCode !== null) {
        assert.fail(`编译版 main.js 提前退出 (${serverProc.exitCode}): ${stderrBuf}`);
      }
      try {
        const res = await fetch(`${origin}/api/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // Server still starting
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(healthy, true, `编译版 main.js 在 ${origin} 健康启动`);

    const writeHeaders = {
      origin,
      "x-video-factory-request": "studio",
      "content-type": "application/json",
    };

    // Verify compiled `main.js` discovers built-in `colab-ltx-video` skill from repo-root `apps/studio/skills`
    const skillsRes = await fetch(`${origin}/api/agent/v1/settings/skills`);
    assert.equal(skillsRes.status, 200);
    const skillsJson = (await skillsRes.json()) as { packages: { id: string; skillIds: string[]; status: string }[] };
    const builtin = skillsJson.packages.find(p => p.id === "builtin-skills");
    assert.ok(builtin && builtin.status === "ready");
    assert.ok(builtin.skillIds.includes("colab-ltx-video"));

    // Configure Colab connection, upload first frame, prepare & accept proposal on live compiled `main.js`
    const initConn = (await (await fetch(`${origin}/api/agent/v1/settings/model-connections`)).json()) as {
      revision: number;
    };
    const saveConnRes = await fetch(`${origin}/api/agent/v1/settings/model-connections`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        commandId: "main-save-colab",
        expectedRevision: initConn.revision,
        connection: {
          id: "conn-colab-main",
          name: "Google Colab (LTX-2.5)",
          protocol: "colab",
          baseUrl: "https://colab.research.google.com",
          apiKey: "hf_main_js_test_token",
          credentialConfigured: true,
          enabled: true,
          models: [
            {
              id: "m-colab-main",
              kind: "video",
              name: "LTX-2.5 Distilled (Colab)",
              modelId: "Lightricks/LTX-2.5-distilled",
              features: ["Colab CU"],
              contextWindowTokens: null,
              maxOutputTokens: null,
              enabled: true,
              isDefault: true,
            },
          ],
        },
      }),
    });
    assert.equal(saveConnRes.status, 200);

    const convJson = (await (
      await fetch(`${origin}/api/agent/v1/conversations`, {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ commandId: "main-conv", title: "npm start 编译版验证" }),
      })
    ).json()) as { id: string; revision: number };

    const boundary = "----MainJsColabBoundary";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="commandId"\r\n\r\nmain-upload\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n${convJson.revision}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="rights"\r\n\r\nowned_or_licensed\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="first-frame.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      readFileSync(firstFramePng),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const ulRes = await fetch(`${origin}/api/agent/v1/conversations/${convJson.id}/uploads`, {
      method: "POST",
      headers: {
        origin,
        "x-video-factory-request": "studio",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipart,
    });
    assert.equal(ulRes.status, 201);
    const ulBody = (await ulRes.json()) as { attachment: { source: { artifactId: string; revisionId: string } } };

    const helperDb = openAgentDatabase(agentDataDir);
    let revDigest = "";
    let work: ReturnType<typeof seedConfirmedWork>;
    try {
      revDigest = helperDb
        .prepare("SELECT digest FROM artifact_revisions WHERE id = ?")
        .pluck()
        .get(ulBody.attachment.source.revisionId) as string;
      work = seedConfirmedWork(
        helperDb,
        new Date().toISOString(),
        { ownerId: "local-owner", conversationId: convJson.id },
        "npm start 成片",
      );
    } finally {
      helperDb.close();
    }

    const bootJson = (await (await fetch(`${origin}/api/agent/v1/bootstrap`)).json()) as {
      models: { binding: any }[];
    };
    const colabBinding = bootJson.models.find(m => m.binding.providerId === "colab")!.binding;

    const createPropRes = await fetch(`${origin}/api/agent/v1/conversations/${convJson.id}/proposals`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        commandId: "main-prepare-colab",
        spec: {
          workId: work.workId,
          title: "编译版 main.js Colab 镜头",
          inputSources: [
            {
              kind: "artifact_revision",
              artifactId: ulBody.attachment.source.artifactId,
              revisionId: ulBody.attachment.source.revisionId,
              digest: revDigest,
            },
          ],
          reviewInputs: [work.reviewInput],
          purpose: "production",
          scope: "验证 npm start 受控装配",
          operations: [
            {
              operationId: "shot-main-1",
              outputSlot: "video",
              kind: "video",
              model: colabBinding,
              inputs: [
                {
                  kind: "artifact_revision",
                  artifactId: ulBody.attachment.source.artifactId,
                  revisionId: ulBody.attachment.source.revisionId,
                  digest: revDigest,
                },
                { kind: "text", text: "海面晨光闪烁，镜头平稳推进。" },
              ],
              maxCreateAttempts: 1,
              parameters: {
                durationSeconds: 5,
                aspectRatio: "16:9",
                resolution: "720p",
                audioMode: "native",
                firstFrameSlot: 0,
              },
            },
          ],
          finalOutput: { operationId: "shot-main-1", outputSlot: "video" },
          outputTarget: finalVideoTarget(),
          maxSpend: { currency: "CNY", amountMinor: 0 },
        },
      }),
    });
    assert.equal(createPropRes.status, 201);
    const createdProp = (await createPropRes.json()) as { id: string; digest: string; state: string };
    assert.equal(createdProp.state, "ready");

    const accRes = await fetch(`${origin}/api/agent/v1/proposals/${createdProp.id}/acceptances`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ commandId: "main-accept-colab", proposalDigest: createdProp.digest }),
    });
    assert.equal(accRes.status, 202);
    const runId = ((await accRes.json()) as { run: { id: string } }).run.id;

    let finalRun: any = null;
    for (let i = 0; i < 60; i++) {
      const r = (await (await fetch(`${origin}/api/agent/v1/runs/${runId}`)).json()) as any;
      if (r.state === "succeeded" || r.state === "failed") {
        finalRun = r;
        break;
      }
      await new Promise(res => setTimeout(res, 200));
    }
    assert.ok(finalRun, "编译版 main.js ProductionWorker 已收敛");
    assert.equal(finalRun.state, "succeeded", JSON.stringify(finalRun.issue));
    assert.equal(finalRun.finance.state, "pending_reconciliation");
    assert.equal(finalRun.outputRevisions.length, 1);

    const outRef = finalRun.outputRevisions[0] as { artifactId: string; revisionId: string };
    const revJson = (await (
      await fetch(`${origin}/api/agent/v1/artifacts/${outRef.artifactId}/revisions/${outRef.revisionId}`)
    ).json()) as { content: { blobId: string } };
    const rangeRes = await fetch(`${origin}/api/agent/v1/blobs/${revJson.content.blobId}/content`, {
      headers: { range: "bytes=0-63" },
    });
    assert.equal(rangeRes.status, 206);
    const headBytes = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(headBytes.subarray(4, 8).toString("ascii"), "ftyp");
  });

  it("COLAB-07 网页内置 colab-ltx-video Agent Skill：左侧技能库可见、自动发现与指定选用、host 占位及 720p/5s 能力边界、未启用时真实指引且绝不偷换厂商", async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vf-colab-native-skill-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { runtime, app, firstFramePng, clock, writeHeaders } = await createColabReplayWebFixture(
      t,
      dir,
      "2026-11-25T23:25:00.000Z",
    );

    // 1) Left-sidebar「技能」library (`/api/agent/v1/settings/skills`) & composer skill selector (`/api/agent/v1/bootstrap`)
    const skillsViewRes = await app.inject({ method: "GET", url: "/api/agent/v1/settings/skills" });
    assert.equal(skillsViewRes.statusCode, 200);
    const skillsView = skillsViewRes.json();
    const builtinPkg = skillsView.packages.find((p: any) => p.id === "builtin-skills");
    assert.ok(builtinPkg);
    assert.equal(builtinPkg.status, "ready");
    assert.deepEqual(builtinPkg.diagnostics, []);
    assert.ok(builtinPkg.skillIds.includes("travel-prompt-kit"), "保留原有内置 travel-prompt-kit");
    assert.ok(builtinPkg.skillIds.includes("colab-ltx-video"), "内置技能库新增 colab-ltx-video");

    const bootstrapSkills = (await app.inject({ method: "GET", url: "/api/agent/v1/bootstrap" })).json().skills as {
      id: string;
      name: string;
      description: string;
    }[];
    const colabSkillEntry = bootstrapSkills.find(s => s.id === "colab-ltx-video");
    assert.ok(colabSkillEntry, "Bootstrap skills 暴露 colab-ltx-video 供会话指定 Skill 下拉框选择");
    assert.match(colabSkillEntry.description, /720p\s*5\s*秒/);

    // Builtin skill file must match exact web capability (720p / 5s), exact UI label「模型配置 → 连接配置」+ `host` placeholder,
    // and NEVER expose host bash CLI commands or credential paths to Pi
    const builtinSkillBody = readFileSync(path.join(defaultSkillsRoot, "colab-ltx-video/SKILL.md"), "utf8");
    assert.doesNotMatch(builtinSkillBody, /python3\s+.*colab_ltx\.py|--hf-token-stdin|~\/\.config\/colab-cli|5[–-]10\s*秒/);
    assert.match(builtinSkillBody, /模型配置 → 连接配置/);
    assert.match(builtinSkillBody, /`host`/);
    assert.match(builtinSkillBody, /prepare_production/);
    assert.match(builtinSkillBody, /绝对?不能偷偷换成/);

    // 2) Natural discovery (`skillId: null` -> `read_skill_file`) vs Explicit selection (`skillId: "colab-ltx-video"`)
    const convDiscover = (
      await app.inject({
        method: "POST",
        url: "/api/agent/v1/conversations",
        headers: writeHeaders,
        payload: { commandId: "conv-discover", title: "自然发现 Colab Skill" },
      })
    ).json();
    const convDiscoverId = (convDiscover.conversation ?? convDiscover).id as string;

    const inspectPiContext = (ctx: TranscriptContext) => {
      const systemPrompt = getCurrentSystemPrompt(ctx.messages);
      const latestUser = [...ctx.messages].reverse().find(m => m.role === "user");
      const lastTool = [...ctx.messages].reverse().find(m => m.role === "toolResult");
      const stateLine = [...systemPrompt.split("\n")].reverse().find(line => line.startsWith("[frame-current-state]"));
      const state = stateLine
        ? (JSON.parse(stateLine.slice("[frame-current-state]".length)) as {
            mediaModels: { kind: string; binding: { providerId: string; modelId: string } }[];
          })
        : { mediaModels: [] };
      return {
        systemPrompt,
        userText: latestUser ? contentText(latestUser.content) : "",
        videoProviderIds: state.mediaModels.filter(m => m.kind === "video").map(m => m.binding.providerId),
        lastToolError: Boolean(lastTool?.isError),
        lastToolText: lastTool ? contentText(lastTool.content) : "",
      };
    };
    const awaitCompletedTurn = async (conversationId: string, requestId: string) => {
      for (let i = 0; i < 120 && runtime.service.snapshot("local-owner", conversationId).activeRequestId; i++) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert.equal(runtime.service.snapshot("local-owner", conversationId).activeRequestId, null);
      const reqRow = runtime.database.prepare("SELECT state FROM requests WHERE id = ?").get(requestId) as {
        state: string;
      };
      assert.equal(reqRow.state, "completed", `请求 ${requestId} 必须正常完成`);
    };

    const discoverTurns: ReturnType<typeof inspectPiContext>[] = [];
    runtime.host.faux!.setResponses([
      ctx => {
        discoverTurns.push(inspectPiContext(ctx));
        return fauxAssistantMessage([fauxToolCall("read_skill_file", { path: "colab-ltx-video/SKILL.md" })]);
      },
      ctx => {
        discoverTurns.push(inspectPiContext(ctx));
        return fauxAssistantMessage("已按 Colab LTX-2.5 连续运镜结构给出提示词，未创建作品或提案。");
      },
    ]);
    const discoverRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${convDiscoverId}/messages`,
      headers: writeHeaders,
      payload: {
        commandId: "msg-natural-colab",
        text: "帮我写一段适合首帧生视频的运镜 Prompt",
        target: null,
        skillId: null,
        proposalRef: null,
        mode: "new",
        steerRequestId: null,
      },
    });
    assert.equal(discoverRes.statusCode, 202);
    await awaitCompletedTurn(convDiscoverId, discoverRes.json().requestId);
    assert.equal(discoverTurns.length, 2);
    assert.match(
      discoverTurns[0]!.systemPrompt,
      /<available_skills>[\s\S]*<name>colab-ltx-video<\/name>/,
      "未指定 skillId 时系统提示词 <available_skills> 暴露 colab-ltx-video 供自然发现",
    );
    assert.equal(discoverTurns[1]!.lastToolError, false);
    assert.match(discoverTurns[1]!.lastToolText, /Colab LTX-2\.5 首帧生视频技能/, "Web Pi 可经 read_skill_file 读取技能全文");
    assert.equal(runtime.service.snapshot("local-owner", convDiscoverId).runs.items.length, 0);

    // 3) Configure Ark as GLOBAL DEFAULT (`isDefault: true`), while Colab is Initially DISABLED ->
    //    Explicitly selecting `colab-ltx-video` must expose truthful state (only Ark in mediaModels, no Colab)
    //    and enforce the non-substitution rule + server catalog guard!
    const initRev = (await app.inject({ method: "GET", url: "/api/agent/v1/settings/model-connections" })).json().revision;
    const saveArkRes = await app.inject({
      method: "POST",
      url: "/api/agent/v1/settings/model-connections",
      headers: writeHeaders,
      payload: {
        commandId: "skill-save-ark-default",
        expectedRevision: initRev,
        connection: {
          id: "conn-ark-default",
          name: "火山方舟",
          protocol: "ark",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          apiKey: "ark-key-skill-test",
          credentialConfigured: true,
          enabled: true,
          models: [
            {
              id: "m-ark-seedance",
              kind: "video",
              name: "Seedance 2.5",
              modelId: "doubao-seedance-2-5-260628",
              features: [],
              contextWindowTokens: null,
              maxOutputTokens: null,
              enabled: true,
              isDefault: true,
            },
          ],
        },
      },
    });
    assert.equal(saveArkRes.statusCode, 200);

    const arkOnlyBoot = (
      (await app.inject({ method: "GET", url: "/api/agent/v1/bootstrap" })).json().models as { binding: any }[]
    ).find(m => m.binding.providerId === "ark");
    assert.ok(arkOnlyBoot, "Ark Seedance 已作为全局默认视频模型启用");

    const convUnconfigured = (
      await app.inject({
        method: "POST",
        url: "/api/agent/v1/conversations",
        headers: writeHeaders,
        payload: { commandId: "conv-unconfigured", title: "Colab 未启用时不偷换 Ark" },
      })
    ).json();
    const convUnconfiguredId = (convUnconfigured.conversation ?? convUnconfigured).id as string;
    const unconfWork = seedConfirmedWork(
      runtime.database,
      clock(),
      { ownerId: "local-owner", conversationId: convUnconfiguredId },
      "未启用 Colab 时的防偷换校验作品",
    );
    const validArkVideoSpec = {
      workId: unconfWork.workId,
      title: "火山方舟镜头提案",
      inputSources: [],
      reviewInputs: [unconfWork.reviewInput],
      purpose: "production",
      scope: "验证同规格 Ark 视频操作在指定 colab-ltx-video 时被拒、用户普通回合改选时放行",
      operations: [
        {
          operationId: "shot-ark-sneak",
          outputSlot: "video",
          kind: "video",
          model: arkOnlyBoot.binding,
          inputs: [{ kind: "text", text: "清晨薄雾笼罩湖面，镜头平推。" }],
          parameters: {
            durationSeconds: 5,
            aspectRatio: "16:9",
            resolution: "720p",
            audioMode: "native",
          },
        },
      ],
      finalOutput: { operationId: "shot-ark-sneak", outputSlot: "video" },
      outputTarget: finalVideoTarget(),
      maxSpend: { currency: "CNY", amountMinor: 3000 },
    };

    const unconfTurns: ReturnType<typeof inspectPiContext>[] = [];
    runtime.host.faux!.setResponses([
      ctx => {
        unconfTurns.push(inspectPiContext(ctx));
        // Simulate model mistakenly attempting to submit a valid Ark video operation while `colab-ltx-video` is explicitly selected
        return fauxAssistantMessage([
          fauxToolCall("prepare_production", asJsonArgs({ spec: validArkVideoSpec })),
        ]);
      },
      ctx => {
        unconfTurns.push(inspectPiContext(ctx));
        return fauxAssistantMessage(
          "当前尚未在「模型配置 → 连接配置」中启用 Google Colab（LTX-2.5）（若宿主机已授权可填 host）；现有可用视频模型为火山方舟 Seedance 2.5。请先启用 Colab 连接，或在下一轮明确告知改用火山方舟。",
        );
      },
    ]);
    const unconfMsgRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${convUnconfiguredId}/messages`,
      headers: writeHeaders,
      payload: {
        commandId: "msg-explicit-skill-unconfigured",
        text: "用 Colab 生成一段 5 秒镜头",
        target: null,
        skillId: "colab-ltx-video",
        proposalRef: null,
        mode: "new",
        steerRequestId: null,
      },
    });
    assert.equal(unconfMsgRes.statusCode, 202);
    await awaitCompletedTurn(convUnconfiguredId, unconfMsgRes.json().requestId);
    assert.equal(unconfTurns.length, 2);
    assert.match(unconfTurns[0]!.userText, /<skill name="colab-ltx-video"/, "会话指定 colab-ltx-video 在原始 user.content 注入真实 <skill> 块");
    assert.deepEqual(unconfTurns[0]!.videoProviderIds, ["ark"], "[frame-current-state] 仅含已启用 Ark、不含未连接 Colab");
    assert.equal(unconfTurns[1]!.lastToolError, true, "误交其他厂商 video 操作返回工具错误");
    assert.match(
      unconfTurns[1]!.lastToolText,
      /^INVALID_INPUT:.*colab-ltx-video/,
      "指定 colab-ltx-video 时模型误交有效 Ark video 操作必须返回真实可读业务错误",
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/agent/v1/conversations/${convUnconfiguredId}/proposals` })).json().items
        .length,
      0,
      "被拒绝后无任何提案落库",
    );
    assert.equal(runtime.service.snapshot("local-owner", convUnconfiguredId).runs.items.length, 0, "被拒绝后无任何运行");

    // Verify user's normal re-selection path (`skillId: null`) accepts the EXACT SAME valid Ark video operation!
    const reselectTurns: ReturnType<typeof inspectPiContext>[] = [];
    runtime.host.faux!.setResponses([
      () => fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: validArkVideoSpec }))]),
      ctx => {
        reselectTurns.push(inspectPiContext(ctx));
        return fauxAssistantMessage("已按您的改选准备火山方舟 Seedance 提案，请确认制作。");
      },
    ]);
    const switchToArkRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${convUnconfiguredId}/messages`,
      headers: writeHeaders,
      payload: {
        commandId: "msg-user-reselect-ark",
        text: "那这次改用火山方舟 Seedance 生成吧",
        target: null,
        skillId: null,
        proposalRef: null,
        mode: "new",
        steerRequestId: null,
      },
    });
    assert.equal(switchToArkRes.statusCode, 202);
    await awaitCompletedTurn(convUnconfiguredId, switchToArkRes.json().requestId);
    assert.equal(reselectTurns.length, 1);
    assert.equal(reselectTurns[0]!.lastToolError, false, "普通回合用户改选 Ark 不受上一轮指定技能拦截");
    const reselectedProposals = (
      await app.inject({ method: "GET", url: `/api/agent/v1/conversations/${convUnconfiguredId}/proposals` })
    ).json().items as { id: string; state: string }[];
    assert.equal(reselectedProposals.length, 1, "普通回合用户改选 Ark 时同一份有效 Ark 视频操作正常生成提案");
    assert.equal(reselectedProposals[0]!.state, "ready");
    assert.equal(runtime.service.snapshot("local-owner", convUnconfiguredId).runs.items.length, 0, "未经批准不启动运行");

    // 4) Enable Colab as NON-DEFAULT (`isDefault: false`) while Ark REMAINS global default (`isDefault: true`)!
    //    Verify `connectedColabVideoChoices` exposes Colab (`可按本次选择`) so selecting `colab-ltx-video` calls Colab!
    const revBeforeColab = (await app.inject({ method: "GET", url: "/api/agent/v1/settings/model-connections" })).json()
      .revision;
    const saveColabChoiceRes = await app.inject({
      method: "POST",
      url: "/api/agent/v1/settings/model-connections",
      headers: writeHeaders,
      payload: {
        commandId: "skill-save-colab-nondefault",
        expectedRevision: revBeforeColab,
        connection: {
          id: "conn-colab-choice",
          name: "Google Colab (LTX-2.5)",
          protocol: "colab",
          baseUrl: "https://colab.research.google.com",
          apiKey: "host",
          credentialConfigured: true,
          enabled: true,
          models: [
            {
              id: "m-colab-choice",
              kind: "video",
              name: "LTX-2.5 Distilled (Colab)",
              modelId: "Lightricks/LTX-2.5-distilled",
              features: ["Colab CU"],
              contextWindowTokens: null,
              maxOutputTokens: null,
              enabled: true,
              isDefault: false,
            },
          ],
        },
      },
    });
    assert.equal(saveColabChoiceRes.statusCode, 200);
    assert.notEqual(readArkVideoCurrent(runtime.database), null, "火山方舟仍保持全局默认视频行");
    assert.equal(readAdditionalMediaCurrent(runtime.database, "colab-video"), null, "非默认 Colab 不覆盖当前默认行");

    const openedKeys: (string | null)[] = [];
    runtime.database.function("frame_open", { directOnly: true }, (value: string | null) => {
      openedKeys.push(value);
      return value;
    });
    try {
      const colabOnlyChoices = connectedColabVideoChoices(runtime.database, true);
      assert.equal(colabOnlyChoices.models.length, 1);
    } finally {
      runtime.database.function("frame_open", { directOnly: true }, (value: string | null) => value);
    }
    assert.ok(openedKeys.includes("host"), "connectedColabVideoChoices 解开 Colab 连接凭据");
    assert.ok(!openedKeys.includes("ark-key-skill-test"), "connectedColabVideoChoices 不额外解开无关服务凭据");

    const bootAfterChoice = (await app.inject({ method: "GET", url: "/api/agent/v1/bootstrap" })).json().models as {
      binding: any;
      features: string[];
    }[];
    const arkBoot = bootAfterChoice.find(m => m.binding.providerId === "ark");
    const colabBoot = bootAfterChoice.find(m => m.binding.providerId === "colab");
    assert.ok(arkBoot && colabBoot, "Ark 全局默认与 Colab 按次备选同时在目录可见");
    assert.ok(colabBoot.features.includes("可按本次选择"));

    // Create conversation, upload first-frame PNG, select `skillId: "colab-ltx-video"`, prepare proposal -> confirm -> Worker!
    const convExecRes = await app.inject({
      method: "POST",
      url: "/api/agent/v1/conversations",
      headers: writeHeaders,
      payload: { commandId: "conv-skill-exec", title: "指定 colab-ltx-video 技能出片" },
    });
    const convExec = (convExecRes.json().conversation ?? convExecRes.json()) as { id: string; revision: number };

    const boundary = "----SkillColabFrameBoundary";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="commandId"\r\n\r\nskill-upload-frame\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n${convExec.revision}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="rights"\r\n\r\nowned_or_licensed\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="frame.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      readFileSync(firstFramePng),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const ulRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${convExec.id}/uploads`,
      headers: {
        origin: "http://127.0.0.1:4318",
        "x-video-factory-request": "studio",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    });
    assert.equal(ulRes.statusCode, 201);
    const frameSrc = ulRes.json().attachment.source as { artifactId: string; revisionId: string };
    const frameDigest = runtime.database
      .prepare("SELECT digest FROM artifact_revisions WHERE id = ?")
      .pluck()
      .get(frameSrc.revisionId) as string;
    const work = seedConfirmedWork(
      runtime.database,
      clock(),
      { ownerId: "local-owner", conversationId: convExec.id },
      "技能驱动 Colab 作品",
    );

    const colabToolIntent: ToolProductionIntent = {
      workId: work.workId,
      title: "指定 Colab 技能镜头",
      inputSources: [
        {
          kind: "artifact_revision",
          artifactId: frameSrc.artifactId,
          revisionId: frameSrc.revisionId,
          digest: frameDigest,
        },
      ],
      reviewInputs: [work.reviewInput],
      purpose: "production",
      scope: "Ark 为全局默认时按指定 colab-ltx-video 技能调用 Colab",
      operations: [
        {
          operationId: "shot-skill-1",
          outputSlot: "video",
          kind: "video",
          model: colabBoot.binding,
          inputs: [
            {
              kind: "artifact_revision",
              artifactId: frameSrc.artifactId,
              revisionId: frameSrc.revisionId,
              digest: frameDigest,
            },
            { kind: "text", text: "镜头平稳向前推进，微风吹拂水面泛起涟漪，轻柔水声。" },
          ],
          parameters: {
            durationSeconds: 5,
            aspectRatio: "16:9",
            resolution: "720p",
            audioMode: "native",
            firstFrameSlot: 0,
          },
        },
      ],
      finalOutput: { operationId: "shot-skill-1", outputSlot: "video" },
      outputTarget: finalVideoTarget(),
      maxSpend: { currency: "CNY", amountMinor: 0 },
    };

    const execTurns: ReturnType<typeof inspectPiContext>[] = [];
    runtime.host.faux!.setResponses([
      ctx => {
        execTurns.push(inspectPiContext(ctx));
        return fauxAssistantMessage([
          fauxToolCall("prepare_production", asJsonArgs({ spec: colabToolIntent })),
        ]);
      },
      ctx => {
        execTurns.push(inspectPiContext(ctx));
        return fauxAssistantMessage("已按 Colab LTX-2.5 技能准备好制作提案，请点击「确认制作」。");
      },
    ]);

    const skillTurnRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${convExec.id}/messages`,
      headers: writeHeaders,
      payload: {
        commandId: "msg-skill-prepare",
        text: "请用 Colab LTX-2.5 把这张首帧做成 5 秒镜头",
        target: null,
        skillId: "colab-ltx-video",
        proposalRef: null,
        mode: "new",
        steerRequestId: null,
      },
    });
    assert.equal(skillTurnRes.statusCode, 202);
    await awaitCompletedTurn(convExec.id, skillTurnRes.json().requestId);
    assert.equal(execTurns.length, 2);
    assert.match(execTurns[0]!.userText, /<skill name="colab-ltx-video"/, "指定技能在原始 user.content 展开真实 <skill>");
    assert.deepEqual(
      [...execTurns[0]!.videoProviderIds].sort(),
      ["ark", "colab"],
      "[frame-current-state] 的 mediaModels 同时暴露全局默认 ark 与按次可选 colab",
    );
    assert.equal(execTurns[1]!.lastToolError, false);
    assert.match(execTurns[1]!.lastToolText, /^提案已准备：/);

    // Confirmation gate: BEFORE user accepts, 0 runs exist!
    assert.equal(
      runtime.service.snapshot("local-owner", convExec.id).runs.items.length,
      0,
      "用户点击确认制作前绝不启动任何后台运行",
    );
    const propItem = (await app.inject({ method: "GET", url: `/api/agent/v1/conversations/${convExec.id}/proposals` })).json()
      .items[0];
    assert.equal(propItem.state, "ready");
    const fullProp = (await app.inject({ method: "GET", url: `/api/agent/v1/proposals/${propItem.id}` })).json();
    assert.equal(fullProp.spec.operations[0].model.providerId, "colab", "提案冻结的是 Colab 而非全局默认 Ark");

    // Verify `10s` and `1080p` are REJECTED by the web proposal capability validator (matching SKILL.md `720p / 5s` boundary)
    for (const [badLabel, badPatch] of [
      ["10s", { durationSeconds: 10 }],
      ["1080p", { resolution: "1080p" }],
    ] as const) {
      const badRes: { statusCode: number; json(): { code?: string } } = await app.inject({
        method: "POST",
        url: `/api/agent/v1/conversations/${convExec.id}/proposals`,
        headers: writeHeaders,
        payload: {
          commandId: `reject-colab-${badLabel}`,
          spec: {
            workId: work.workId,
            title: `越界规格 ${badLabel}`,
            inputSources: [
              {
                kind: "artifact_revision",
                artifactId: frameSrc.artifactId,
                revisionId: frameSrc.revisionId,
                digest: frameDigest,
              },
            ],
            reviewInputs: [work.reviewInput],
            purpose: "production",
            scope: `测试拒绝 ${badLabel}`,
            operations: [
              {
                operationId: `shot-bad-${badLabel}`,
                outputSlot: "video",
                kind: "video",
                model: colabBoot.binding,
                inputs: [
                  {
                    kind: "artifact_revision",
                    artifactId: frameSrc.artifactId,
                    revisionId: frameSrc.revisionId,
                    digest: frameDigest,
                  },
                  { kind: "text", text: "越界参数测试。" },
                ],
                maxCreateAttempts: 1,
                parameters: Object.assign(
                  {
                    durationSeconds: 5,
                    aspectRatio: "16:9",
                    resolution: "720p",
                    audioMode: "native",
                    firstFrameSlot: 0,
                  },
                  badPatch,
                ),
              },
            ],
            finalOutput: { operationId: `shot-bad-${badLabel}`, outputSlot: "video" },
            outputTarget: finalVideoTarget(),
            maxSpend: { currency: "CNY", amountMinor: 0 },
          },
        },
      });
      assert.equal(badRes.statusCode, 503, `${badLabel} 超出已核实能力组合，按既有契约返回 503`);
      const badBody = badRes.json() as { code?: string };
      assert.equal(badBody.code, "CAPABILITY_UNAVAILABLE", `${badLabel} 返回明确 CAPABILITY_UNAVAILABLE 业务码`);
      assert.equal(
        (await app.inject({ method: "GET", url: `/api/agent/v1/conversations/${convExec.id}/proposals` })).json().items
          .length,
        1,
        `${badLabel} 被拒绝后不产生任何新提案`,
      );
    }

    // User confirms proposal -> Worker settles single authoritative video revision
    const accRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${propItem.id}/acceptances`,
      headers: writeHeaders,
      payload: { commandId: "acc-skill-colab", proposalDigest: propItem.digest },
    });
    assert.equal(accRes.statusCode, 202);
    const skillRunId = accRes.json().run.id as string;
    let settledSkillRun: any = null;
    for (let i = 0; i < 80; i++) {
      const r = (await app.inject({ method: "GET", url: `/api/agent/v1/runs/${skillRunId}` })).json();
      if (r.state === "succeeded" || r.state === "failed") {
        settledSkillRun = r;
        break;
      }
      await new Promise(res => setTimeout(res, 40));
    }
    assert.ok(settledSkillRun);
    assert.equal(settledSkillRun.state, "succeeded");
    assert.equal(settledSkillRun.outputRevisions.length, 1);

    // Prepare one more unaccepted Colab proposal from the same valid intent, then disable Colab connection -> unaccepted proposal becomes `stale`!
    const waitingPropRes = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${convExec.id}/proposals`,
      headers: writeHeaders,
      payload: {
        commandId: "prepare-waiting-colab",
        spec: expandToolIntent(colabToolIntent, connectedColabVideoChoices(runtime.database, true).catalog),
      },
    });
    assert.equal(waitingPropRes.statusCode, 201);
    const waitingProp = waitingPropRes.json() as { id: string; state: string };
    assert.equal(waitingProp.state, "ready");

    const revBeforeDisable = (await app.inject({ method: "GET", url: "/api/agent/v1/settings/model-connections" })).json()
      .revision;
    const disableColabRes = await app.inject({
      method: "POST",
      url: "/api/agent/v1/settings/model-connections",
      headers: writeHeaders,
      payload: {
        commandId: "disable-colab-choice",
        expectedRevision: revBeforeDisable,
        connection: {
          id: "conn-colab-choice",
          name: "Google Colab (LTX-2.5)",
          protocol: "colab",
          baseUrl: "https://colab.research.google.com",
          apiKey: null,
          credentialConfigured: true,
          enabled: false,
          models: [
            {
              id: "m-colab-choice",
              kind: "video",
              name: "LTX-2.5 Distilled (Colab)",
              modelId: "Lightricks/LTX-2.5-distilled",
              features: ["Colab CU"],
              contextWindowTokens: null,
              maxOutputTokens: null,
              enabled: true,
              isDefault: false,
            },
          ],
        },
      },
    });
    assert.equal(disableColabRes.statusCode, 200);
    const afterDisableProp = (await app.inject({ method: "GET", url: `/api/agent/v1/proposals/${waitingProp.id}` })).json();
    assert.equal(afterDisableProp.state, "stale", "停用非默认 Colab 连接时自动作废未受理的 Colab 提案");
    assert.notEqual(readArkVideoCurrent(runtime.database), null, "停用非默认 Colab 不影响 Ark 全局默认视频");
  });
});
