# 素材库扩充调研与接入建议

查询日期：2026-09-20。由当前 Codex 直接读取官方资料、调用无需凭据的公共接口并核对当前源码；本轮未使用 Oracle Web。

> 后续实施更新（同日）：本文下述“当前/尚未实现”是实施前基线，不是最新状态。Coverr 缺口、Wikimedia 视频接线和 Pixabay 缓存已实现并进行回归；真实 Wikimedia 下载被本机到媒体域名的连接超时阻断，不能称完整验收。详见 [实施与验证记录](stock-source-implementation-20260920.md)。保留下文反例作为变更依据。

## 1. 结论与当前真实状态

1. **先完善 Coverr，再接 Wikimedia Commons 视频。** 前者已经接线，但署名展示和鉴权请求仍有缺口；后者不用申请 Key，真实接口已经返回可用的中国场景视频。
2. **付费视频优先评估 Freepik / Magnific。** 当前 Freepik 文档跳转到 Magnific，官方明确提供库存视频搜索、详情和下载接口。套餐是否包含 API 下载要以账号实际权益为准。
3. **国内优先继续核实摄图网、站酷海洛。** 项目旧记录已有 API 合作入口；本轮访问分别遇到 403、418，无法独立复证其最新认证、收费和个人申请条件。不能把“本轮无法读取”解释为“不存在 API”，也不能继续写成“已完成接入”。
4. **Flickr 可作第二梯队。** 官方 API 支持视频检索、许可筛选；视频下载地址、账号权限和可用率还没有真实账号证据。
5. **素材站数量不等于可用素材数量。** Videvo、Mazwai 本轮都跳转到 Freepik 视频页面，不应计成三家独立新库。Mixkit 等可保留人工下载来源，本轮未证实其公开自动下载 API。

本项目面向个人娱乐。不得把“允许商用”作为所有素材的统一准入条件；分别核对个人使用、改编、公开发布和署名要求。未知许可应显示待确认，而不是自动认定免费可用。

当前源码的自动来源是 Pexels、Pixabay、Unsplash、Coverr。前三者及 Coverr 的账号验证来自前序工作记录，本轮没有读取密钥或重新执行认证下载。Wikimedia 仍只有待实现测试，调度入口当前返回 `Unsupported asset provider: wikimedia`。其余本报告中的来源均未新增到产品。

## 2. 有官方接口证据的优先来源

以下配额是本轮读取的公开说明，不代表用户账号已经获批。公开 API、免费调用和免费素材是三件不同的事。

| 来源 | 内容与适用场景 | 接口 / 申请条件 | 费用与配额 | 本轮证据与优先级 |
|---|---|---|---|---|
| Wikimedia Commons（国际） | 视频、图片；城市、历史、自然、知识类补充 | MediaWiki 公共读接口，无 Key；按文件读取作者、许可与视频变体 | 公共读接口免费；遵守请求规范，不能无限扫描 | API 真实返回成功；**新增首选，先只接视频** |
| Coverr（国际） | 原生库存视频；也有 AI 内容和音乐，本项目目前仅视频 | 自助申请 Demo Key；REST 使用 `Authorization: Bearer` | Demo 50 次/小时；开发者页面列 Production 2,000 次/小时，升级关联付费计划 | 接线已存在；官方文档核实；**先补齐现有缺口** |
| Freepik / Magnific（西班牙） | 库存视频、图片等；本轮只评估库存，不增加生成模型 | 当前文档为 `https://api.magnific.com`，请求头 `x-magnific-api-key`；需账号实际开通 | Premium / Premium+ / Pro 的 API 库存下载不扣积分，但每天最多 100 次；Business / Enterprise 无日上限、逐次扣积分。不能把前者叫完全免费 | 官方搜索 / 下载 / 定价 / 认证文档可读；**付费候选首选，待凭据与权益核实** |
| Flickr（国际） | 摄影作品及用户上传视频；可补中国场景 | 应用 API Key；`flickr.photos.search` 支持媒体和许可筛选；个人/非商用项目应申请相应 Key | 本轮未核实当前额度；许可逐条处理，不把全部公开作品当免费素材 | 搜索与 Key 官方文档 200；**第二梯队，尚未证明完整视频下载** |
| Pixabay（国际，已有） | 图片、视频 | API Key | 官方默认 100 次/60 秒；要求请求缓存 24 小时、禁止系统性批量下载 | 官方文档 200；继续使用，补查缓存合同 |
| Unsplash（国际，已有） | 图片，不提供库存视频接口 | Application Access Key；公开搜索不要求最终用户 OAuth | Demo / 提额按开发者应用权益；本轮不重报未核实数字 | 官方文档 200；需摄影师和 Unsplash 署名、预览 CDN 热链、采用时下载统计 |
| Pexels（国际，已有） | 图片、视频 | 既有 API Key | 本轮官方文档触发 403，未重新核实额度 | 维持现有接入；此前真实验证不等于本轮重验 |

