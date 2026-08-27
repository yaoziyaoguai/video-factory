# Open-source Production Intelligence Review

Date: 2026-08-28

## Scope

本次不是按 README 复制功能，而是读取关键实现、测试、配置和许可证，判断哪些模式能改善 VideoFactory 的质量、成本和可编辑性。X 帖子只作为待验证线索，不能作为能力或收益证明。

## Source Baseline

| Project | Reviewed commit | License | Relevant implementation |
| --- | --- | --- | --- |
| [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | `0df0ef4ac2d7` | MIT | 素材 Provider、24h 搜索缓存、语音试听复用、字幕/BGM、可选 TwelveLabs |
| [WeMM-Embedding](https://github.com/Tencent/WeMM-Embedding) | `287b222b956f` | Tencent Apache-2.0-style repository license | 文本、图片、视频统一 embedding 与 Matryoshka 维度 |
| [shuohao-skills](https://github.com/eternityspring/shuohao-skills) | `4322897e6d2b` | Apache-2.0 | 分层 Skill、JSON 契约、deterministic validator、自测和可审查报告 |
| [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) | `b2a610bf6e8a` | Apache-2.0 | 镜头 recipe、动态预览、逐帧 QA、声音归因、剪映导出 |
| [Generative-Media-Skills](https://github.com/SamurAIGPT/Generative-Media-Skills) | `74df8cb76bb4` | MIT | 核心能力与垂直 workflow 分层、Skill 文档和脚本边界 |
| [ArcReel](https://github.com/ArcReel/ArcReel) | `44d22bfaa5e2` | AGPL-3.0 | Provider 配置、估算/实际成本、可编辑交付、剪映草稿 |
| [FireRed-OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) | `c9e945215586` | Apache-2.0 | Agent + Skills、节点干预、局部重做和预览 URL |

许可证只说明仓库代码边界，不自动覆盖仓库内的音乐、字体、模型权重、演示图、品牌素材或第三方 API 输出。

## Absorbed Now

### 1. Candidate-first asset workflow

来自 MoneyPrinterTurbo 的 Provider/fallback 思路和 video-shotcraft 的视觉预览纪律：

- 每镜图库候选从 3 个增加到最多 6 个，不增加 API 请求次数，只扩大同次响应。
- 节点展示缩略图、来源页、作者、授权提示、规格和当前采用项。
- 候选报告不保存 `download_url`，避免持久化临时签名地址。
- Pixabay 视频的 `picture_id` 不再被误当成可直接显示的 URL。

### 2. Searchable shot specifications

真实成片显示，编剧和导演已给出具体动作，但长达一整句的图库 query 仍会搜到“题材相近、动作不匹配”的素材。导演 Prompt Pack 升级为 `video-factory/director-v5`：

- 明确图库是检索而不是生成；
- 图库查询限制为 3 到 8 个英文概念，聚焦主体、动作和环境；
- 精确多步表演应选择生成式能力或改写镜头，不再假装免费图库能兑现。

### 3. Model creativity + deterministic gates

吸收 shuohao-skills 的核心分工：模型写创意数据，程序计算可确定规则。broker 现在会拒绝：

- 不连续的脚本场景编号；
- 重复的导演场景路由；
- 任一审片评分低于 60 却返回 `approve`；
- 仍有 warning/critical finding 却返回 `approve`。

### 4. Timeline-aware visual review

审片抽帧使用渲染 manifest 的逐镜时长，取 0.25 秒首屏和各镜头中点。对现有 27.976 秒成片实测，12 张样本均为有效内容帧，不再抽到白色转场；审片记录使用真实探测时长。

### 5. Skill Pack architecture

已有 broker task definitions 被正式定义为 Skill Pack：directive、task、rules、schema、deterministic evaluator、fixtures 和 runtime receipt。没有引入第二套工作流引擎。

## Already Present, No Duplicate Implementation

- Pexels、Pixabay、本地编辑素材及逐镜 fallback。
- 免费/付费混合路由和每个付费节点前的人工授权。
- Provider、model、API、prompt version、输入输出版本、耗时与成本回执。
- 节点输入输出编辑、下游失效、局部重跑和最终人工终审。
- MiniMax TTS 试听/方向配置、Codex 编剧/导演/审片、FFmpeg 技术质检。
- 模板、系列、热点三类生产入口和成本总览。

## Confirmed Extension Points, Not Enabled Yet

### Semantic asset ranking

MoneyPrinterTurbo 的 TwelveLabs adapter 和 WeMM-Embedding 都证明“先语义排名再下载”是正确方向。当前 ECS 4 核 8G 且禁止本地模型，因此不部署 WeMM 2B/4B/9B。保留 `AssetSemanticRanker` 接口，候选池先由用户审查；后续比较 Codex Vision、托管 WeMM 或其他多模态 API 的每镜成本和命中率。

### Reference-video grammar analysis

GLM 5.3 Flash + Seedance 的 X 案例可以转化为“有权参考的视频 -> 镜头语法分析 -> 新 Shot Spec”，但不能实现任意平台下载或一键仿拍。接入前需要权利确认、受支持的上传方式、真实 API 权限和可复现样例。

### Low-resolution generation + enhancement

[HitPaw Video Enhancer API](https://developer.hitpaw.com/enhance/video-enhancement) 是按秒/credits 的付费开发接口，页面上的免费体验不等于可用于无人值守批处理。它适合作为可选后处理 Provider；必须先 A/B 测试“低分辨率生成 + 增强”的总价、细节伪影和平台二次压缩效果。

### Seedance 2.5

[ByteDance Seedance 2.5](https://seed.bytedance.com/en/seedance2_5) 的官方产品页支持更长叙事、参考控制和编辑能力，但当前账户是否开放稳定 API、国内调用 endpoint、价格和内容条款仍需控制台实证。不能仅凭 X 演示宣称已接入。

## Deferred Or Rejected

| Candidate | Decision | Reason |
| --- | --- | --- |
| Coverr | 暂缓 | 需要 API key、可见归因；官方开发文档与许可页面的商业表述需在 UI 和法务边界上进一步确认 |
| MoneyPrinterTurbo bundled BGM/fonts | 不复制 | 仓库 MIT 不等于每个媒体文件 MIT；须逐项保存来源和授权 |
| TwelveLabs | 暂缓 | 是付费可选语义服务；已有 Codex 候选审查路径，需先比较收益 |
| WeMM local deployment | 拒绝 | 模型与依赖不适合 4 核 8G ECS，也违反不跑本地模型的约束 |
| Whisper large local subtitles | 拒绝 | 内存、磁盘和 CPU 成本不适合当前云服务器；优先 TTS 时间戳或云 API |
| VikPea “免费无限” | 拒绝该说法 | 官方开发 API 按 credits 计费，营销试用不等于生产免费额度 |
| ArcReel source reuse | 不复制 | AGPL-3.0 边界与现有架构不同；只吸收 Provider/成本/可编辑交付模式 |
| FireRed internal effects/assets | 不假设可用 | 公开仓库和内部素材能力并不等价 |
| Famous-director imitation | 拒绝直接命名模仿 | 使用抽象镜头语法和 craft profile，避免误导与风格挪用风险 |
| 十类垂直频道一次性上线 | 暂缓 | 先用账号数据验证模板；没有证据时扩功能只会增加维护面 |

## Next Evidence Needed

1. 对 20 至 50 个镜头做“API 首位候选 / Codex 视觉重排 / 人工选择”盲测，记录命中率与单镜成本。
2. 用 3 个真实模板验证首批 1 至 2 镜预览能否显著减少付费重做。
3. 为 BGM/SFX 建立逐文件 license manifest 后再接入声音设计库。
4. 取得 Seedance 2.5、Coverr 或增强 API 的真实控制台权限后，只做一次有预算上限的验收调用。
