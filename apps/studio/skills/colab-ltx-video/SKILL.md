---
name: colab-ltx-video
description: 使用 Google Colab 上的 LTX-2.5 蒸馏版（720p 5 秒首帧图生有声视频）编写连续运镜提示词、核对首帧与参数，并经 Frame 提案确认流生成视频。
---

# Colab LTX-2.5 首帧生视频技能

当用户在会话中选择 `colab-ltx-video` 技能，或在对话中明确要求用 Google Colab / LTX-2.5 生成视频、撰写 LTX 镜头提示词时启用本技能。日常非视频闲聊或用户明确指定其他视频厂商时不主动套用。

## 真实能力核对与厂商边界（必须遵守）

1. 先读取本回合 `[frame-current-state]` 中的 `mediaModels` 与 `productionAvailable`：
   - 查找 `kind === "video"` 且 `binding.providerId === "colab"`（型号 `Lightricks/LTX-2.5-distilled`）的可用条目。
   - 即使其他厂商（如火山方舟 Seedance、MiniMax、阿里万相）是当前全局默认视频模型，只要 `mediaModels` 中存在已启用的 `providerId: "colab"` 条目，本次 `prepare_production` 就必须绑定该 `colab` 条目，无需改动全局默认。
2. **严禁暗自替换其他厂商**：
   - 当用户选用本技能或明确点名 Colab / LTX-2.5，而当前 `mediaModels` 中**没有** `providerId === "colab"` 条目时（例如尚未添加连接、连接已停用或未配置凭据），**绝对不能偷偷换成 Ark、MiniMax、万相等其他厂商模型提交提案**。
   - 此时应如实说明当前尚未启用 Google Colab（LTX-2.5），指引用户前往「模型配置 → 连接配置」添加或开启 `Google Colab (LTX-2.5)` 连接（若宿主机已完成授权，API Key 可直接填非敏感占位值 `host` 复用宿主凭据，无需重复提供 HF Token；并勾选启用 `Lightricks/LTX-2.5-distilled`）；同时可列出 `mediaModels` 中当前真实已启用的其他视频模型供用户显式选择，在用户明确改选前不创建替代提案。
3. **宿主隔离与提案确认门**：
   - 不在对话或容器内调用任何宿主命令行、脚本或凭据；一切算力生成仅通过 `prepare_production` 创建待确认提案，由用户点击提案卡片「确认制作」后交后台 `ProductionWorker` 执行并正式入库。

## 站内可受理的冻结输入与参数规格

- **必需单张首帧图（`firstFrameSlot`）**：当前仅支持**一张冻结首帧图 + 一份镜头提示词**（不支持纯文生视频、尾帧 `lastFrameSlot` 或多张参考图 `referenceImageSlots`）。缺少已上传图片或已认可的分镜/场景首帧图时，先引导用户上传或先产出分镜首帧草稿并获得认可，不构造缺首帧提案。
- **固定分辨率与固定时长**：站内已核实可受理规格为 **`resolution: "720p"`**（1280×720 或 720×1280）且 **`durationSeconds: 5`**（固定 `5` 秒）。`1080p`、`10` 秒或其他时长/分辨率当前不在网页可受理范围内，不得当作可用提案提交；若用户要求更长时长或更高分辨率，如实说明当前 `720p / 5 秒` 能力边界，建议拆分为多个 `5` 秒镜头后在同一次提案中由本地 `render` 拼接，或请用户确认调整。
- **画幅与声音**：`aspectRatio` 仅支持 `"16:9"` 或 `"9:16"`（不支持 `"1:1"`）；`audioMode` 支持 `"native"`（生成同步环境音画）或 `"none"`（无声画面，供后续混入独立配音或配乐）。
- **费用口径**：消耗 Google Colab 账户计算单元（`CU`），Frame 不发生人民币 API 扣费；仅含 Colab 视频与本地 `render` 时，`maxSpend` 传 `{ "currency": "CNY", "amountMinor": 0 }`。

## LTX-2.5 5 秒镜头提示词写法

首帧图已固定人物外观、场景构图与初始光影；提示词聚焦**首帧之后 5 秒内的单一连续运动与声音**，避免重复堆砌静态背景描述：

1. **主体连续动作**：明确人物或物体在 5 秒单镜头内自然连贯的一个动作。
2. **单一镜头运动**：每镜只给一种清晰运镜（如缓慢前推、平稳横移、固定机位浅景深呼吸感），不在同一 5 秒镜头内切换机位。
3. **物理与光影动态**：补充水波、晨雾、衣角随风、光斑移动等连续物理细节。
4. **原生声音（`audioMode: "native"` 时）**：用一句话点明匹配画面的环境声或动作声效；若已有独立旁白或配乐方案，可将镜头设为 `"none"` 或在 `mixed_concat` 中统一控制原声增益。

用户仅索要 LTX Prompt 时，直接在聊天中给出完整、可复制的提示词，不自动创建作品或制作提案。

## 正式制作与同批多镜热复用

1. 正式视频创作沿用 `start_work` → `deliver_artifacts`（`reviewGroups`）→ 用户 `confirm_review` 认可方案/分镜依据。
2. 用户明确委托制作后，调用一次 `prepare_production`：若同一作品包含多个 `5` 秒 Colab 镜头，将全部 Colab `video` 操作与最终本地 `render` 合成放入同一份提案的 `operations` 中（后台会自动在同一批次热复用 GPU 内存中的 LTX-2.5 模型，末镜完成后自动释放实例）。
3. 提案就绪后，提示用户点击该提案的「确认制作」启动生成，停下来等待用户确认。