Freepik/Magnific 官方速率页与下载日配额分别约束不同层面。不要用“无通用 RPD 上限”推导“无限库存下载”，以库存专门定价条款和实际账号为准。

Coverr 的通用许可写明商业/非商业使用通常不要求署名，但 API 文档另要求可点击 logo；两者不能混为同一合同。API 首页还残留较含糊的商业使用表述，与当前开发者页的商业授权说明不完全一致。个人娱乐使用不因此被排除，若以后把 VideoFactory 作为对外付费素材服务，应另向平台核实。

## 3. 国内与商务合作候选

| 来源 | 价值 / 目标内容 | 官方入口与本轮访问证据 | 结论与下一项必要信息 |
|---|---|---|---|
| 摄图网（中国） | 中文图片、视频；本土生活和城市素材 | `https://699pic.com/vip/apiDoc` 返回 403；该地址来自项目既有记录 | 合作型 API 候选，**本轮未复证**。需最新文档、个人可否申请、搜索/下载价格和授权书样例 |
| 站酷海洛（中国） | 图片、视频；中文检索 | `https://open.hellorf.com/` 返回 418/WAF | 合作型 API 候选，**本轮未复证**。需账号适用范围、正式/测试凭据和计价规则 |
| 视觉中国（中国） | 创意及新闻/纪实图片、视频 | `https://www.vcg.com/` 返回 403；未取得可读官方 API 合同 | 需商务确认；编辑类授权不等同任意改编权。不要预先创建虚构配置项 |
| 光厂 / VJshi（中国） | 中国场景视频、航拍、短片；存在官网免费视频入口 | `https://www.vjshi.com/shipin/free/` 返回人机验证页；未取得公开 API 文档 | 可列人工获取候选。是否开放正式合作 API、免费栏目逐条许可待确认 |
| 包图网（中国） | 图片、视频、模板 | `https://ibaotu.com/` 返回 403 | 未证实公开 API；普通会员不能直接视为 API 凭据 |
| 爱给网（中国） | 视频、音效等创作素材候选 | `https://www.aigei.com/` 返回 403 | 未证实公开 API和当前许可；保留人工来源候选，暂不接自动下载 |
| 新片场（中国） | 作品和素材线索 | `https://www.xinpianchang.com/` 返回 403 | 作品展示不等于素材授权；本轮未证实正式可采购 API |
| Adobe Stock（国际） | 库存图片、视频、插画 | 官方 API 与商务 FAQ 可读 | 当前页面顶部明确限 Stock Enterprise / Adobe Affiliates；FAQ 下方仍有较宽泛旧说明，不能据此认为个人已开放。API 本身免费不代表授权下载免费 |
| Getty Images / iStock（国际） | 视频、图片、编辑与创意素材 | 官方技术文档明确 v3 API、`api-key`，高权限操作需 access token | 官方要求联系账号代表并关联许可协议；不适合当前免费优先阶段立即接 |
| Shutterstock、Storyblocks、Pond5、MotionElements（国际） | 付费视频与图片候选 | 本轮相关开发者/API入口分别遇到 403、403、超时、超时 | 列待核实，不能据网站套餐推断自动采购权、免费额度或接口合同 |

国内资料缺口是访问/商务条件尚未核实，不是“不提供国内素材”的产品决定。本轮没有绕过人机验证，也没有用抓取网站内部接口代替正式 API。

商务沟通只需要一次收齐六项：个人能否申请、正式 API 文档、测试凭据、搜索与下载计费、重复下载/授权查询机制、个人剪辑与公开视频的授权范围。无需先购买普通会员尝试碰运气。

## 4. 网页下载来源与重复品牌

