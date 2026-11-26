import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkbench, ProposalCard } from "../src/client/agent/AgentWorkbench.js";
import { FrameSettings } from "../src/client/agent/FrameSettings.js";
import type {
  Bootstrap,
  ModelBinding,
  OperationSelectionSource,
  ProductionSpec,
  Proposal,
  ProviderConnectionSettings,
  RebindProposal,
  SaveProviderConnection,
} from "../src/shared/agent/generated/contracts.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const ARK_VIDEO_BINDING: ModelBinding = {
  providerId: "ark",
  modelId: "doubao-seedance-2-0-260128",
  connectionId: "conn-ark-1",
  configurationRevisionId: "cfg-ark-video-1",
};

const COLAB_VIDEO_BINDING: ModelBinding = {
  providerId: "colab",
  modelId: "Lightricks/LTX-2.5-distilled",
  connectionId: "conn-colab-1",
  configurationRevisionId: "cfg-colab-video-1",
};

const MINIMAX_SPEECH_BINDING: ModelBinding = {
  providerId: "minimax",
  modelId: "speech-2.8-turbo",
  connectionId: "conn-mm-1",
  configurationRevisionId: "cfg-mm-speech-1",
};

const EDGE_SPEECH_BINDING: ModelBinding = {
  providerId: "edge-tts",
  modelId: "edge-tts",
  connectionId: "free-service-edge-tts",
  configurationRevisionId: "cfg-edge-speech-1",
};

