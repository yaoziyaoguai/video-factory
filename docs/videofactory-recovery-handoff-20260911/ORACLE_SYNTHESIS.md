# 四批 Oracle Web 综合结论

主 Codex 对四次独立第 5 档结果做了交叉核对。本文件只保留共同根因、依赖顺序和阶段边界；详细证据以 `oracle/results/` 中各 transcript 为准。

## 总结

项目没有重建，也不需要推翻现有架构。当前混乱来自：多个 Agent 在一个大脏工作树中跨 B4/B5/C1/C2 同时修改，旧日志不断把局部绿测升级为阶段 ACCEPTED，后续又在不同快照上推翻。结果是核心能力大量存在，但跨层合同和测试没有同步收口。

四批都判定 `CHANGES_REQUIRED`，不等于四批从零开始：

- B4：10 个旧问题中 2 个具体机制已修，6 个部分修，2 个仍开放；新增 1 个 provider/model provenance 问题。
- B5：9 个旧问题中 4 个具体机制已修，4 个部分修，1 个开放；新增 7 个复用、审片和状态投影问题/风险。
- C1：11 个旧问题中 3 个具体机制已修，4 个部分修，4 个开放；归并为 4 个执行根因。
- C2：12 个旧问题中 3 个具体机制已修，5 个部分修，4 个开放；新增 8 个金额、可行性、恢复、编辑和 UI 问题。

## 五个共同根因

### R1. 同一业务对象有多套身份投影

表现：

- planning 的真实请求、checkpoint identity、stage compatibility、formal artifact reference 不完全一致。
- rank 只增加 artifact IDs/issues，没有把当前画面主体、动作和真实性要求形成真实排序输入。
- B5 的“可继承”“实际请求匹配”“依赖失效”使用不同判据。
- C1 的业务效果 digest、实际 Provider request digest、quality projection 和子授权 SpendPlan 不一致。
- C2 展示 quote 后，接受时仍可能重新计算出另一个金额或范围。

修复原则：每个边界先构造一份规范化、可验证的 authoritative projection，再由同一投影派生请求、digest、checkpoint、artifact、quote 和凭证。不能增加更多兼容 `if`。

### R2. 版本/授权检查没有贯穿到真正持锁提交点

表现：

- Studio 已解析 expected revision/version，但服务预检查后到 pipeline 持锁修改之间仍可能竞争。
- 客户端编辑草稿在保存时使用最新 props 的 revision/version，而不是打开编辑器时的基线。
- C1 读取 scope A 后，A 被 B supersede，仍可能派生 A 的授权草稿。
- C2 命令 receipt、grant 接受、run 保存和响应恢复尚未用稳定命令结果闭合。

修复原则：caller 观察到的版本、当前权威 head 和变更请求必须在同一现有 lease/CAS 边界重新验证。prepared 与 accepted 分开；历史命令重放返回历史结果和当前状态，不重复执行也不复活旧权限。

### R3. “保留字节、可复用、需补证、需重验、需重生成”没有成为显式状态

表现：

- 跨 run reference-derived media 转存后丢失 reference SHA 和 resolved request proof。
- note-only/无法定位反馈在“不全片返工”修复后变成空范围并被跳过。
- 证据不足与真正不合格容易落进相同素材替换路径。
- quote 的 `preservedWork` 从所有历史 artifact 推断，不代表仍可合法复用。

修复原则：B5 先建立通用分类和 `needs_scope`/`needs_evidence` 停顿，再决定失效闭包和唯一 create 集合。依赖闭包大小不等于购买数量。

### R4. 用户状态由旧 artifact 或局部字段推断，而非服务端权威命令状态

表现：

- planning stage 旧 artifact 存在会覆盖当前 running/failed/publication failure。
- joint 返工影响摘要看不到内部 script producer，错误显示为 0 次。
- C2 UI 一次点击 prepare+authorize，用户未先看见 quote；返回 run detail 被丢弃。
- pause flag-only 状态后端能恢复，前端却没有恢复入口。
- reload DTO 缺 active authorization、pending quote/funding、accepted command 和 pause projection。

修复原则：由 server 根据正式 artifact、checkpoint cursor、command receipt、active scope 和 intervention 生成一份 allowed-actions 投影；UI 不另建状态机、不猜内部状态。

### R5. 测试同时存在旧 fixture、弱断言和缺少真实边界的问题