- **Mixkit**：官方许可页明确分 `Stock Video Free License` 与 `Stock Video Restricted License`。本轮未找到可核实的公开检索/下载 API；限制版许可不能一概当作个人娱乐禁用，应逐条读取。保留人工下载再导入的使用方式。
- **Videezy / Vecteezy**：官方页面本轮返回 403；API 和当前许可证未复证。不能依据第三方目录把它们写成已接入。
- **Dareful / Life of Vids**：分别访问被阻断、超时；保留候选，暂不对当前许可或 API 作肯定承诺。
- **Videvo / Mazwai**：本轮都重定向到 `https://www.freepik.com/videos`；按同一个候选来源处理，避免虚增库存来源数。
- **Europeana / Openverse**：本轮文档分别被拦截或超时，未完成接口复核；不进入本次最小实施范围。

## 5. Wikimedia 真实接口证据与最小实现合同

实际调用 `https://commons.wikimedia.org/w/api.php`，参数包含：

```text
action=query
generator=search
gsrsearch=<query> filetype:video
gsrnamespace=6
gsrlimit=3
prop=videoinfo|imageinfo
viprop=url|size|mime|mediatype|derivatives|extmetadata
iiprop=url
iiurlwidth=640
format=json
formatversion=2
```

无 Key 调用成功，返回 `mediatype=VIDEO`、duration、size、derivatives、Artist、LicenseShortName、LicenseUrl、AttributionRequired 等信息。缩略图可能使用 `thumb.wikimedia.org`，视频使用 `upload.wikimedia.org`，不能仅凭旧示例认定缩略图也在 upload 域名。

本轮只读取元数据，未下载整段媒体，未支付费用。

| 查询 / 文件 | 接口结果 | 对实现的影响 |
|---|---|---|
| `Shanghai` / pageid 179149132，上海火车站5号站台 | 10.333 秒、CC BY 4.0；原文件 29,794,926 bytes；1080p derivative 估算 5,377,417 bytes | 能找到中国场景且不必降低清晰度；应选合适 derivative，不直接拉原文件 |
| `Shanghai` / pageid 151257813，高铁到上海 | 1,221 秒、原文件约 4.4GB；最低变体也估算约 84.7MB | 当前 12MB 下载上限下不可直接采用；在下载前过滤 |
| `city night` / pageid 143041724，德黑兰夜行 | 1,337 秒、原文件约 2.0GB；元数据包含 `License review needed (video)` | 有许可字符串仍可能存在待审标记；不能把元数据当平台担保 |
| `China landscape` | 返回了访谈、制造业与长途步行视频 | 搜索命中不证明镜头语义合适；必须沿用现有素材选择和审查 |

样本复核入口：`https://commons.wikimedia.org/w/index.php?curid=179149132`（其余可替换 pageid）。样本只是调研证据，不能写入题材、镜头或 Provider 特判。

最小实现要求：

1. 注册 `wikimedia-stock-v1`，只声明视频能力。公开读接口不需要 API Key，不能套用“有 Key 才可用”的探针；是否连通与是否已安装是两个状态。
2. 只接结构完整、有限正数时长/尺寸的 `VIDEO` 候选。按 pageid 去重，保留文件页、作者、具体许可及许可 URL；清理元数据 HTML，不能直接插入页面。
3. CC0、可核实的公有领域、CC BY 可按相应条件自动选择；CC BY-SA 必须保留其同方式共享要求，让用户能理解采用条件。缺许可、待审/争议、未知多重许可不能自动当可用。不要仅匹配名称中一个 `CC` 就放行。
4. 从 derivative 选满足当前镜头质量要求的版本，估算 `bandwidth × duration / 8` 字节。估算仅用于预筛；真实下载仍检查 Content-Length、流式大小和网络目标。不能为了凑 12MB 直接选 240p 牺牲质量；不满足要求就换候选或如实提示。
5. 当前下载上限为 **12,000,000 bytes**，代码有 45 秒流式检查及 60 秒单次网络读取超时。不能宣称整个请求严格在 45 秒终止；这次不扩大超时架构。
6. 公共候选只给安全缩略图、原始文件页、作者与许可；正式媒体 URL 留在私有候选。沿用现有下载器的 DNS/IP、重定向、MIME 和体积保护，不另造下载路径。
7. 搜索分页有界；无合适结果、429、网络错误分别如实记录。不得静默切换为付费生成。
8. 生产接线复用现有 stock provider：Python 搜索与 ID 映射、worker provenance、Studio catalog/worker capabilities、pipeline provider allowlist、前端名称与署名显示。不要只写一个搜索函数就报告正式接入。
9. 必要验证：无 Key 可查询、图片/音频拒绝、缺许可/作者、HTML 作者字段、BY-SA 条件、超大原片但合适 derivative、所有版本过大、低清版本不合格、NaN/Infinity、无结果、429、SSRF/重定向、公共数据无私有 URL、重启后保留来源、正式组合层可选择。
10. 最后做一次小体积真实下载和 `ffprobe` 媒体检查，证实编码可进入渲染流程；搜索元数据成功不能替代这一项。