const POOL_BOOTSTRAP: Bootstrap = {
  ownerId: "local-owner",
  displayName: "帧工坊创作者",
  models: [
    {
      binding: {
        providerId: "openai",
        modelId: "gpt-5.4",
        connectionId: "conn-openai",
        configurationRevisionId: "cfg-text-1",
      },
      name: "GPT-5.4",
      connectionName: "OpenAI 主连接",
      kind: "text",
      features: ["分镜与脚本"],
      availability: "configured",
      verificationNote: "已配置",
      isDefault: true,
    },
    {
      binding: ARK_VIDEO_BINDING,
      name: "Seedance 2.0",
      connectionName: "火山方舟",
      kind: "video",
      features: ["有声视频"],
      availability: "configured",
      verificationNote: "已配置",
      isDefault: true,
      costSummary: "约 ¥0.92–¥1.90/5秒",
      capabilitySummary: {
        durationSecondsMin: 4,
        durationSecondsMax: 10,
        resolutions: ["720p", "1080p"],
        aspectRatios: ["16:9", "9:16", "1:1"],
        requiresFirstFrame: false,
      },
    },
    {
      binding: COLAB_VIDEO_BINDING,
      name: "LTX-2.5 Distilled",
      connectionName: "Google Colab",
      kind: "video",
      features: ["首帧生视频", "Colab CU"],
      availability: "configured",
      verificationNote: "已配置",
      isDefault: false,
      costSummary: "¥0.00 + 约 0.08–0.25 Colab CU/镜",
      externalUnit: "colab_cu",
      capabilitySummary: {
        durationSecondsMin: 5,
        durationSecondsMax: 5,
        resolutions: ["720p"],
        aspectRatios: ["16:9", "9:16"],
        requiresFirstFrame: true,
      },
    },
    {
      binding: MINIMAX_SPEECH_BINDING,
      name: "Speech 2.8 Turbo",
      connectionName: "MiniMax",
      kind: "speech",
      features: ["多音色"],
      availability: "configured",
      verificationNote: "已配置",
      isDefault: true,
      costSummary: "¥0.0004/字",
      defaultVoiceId: "Chinese (Mandarin)_Gentleman",
      voices: [
        { id: "Chinese (Mandarin)_Gentleman", label: "温润男声 · 普通话" },
        { id: "Chinese (Mandarin)_News_Anchor", label: "新闻女声 · 普通话" },
      ],
    },
    {
      binding: EDGE_SPEECH_BINDING,
      name: "Edge 免费配音",
      connectionName: "免费服务",
      kind: "speech",
      features: ["免费配音", "词级字幕"],
      availability: "configured",
      verificationNote: "已配置",
      isDefault: false,
      costSummary: "¥0.00 免费配音",
      defaultVoiceId: "zh-CN-XiaoxiaoNeural",
      voices: [
        { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 中文女声" },
        { id: "zh-CN-YunxiNeural", label: "云希 · 中文男声" },
      ],
    },
  ],
  skills: [],
};

function makePoolProposal(overrides: Partial<Proposal> = {}): Proposal {
  const spec: ProductionSpec = {
    type: "paid_production",
    workId: "work-1",
    title: "双镜头混音短片",
    purpose: "production",
    scope: "生成 2 条 5 秒镜头与 1 段旁白配音",
    reviewInputs: [],
    inputSources: [],
    defaultsAtPrepare: {
      video: ARK_VIDEO_BINDING,
      speech: MINIMAX_SPEECH_BINDING,
    },
    modelLabels: [
      {
        configurationRevisionId: ARK_VIDEO_BINDING.configurationRevisionId,
        connectionName: "火山方舟",
        modelName: "Seedance 2.0",
        costSummary: "约 ¥0.92–¥1.90/5秒",
      },
      {
        configurationRevisionId: COLAB_VIDEO_BINDING.configurationRevisionId,
        connectionName: "Google Colab",
        modelName: "LTX-2.5 Distilled",
        costSummary: "¥0.00 + 约 0.08–0.25 Colab CU/镜",
        externalUnit: "colab_cu",
      },
      {
        configurationRevisionId: MINIMAX_SPEECH_BINDING.configurationRevisionId,
        connectionName: "MiniMax",
        modelName: "Speech 2.8 Turbo",
        costSummary: "¥0.0004/字",
        defaultVoiceId: "Chinese (Mandarin)_Gentleman",
      },
      {
        configurationRevisionId: EDGE_SPEECH_BINDING.configurationRevisionId,
        connectionName: "免费服务",
        modelName: "Edge 免费配音",
        costSummary: "¥0.00 免费配音",
        defaultVoiceId: "zh-CN-XiaoxiaoNeural",
      },
    ],
    selectionSources: [
      { operationId: "shot-1", source: "default" },
      { operationId: "shot-2", source: "default" },
      { operationId: "narration-1", source: "default" },
    ],
    operations: [
      {
        operationId: "shot-1",
        outputSlot: "shot_1",
        kind: "video",
        model: ARK_VIDEO_BINDING,
        inputs: [{ kind: "text", text: "第一镜纯文本海面日出" }],
        parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
        maxCreateAttempts: 1,
        quotePerAttempt: { currency: "CNY", amountMinor: 185 },
        priceKind: "estimate",
      },
      {
        operationId: "shot-2",
        outputSlot: "shot_2",
        kind: "video",
        model: ARK_VIDEO_BINDING,
        inputs: [
          {
            kind: "artifact_revision",
            artifactId: "art-frame",
            revisionId: "rev-frame",
            digest: "dig-frame",
          },
          { kind: "text", text: "第二镜带首帧灯塔推镜" },
        ],
        parameters: {
          durationSeconds: 5,
          aspectRatio: "16:9",
          resolution: "720p",
          audioMode: "native",
          firstFrameSlot: 0,
        },
        maxCreateAttempts: 1,
        quotePerAttempt: { currency: "CNY", amountMinor: 185 },
        priceKind: "estimate",
      },
      {
        operationId: "narration-1",
        outputSlot: "narration",
        kind: "speech",
        model: MINIMAX_SPEECH_BINDING,
        inputs: [{ kind: "text", text: "晨光穿过薄雾照亮海岸线。" }],
        parameters: { voiceId: "Chinese (Mandarin)_Gentleman", format: "mp3" },
        maxCreateAttempts: 1,
        quotePerAttempt: { currency: "CNY", amountMinor: 10 },
        priceKind: "estimate",
      },
    ],
    finalOutput: { operationId: "shot-2", outputSlot: "shot_2" },
    maxSpend: { currency: "CNY", amountMinor: 380 },
    requestSource: { requestId: "req-1", messageId: "msg-1" },
  };
  return {
    id: "prop-pool-1",
    conversationId: "conv-1",
    revision: 1,
    state: "ready",
    digest: "digest-default-v1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    acceptedRunId: null,
    acceptanceBlocker: null,
    priceDisclosure: "本次最高人民币 ¥3.80（按各镜头单次上限汇总）。",
    spec,
    ...overrides,
  };
}

describe("Model Pool Settings, Progressive Disclosure ProposalCard & Composer Default Bar", () => {
  it("设置页多活模型池：文本保持『当前使用』，视频/配音展示池计数、池内可用徽章、取消默认与 Edge 免费配音共存", async () => {
    let settings: ProviderConnectionSettings = {
      revision: 1,
      connections: [
        {
          id: "conn-openai",
          name: "OpenAI 主连接",
          protocol: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: null,
          credentialConfigured: true,
          enabled: true,
          models: [
            {
              id: "m-text",
              name: "GPT-5.4",
              modelId: "gpt-5.4",
              kind: "text",
              features: [],
              contextWindowTokens: 128000,
              maxOutputTokens: 8000,
              enabled: true,
              isDefault: true,
              thinkingLevel: "default",
            },
          ],
        },
        {
          id: "conn-mm-1",
          name: "MiniMax",
          protocol: "minimax",
          baseUrl: "https://api.minimax.cn",
          apiKey: null,
          credentialConfigured: true,
          enabled: true,
          models: [
            {
              id: "m-mm-speech",
              name: "Speech 2.8 Turbo",
              modelId: "speech-2.8-turbo",
              kind: "speech",
              features: ["多音色"],
              contextWindowTokens: null,
              maxOutputTokens: null,
              enabled: true,
              isDefault: true,
            },
          ],
        },
      ],
      modelStatuses: [
        { modelEntryId: "m-text", unavailableReason: null, thinking: null },
        { modelEntryId: "m-mm-speech", unavailableReason: null, thinking: null },
      ],
    };
    const posts: SaveProviderConnection[] = [];
    const edgePatches: Array<Record<string, unknown>> = [];
    let edgeRevision = 1;
    let edgeIsDefault: boolean | undefined = undefined;

    const currentBootstrap = (): Bootstrap => ({
      ...POOL_BOOTSTRAP,
      models: POOL_BOOTSTRAP.models.map(m => {
        if (m.kind !== "speech") return m;
        const paidDefault = settings.connections.find(c => c.id === "conn-mm-1")?.models[0]?.isDefault ?? false;
        if (m.binding.providerId === "minimax") return { ...m, isDefault: paidDefault };
        if (m.binding.providerId === "edge-tts") return { ...m, isDefault: !paidDefault && edgeIsDefault === true };
        return m;
      }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/settings/model-connections")) {
          if (init?.method === "POST") {
            const body = JSON.parse(init.body as string) as SaveProviderConnection;
            posts.push(body);
            if (body.connection.models.some(m => m.kind === "speech" && m.isDefault)) {
              edgeIsDefault = false;
            }
            settings = {
              ...settings,
              revision: settings.revision + 1,
              connections: settings.connections.map(c => (c.id === body.connection.id ? body.connection : c)),
            };
            return Response.json({ revision: settings.revision, replayed: false });
          }
          return Response.json(settings);
        }
        if (url.endsWith("/settings/services/edge-tts")) {
          if (init?.method === "PATCH") {
            const body = JSON.parse(init.body as string) as { isDefault?: boolean; voice: string; enabled: boolean };
            edgePatches.push(body);
            edgeRevision += 1;
            edgeIsDefault = body.isDefault;
            if (edgeIsDefault === true) {
              settings = {
                ...settings,
                revision: settings.revision + 1,
                connections: settings.connections.map(c => ({
                  ...c,
                  models: c.models.map(m => (m.kind === "speech" ? { ...m, isDefault: false } : m)),
                })),
              };
            }
            return Response.json({
              settings: {
                serviceId: "edge-tts",
                revision: edgeRevision,
                enabled: body.enabled,
                voice: body.voice,
                ...(typeof edgeIsDefault === "boolean" ? { isDefault: edgeIsDefault } : {}),
              },
              replayed: false,
            });
          }
          return Response.json({
            serviceId: "edge-tts",
            revision: edgeRevision,
            enabled: true,
            voice: "zh-CN-XiaoxiaoNeural",
            ...(typeof edgeIsDefault === "boolean" ? { isDefault: edgeIsDefault } : {}),
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    let rerenderSettings!: () => void;
    const { rerender } = render(
      <FrameSettings
        page="models"
        bootstrap={currentBootstrap()}
        conversations={[]}
        onConversation={() => {}}
        onPage={() => {}}
        onCatalogRefresh={async () => rerenderSettings()}
      />,
    );
    rerenderSettings = () =>
      rerender(
        <FrameSettings
          page="models"
          bootstrap={currentBootstrap()}
          conversations={[]}
          onConversation={() => {}}
          onPage={() => {}}
          onCatalogRefresh={async () => rerenderSettings()}
        />,
      );

    // 文本页签保持单当前心智
    expect(await screen.findByText("当前使用")).toBeVisible();
    expect(screen.getByText("用于新的请求和方案")).toBeVisible();

    // 切到配音模型：多活池展示默认模型 + Edge 免费配音作为池内可用备选共存
    await userEvent.click(screen.getByRole("tab", { name: /配音模型/ }));
    expect(await screen.findByText("默认模型（新提案预填）")).toBeVisible();
    expect(screen.getByText("模型池 2 项可用")).toBeVisible();
    expect(screen.getByText("Edge 免费配音")).toBeVisible();
    expect(screen.getAllByText("池内可用").length).toBeGreaterThan(0);

    // 1) 支持取消付费默认 → 进入无默认手动选态，且此时仍可将 Edge 免费配音『设为默认』
    await userEvent.click(screen.getByRole("button", { name: "取消默认" }));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.connection.models[0]!.enabled).toBe(true);
    expect(posts[0]!.connection.models[0]!.isDefault).toBe(false);
    expect(await screen.findByText(/已取消默认配音模型/)).toBeVisible();
    expect(screen.getByText("还没有当前模型")).toBeVisible();

    // 2) 点击 Edge 免费配音备选行的『设为默认』 → 真实写 edge-tts isDefault: true，切换为免费配音默认并露出『取消默认』
    const edgeRow = screen.getByText("Edge 免费配音").closest(".agent-backup-row") as HTMLElement;
    await userEvent.click(within(edgeRow).getByRole("button", { name: "设为默认" }));
    await waitFor(() => expect(edgePatches).toHaveLength(1));
    expect(edgePatches[0]).toMatchObject({ enabled: true, isDefault: true });
    expect(await screen.findByText(/当前新提案默认已切换到 Edge 免费配音/)).toBeVisible();
    expect(screen.getByRole("button", { name: "取消默认" })).toBeVisible();
  });

  it("ProposalCard 渐进披露：首屏零下拉直接确认、展开按类/音色换模、查看制作范围单镜换模且收起仍常显例外", async () => {
    const rebindCalls: Array<RebindProposal["changes"]> = [];
    let latestProposal = makePoolProposal();
    const onAccept = vi.fn();

    const applyChanges = (current: Proposal, changes: RebindProposal["changes"]): Proposal => {
      const curSpec = current.spec as ProductionSpec;
      const nextOps = curSpec.operations.map(op => {
        if (op.kind === "render") return op;
        const change = changes.find(c => c.operationId === op.operationId);
        if (!change) return op;
        const isColab = change.model.providerId === "colab";
        const isEdge = change.model.providerId === "edge-tts";
        if (op.kind === "speech") {
          return {
            ...op,
            model: change.model,
            parameters: { ...op.parameters, ...(change.voiceId ? { voiceId: change.voiceId } : {}) },
            quotePerAttempt: { currency: "CNY" as const, amountMinor: isEdge ? 0 : 10 },
          };
        }
        return {
          ...op,
          model: change.model,
          quotePerAttempt: { currency: "CNY" as const, amountMinor: isColab ? 0 : 185 },
        };
      });
      const nextMinor = nextOps.reduce(
        (sum, op) => sum + (op.kind === "render" ? 0 : op.quotePerAttempt.amountMinor),
        0,
      );
      const sourceMap = new Map<string, OperationSelectionSource["source"]>(
        (curSpec.selectionSources ?? []).map(s => [s.operationId, s.source]),
      );
      for (const ch of changes) {
        const targetOp = nextOps.find(o => o.operationId === ch.operationId);
        const def = targetOp && targetOp.kind !== "render" ? curSpec.defaultsAtPrepare?.[targetOp.kind] : null;
        sourceMap.set(
          ch.operationId,
          def && def.configurationRevisionId === ch.model.configurationRevisionId ? "default" : "card_selected",
        );
      }
      return {
        ...current,
        revision: current.revision + 1,
        digest: `digest-v${current.revision + 1}`,
        priceDisclosure: nextOps.some(o => o.kind !== "render" && o.model.providerId === "colab")
          ? `本次最高人民币 ¥${(nextMinor / 100).toFixed(2)}，另消耗 Google Colab 计算单元（CU）。`
          : `本次最高人民币 ¥${(nextMinor / 100).toFixed(2)}。`,
        spec: {
          ...curSpec,
          operations: [nextOps[0]!, ...nextOps.slice(1)],
          selectionSources: [...sourceMap.entries()].map(([operationId, source]) => ({ operationId, source })),
          maxSpend: { currency: "CNY", amountMinor: nextMinor },
        },
      };
    };

    let rerenderCard!: (prop: Proposal) => void;
    const handleRebind = async (_proposal: Proposal, changes: RebindProposal["changes"]) => {
      rebindCalls.push(changes);
      latestProposal = applyChanges(latestProposal, changes);
      rerenderCard(latestProposal);
      return latestProposal;
    };

    const { rerender } = render(
      <ProposalCard
        proposal={latestProposal}
        busy={false}
        artifacts={[]}
        revisions={{}}
        works={[]}
        poolModels={POOL_BOOTSTRAP.models}
        onRebind={handleRebind}
        onOpen={() => {}}
        onAccept={onAccept}
      />,
    );
    rerenderCard = next =>
      rerender(
        <ProposalCard
          proposal={next}
          busy={false}
          artifacts={[]}
          revisions={{}}
          works={[]}
          poolModels={POOL_BOOTSTRAP.models}
          onRebind={handleRebind}
          onOpen={() => {}}
          onAccept={onAccept}
        />,
      );

    // 1) 首屏只读摘要：零下拉框，仅展示本提案实际涉及的视频与配音（不展示未涉及的图片）
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.getByText("本次生成模型")).toBeVisible();
    expect(screen.getByText("火山方舟 · Seedance 2.0")).toBeVisible();
    expect(screen.getByText("MiniMax · Speech 2.8 Turbo")).toBeVisible();
    expect(screen.getByText(/音色：温润男声 · 普通话/)).toBeVisible();
    expect(screen.queryByText("图片")).toBeNull();
    expect(screen.getByRole("button", { name: "使用默认模型并开始制作" })).toBeEnabled();

    // 2) 展开『调整模型』：由于 shot-1 无首帧图，整批切换到要求首帧图的 Colab LTX-2.5 选项应如实禁用并给出原因
    await userEvent.click(screen.getByRole("button", { name: "调整模型" }));
    const batchVideoSelect = screen.getByLabelText("整批视频模型") as HTMLSelectElement;
    const colabBatchOption = within(batchVideoSelect).getByRole("option", { name: /LTX-2\.5 Distilled/ }) as HTMLOptionElement;
    expect(colabBatchOption.disabled).toBe(true);
    expect(colabBatchOption.textContent).toContain("首帧");

    // 3) 将配音整批切换到 Edge 免费配音 → 自动重算报价，主按钮变为『按本次选择开始制作』并显示『方案原默认』与『恢复本方案默认』
    const batchSpeechSelect = screen.getByLabelText("选择本次配音模型");
    await userEvent.selectOptions(batchSpeechSelect, EDGE_SPEECH_BINDING.configurationRevisionId);
    await waitFor(() => expect(rebindCalls).toHaveLength(1));
    expect(rebindCalls[0]).toEqual([
      {
        operationId: "narration-1",
        model: EDGE_SPEECH_BINDING,
        voiceId: "zh-CN-XiaoxiaoNeural",
      },
    ]);
    expect(await screen.findByRole("button", { name: "按本次选择开始制作" })).toBeEnabled();
    expect(screen.getByText(/方案原默认：MiniMax · Speech 2\.8 Turbo/)).toBeVisible();
    expect(screen.getByRole("button", { name: "恢复本方案默认" })).toBeVisible();

    // 4) 在『查看制作范围』内将具备首帧图的『视频 2』（shot-2）单镜换为 Google Colab · LTX-2.5 Distilled
    const scopeSummary = screen.getByText(/查看制作范围 ·/);
    await userEvent.click(scopeSummary);
    const shot2Select = await screen.findByLabelText("更换 视频 2 的模型") as HTMLSelectElement;
    const shot2ColabOpt = within(shot2Select).getByRole("option", { name: /LTX-2\.5 Distilled/ }) as HTMLOptionElement;
    expect(shot2ColabOpt.disabled).toBe(false);
    await userEvent.selectOptions(shot2Select, COLAB_VIDEO_BINDING.configurationRevisionId);
    await waitFor(() => expect(rebindCalls).toHaveLength(2));
    expect(rebindCalls[1]).toEqual([{ operationId: "shot-2", model: COLAB_VIDEO_BINDING }]);

    // 收起『调整模型』后，单镜例外与 Colab CU 分开计费提示依然在首屏清晰常显！
    await userEvent.click(screen.getByRole("button", { name: "收起调整" }));
    expect(screen.getByText(/单镜例外：镜头 2 用 Google Colab · LTX-2\.5 Distilled/)).toBeVisible();
    expect(screen.getByText(/算力分开核算：含 1 镜 Google Colab 计算单元/)).toBeVisible();
  });

  it("MODEL_SELECTION_REQUIRED 待选模状态自动展开选择器并禁用确认按钮；换绑在途与网络失败绝不放行旧版本", async () => {
    const blocked = makePoolProposal({
      acceptanceBlocker: {
        code: "MODEL_SELECTION_REQUIRED",
        message: "当前视频尚未设置默认模型，请先在卡片中选择具体模型。",
        action: "select_model",
      },
    });
    let rejectPending!: (err: Error) => void;
    const onRebind = vi.fn(
      () =>
        new Promise<Proposal>((_resolve, reject) => {
          rejectPending = reject;
        }),
    );

    const onAccept = vi.fn();
    render(
      <ProposalCard
        proposal={blocked}
        busy={false}
        artifacts={[]}
        revisions={{}}
        works={[]}
        poolModels={POOL_BOOTSTRAP.models}
        onRebind={onRebind}
        onOpen={() => {}}
        onAccept={onAccept}
      />,
    );

    // 阻断态自动展开『调整模型』并禁用主按钮『请先选择模型』
    expect(screen.getByRole("button", { name: "请先选择模型" })).toBeDisabled();
    const speechSelect = screen.getByLabelText("选择本次配音模型");

    // 触发换绑但响应尚未返回 → 主按钮切换为『正在更新报价…』并保持禁用
    await userEvent.selectOptions(speechSelect, EDGE_SPEECH_BINDING.configurationRevisionId);
    expect(await screen.findByRole("button", { name: "正在更新报价…" })).toBeDisabled();

    rejectPending(new Error("报价重算网络中断"));
    expect(await screen.findByRole("alert")).toHaveTextContent("报价重算网络中断");
    expect(screen.getByRole("button", { name: "重试更新报价" })).toBeVisible();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("AgentWorkbench 输入栏底部提供轻量只读『当前配置默认』摘要与『模型配置』跳转，不塞可变下拉", async () => {
    class InertEventSource {
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", InertEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/bootstrap")) return Response.json(POOL_BOOTSTRAP);
        if (url.includes("/conversations")) return Response.json({ conversations: [], items: [], nextCursor: null });
        if (url.includes("/works")) return Response.json({ works: [], items: [], nextCursor: null });
        if (url.includes("/library/videos")) return Response.json({ items: [], nextCursor: null });
        if (url.endsWith("/skills")) return Response.json({ packages: [], skills: [] });
        return Response.json({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<AgentWorkbench />} />
        </Routes>
      </MemoryRouter>,
    );

    const bar = await screen.findByLabelText("当前配置默认模型");
    expect(bar.textContent).toContain("当前配置默认：");
    expect(bar.textContent).toContain("视频 火山方舟·Seedance 2.0");
    expect(bar.textContent).toContain("配音 MiniMax·Speech 2.8 Turbo");
    expect(within(bar).queryAllByRole("combobox")).toHaveLength(0);
    expect(within(bar).getByRole("button", { name: "模型配置" })).toBeVisible();
  });

  it("[P2-1 回归] 双镜头单改第 1 镜为 1:1 平局时：主选仍保持未单改原默认，单镜例外准确指向镜头 1，且整批操作不覆盖镜头 1", async () => {
    const base = makePoolProposal();
    const curSpec = base.spec as ProductionSpec;
    // 让第 1 镜具备首帧图并被单改为 Colab（card_selected），第 2 镜保持默认 Seedance（无首帧图）
    const shot1Overridden: Proposal = {
      ...base,
      revision: 2,
      digest: "digest-shot1-colab",
      spec: {
        ...curSpec,
        selectionSources: [
          { operationId: "shot-1", source: "card_selected" },
          { operationId: "shot-2", source: "default" },
          { operationId: "narration-1", source: "default" },
        ],
        operations: [
          {
            ...curSpec.operations[0]!,
            kind: "video",
            model: COLAB_VIDEO_BINDING,
            inputs: [
              { kind: "artifact_revision", artifactId: "art-frame", revisionId: "rev-frame", digest: "dig-frame" },
              { kind: "text", text: "第一镜带首帧单改 Colab" },
            ],
            parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "native", firstFrameSlot: 0 },
            quotePerAttempt: { currency: "CNY", amountMinor: 0 },
          },
          {
            ...curSpec.operations[1]!,
            kind: "video",
            model: ARK_VIDEO_BINDING,
            inputs: [{ kind: "text", text: "第二镜纯文本保持默认" }],
            parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
            quotePerAttempt: { currency: "CNY", amountMinor: 185 },
          },
          curSpec.operations[2]!,
        ],
      },
    };

    const onRebind = vi.fn(async () => shot1Overridden);
    render(
      <ProposalCard
        proposal={shot1Overridden}
        busy={false}
        artifacts={[]}
        revisions={{}}
        works={[]}
        poolModels={POOL_BOOTSTRAP.models}
        onRebind={onRebind}
        onOpen={() => {}}
        onAccept={() => {}}
      />,
    );

    expect(screen.getByText("主选：火山方舟 · Seedance 2.0")).toBeVisible();
    expect(screen.getByText("单镜例外：镜头 1 用 Google Colab · LTX-2.5 Distilled")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "调整模型" }));
    const batchVideoSelect = screen.getByLabelText("整批视频模型") as HTMLSelectElement;
    // 整批下拉当前值应指向主选 Seedance（代表未单改的 shot-2），而非刚单改的 Colab shot-1
    expect(batchVideoSelect.value).toBe(ARK_VIDEO_BINDING.configurationRevisionId);
  });
});