表现：

- B4 四项 Studio 失败缺新的 revision/version，treatment 无 artifact 的断言已过时。
- B5 三项失败只看总调用次数，不能区分失效闭包、重验集合和 create 集合。
- C1 唯一红测使用旧 `intentDigest`，直接解释当前停住；但改 fixture 后仍有真实实现缺口。
- C2 fake 仍按旧 amendment 参数位置；组件测试反而固定“一次点击完成 prepare+authorize”的错误体验。

修复原则：先分类 test stale 与 product bug；测试真实 service/store/runner，只有外部 transport 使用 fake。断言业务身份、状态、金额、artifact/ledger 和 create/reconcile 次数，不只断言 HTTP 状态或“离开 awaiting”。

## 必须按顺序处理的依赖

1. **B4 先收口正式 planning truth。** B5 需要可靠的 current plan/artifact/provenance；C1/C2 需要可靠的 accepted plan digest。
2. **B5 再收口复用与返工语义。** C1 才能知道是 reuse、补证、重验还是新 create；C2 的“调整方案/保留成果”才有真实数据。
3. **C1 再收口权威消费。** C2 不能自己重算账本、差额、scope 或子授权。
4. **C2 最后连接用户确认和恢复。** UI 只能消费 C1 assessment 与 server-owned quote/funding 状态。

任何阶段不得在下游增加 workaround 以掩盖前置缺口。

## 各阶段必须关闭的核心问题

### B4

- caller revision/version 到持锁修改点。
- treatment/script/director/rank 的真实请求、兼容 identity 和实际 provider/model provenance。
- 当前 rank semantic intent 与 private inventory 的真实消费。
- 唯一 planning outputs projection。
- formal artifact 内部引用与当前 output version 闭包。
- 两个真实进程 crash window 和部分 prepared/registered 状态恢复。
- stage DTO 的 running/failed/accepted 真相。

### B5

- `needs_scope`，原反馈不丢且不默认全片。
- 逐母片的继承证明分类和统一 predicate。
- reference SHA/resolved digest/source run/version 在每代 ledger 保真。
- 未受影响 planning role 在新 rework run 中调用为 0。
- 共同不可变 review snapshot、实际 identity 碰撞的内外 checkpoint 恢复。
- findings 容量合同和真实 impact summary。

### C1

- strict committed authorization chain，损坏不是 absent。
- 当前 head、真实 plan、ledger 与派生/预留在一个 execution boundary。
- physical request ledger fold 对 alias 顺序不敏感，unknown/未结清保留占用。
- 统一 quality/intent projection 和 canonical serialization。
- 形成与原 exact matcher 完全一致的 bounded SpendPlan/config/child authorization。
- coverage 改为结构化 assessment，不吞 50 分、attempt、scope、quality 和证据原因。

### C2

- quote/funding 由 C1 的权威账本和当前目录/规格/质量产生。
- 只接受用户已经看见的同一 quote identity；金额严格为整数分。
- command receipt 在 crash、响应丢失和后续 supersede 后仍可幂等读取。
- funding 三动作、0 元 scope revision 和无新增媒体费用的内容确认。
- durable pause 在 UI、reload、每个 create/retry/backup 前一致生效。
- 编辑草稿绑定打开时版本；冲突保留草稿。
- 正式 typecheck、真实 service 测试和 1440/390 浏览器证据。

## 已确认不应回退的修复

- B4 seed 同 checkpoint 保存 retained provenance/compatibility。
- 新 derivative 使用 joint-v1；历史 run 不被默认迁移。
- B5 voice timing 能定位 joint plan，reuse 会失效 source review 并保留目标 cut 字段。
- old/new dependency closure 的固定点与显式 REUSE 边。
- planning issues 已进入 script/director producer payload。
- C1 grant 文件只有被 run 正式引用后才可成为 active。
- 金额不再做整元截断。
- retry/stale-resume 已接 scope continuation。
- C2 amendment 不再接受客户端 `additionalCents`，URL predecessor 已核对。
- quote opaque ID/run ownership、trusted actor 的 source-level 修复。
- NewRunDialog 的 duration range、预算意向和模板推荐已经存在。

执行者不得为了简化恢复旧行为、删除正式 treatment artifact、取消 expected revision、放宽 exact matcher 或恢复每请求人工审批。