## 6. 已有实现核对：扩充前需要处理的问题

本节是局部源码核查与离线反例，不是完整产品安全审计，也没有在本轮实施修复。

### COV-01：Coverr API 署名展示缺口

官方 API 文档要求使用可点击的 Coverr logo。当前 `apps/studio/src/client` 对 Coverr 的直接匹配只有 `presentation.ts` 名称；`NodeWorkspace.tsx` 的素材署名特化和 `ResourcesPage.tsx` 的作者组件只处理 Unsplash，未见 Coverr logo。

最小修正：在 Coverr 候选与已采用素材的用户可见位置展示官方来源标识及链接；保留作者和文件来源，不增加制作审批节点。应测试呈现与安全链接，而不是仅断言存在 `Coverr` 字符串。

### COV-02：鉴权搜索请求默认跟随跳转

`src/video_factory/stock_assets.py:search_coverr` 将 Bearer 请求交给默认 `fetch_json`，它使用 `urllib.request.urlopen`。同文件已有 Unsplash 使用的 `NoProviderRedirect`。

本轮用虚构 Bearer 值离线验证 Python 默认 `HTTPRedirectHandler.redirect_request`：跨域 302 后仍保留 Authorization，结果为 true。没有真实密钥泄露证据，但当前请求策略存在不必要的泄露路径。

最小修正：复用现有禁止跳转的鉴权 opener；测试 301/302/307/308 不向另一个 host 发出带凭据请求。素材 CDN 的受控下载跳转与携带 API 凭据的搜索跳转不能混用。

### COV-03：缩略图签名查询可进入公开数据

`coverr_url` 只检查协议、域名和账号/端口，允许查询参数；`candidate_to_public_dict` 原样导出 `preview_url`。

本轮虚构响应将 `thumbnail` 设置为 `https://cdn.coverr.co/thumb.jpg?token=research-dummy`，通过 `search_stock_assets` 后公开 DTO 仍含 `token=`；正式 `download_url` 则已正确隐藏。现有测试只覆盖签名下载链接，没覆盖签名缩略图。

最小修正：公共预览不得携带凭据或签名参数；采用无签名安全缩略图，必要时使用现有本地受控预览机制。不能简单删签名后输出一个已失效的预览 URL。新测试同时检查候选、采用产物与导出路径。

### COV-04：“搜索少”可能也来自请求和过滤方式

Coverr 当前只取 `page_size=limit` 的第一页，然后再排除 AI/付费条目；因此一页存在其他类别时，最终免费候选会少于用户期望数量。声明“竖屏筛选”的 Provider 文案也没有对应的 Coverr 查询参数或归一化筛选证据。

建议：按接口合同做有限额的候选补齐，并让横竖屏提示反映实际行为。保持总请求预算，遇 429 不反复重试。这个因素影响候选数量，但本轮没有证据说它就是全部“素材太少”的根因。

### EXIST-01：Pixabay 24 小时请求缓存尚缺实现证据

官方要求 API 请求缓存 24 小时。当前 Python 搜索直接 `fetch_json`，在素材搜索/worker 路径仅找到许可文案里的缓存说明；私有候选清单的单次复用不自动等于跨任务 24 小时查询缓存。

建议在明确真实请求边界后补一个小型、按 Provider 与完整查询参数分隔的持久缓存，复用现有本地存储模式；覆盖过期、并发相同查询、失败不缓存、账号隔离且不把 Key 写进文件名。此需求不需要 Redis 或新增数据库服务。

### 已确认存在的保护，不应重写

- Coverr 使用官方 `mp4_download`；官方说明经该地址正式下载不必额外重复上报。只有预取/热链采用路线才另行考虑官方统计规则，避免重复计数。
- `candidate_to_public_dict` 不导出正式下载字段；下载仍走现有公共网络地址和流式体积检查。
- `search_coverr` 已过滤 `is_ai_generated=true` / `is_premium=true`，但还需要核对字段缺失/类型异常的协议行为，不能用 `bool()` 推断所有异常值。
- 搜索成功、Key 已配置、账号还有配额、视频能下载和成片可渲染应分别记录。

## 7. 建议执行顺序与验收

| 顺序 | 范围 | 完成证据 |
|---|---|---|
| 1 | 修 Coverr 的 COV-01～03，澄清 COV-04；核对 Pixabay 缓存边界 | 先重现再修复；离线合同与 UI 聚焦测试通过；现有 Unsplash/Pexels/Pixabay 不回归 |
| 2 | 实现 Wikimedia 的上述最小合同 | 新 Provider 从 catalog 到 Python 全链识别；不需要 Key；可用/不可用候选原因清楚 |
| 3 | 免费来源一次集成验证 | 有界搜索、实际下载一条小视频、真实 ffprobe/本地素材预览、作者许可保留；没有现金消费或隐式生成 |
| 4 | 用户愿意配置时再接 Freepik/Magnific | 先确认 API Key 与套餐权益；搜索不当作购买；下载日配额/积分按账号区别；未知购买结果不自动重买 |
| 5 | 国内 API 商务条件落实后接一家 | 以摄图/海洛中最先取得真实文档和测试账号的一家为先；报价、授权凭证和下载幂等均可验证 |
| 6 | Flickr / 其他手动来源 | Flickr 先验证所需视频下载权限；网页来源保留人工选择和本地导入，避免增加大量未就绪 Provider |

付费库存也可能比某次生成更贵。显示实际报价/套餐消耗后由用户授权，不把“库存”直接等同“便宜”或“免费”。仍复用原报价与授权流程，不增加第二套账本或制作工作流。

## 8. 官方来源与核查限制

- Coverr 开发者与额度：https://coverr.co/developers
- Coverr API 署名：https://api.coverr.co/docs/
- Coverr 鉴权：https://api.coverr.co/docs/auth/
- Coverr 搜索/下载统计：https://api.coverr.co/docs/videos/
- Coverr 通用许可：https://coverr.co/license
- Wikimedia API：https://commons.wikimedia.org/w/api.php
- Wikimedia 再使用要求：https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia
- Freepik 文档重定向来源：https://docs.freepik.com/
- Magnific 库存视频：https://docs.magnific.com/api-reference/videos/videos-api
- Magnific 搜索：https://docs.magnific.com/api-reference/videos/get-all-videos-by-order
- Magnific 下载：https://docs.magnific.com/api-reference/videos/download-an-video
- Magnific 套餐与库存日配额：https://docs.magnific.com/pricing
- Magnific 速率限制：https://docs.magnific.com/ratelimits
- Magnific API 条款：https://www.magnific.com/legal/terms-of-use#api-services
- Flickr 搜索：https://www.flickr.com/services/api/flickr.photos.search.html
- Flickr Key 申请说明：https://www.flickr.com/services/api/misc.api_keys.html
- Pixabay API：https://pixabay.com/api/docs/
- Unsplash API：https://unsplash.com/documentation
- Adobe API 商务 FAQ：https://developer.adobe.com/stock/docs/faq/stock-api-business-faq/
- Getty 技术文档：https://developer.gettyimages.com/docs/
- Mixkit 许可分类：https://mixkit.co/license/

本轮访问失败的站点见候选表；未将无关搜索结果或第三方博客作为官方证据。网页控制工具也未能启动，因此没有绕过验证补造浏览器截图。国内 API 的真实合作条件仍是主要未核实项。

代码检查使用既有 Graphify 索引定位后直接阅读当前源码；图只作导航。离线反例已证明 COV-02、COV-03 和 Wikimedia 尚未接入；公共 API 已证明元数据可查询。未运行全量编译、未做真实成片 E2E、未重新读取账号 Key、未购买、未提交或推送。此报告是接入决策与修正依据，不能代替后续实现验收。
