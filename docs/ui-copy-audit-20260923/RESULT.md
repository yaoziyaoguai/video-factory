# 界面文案审计执行结果

来源：本目录 `ORACLE_TRANSCRIPT.md`（Oracle Web，5/5 档）与 `EXECUTION_PLAN.md`。本轮仅修改用户可见的系统文案、可访问名称及显示投影；没有修改费用算法、授权范围、模型调用、人工确认或发布处理器。原有工作树改动保留。

## 逐项状态

| 条目 | 状态 | 结果或边界 |
| --- | --- | --- |
| COPY-01 | CONTRACT_VERIFIED_FIXED | 新建页按所选画面、声音及订阅计费方式分别说明；不再把全片写作免费或逐笔确认。 |
| COPY-02 | CONFIRMED_FIXED | 费用卡常驻显示金额性质；历史授权额不冒充当前余额。 |
| COPY-03 | CONTRACT_VERIFIED_FIXED | 付费确认写明本次最高授权额与授权范围内有限修复。 |
| COPY-04 | CONTRACT_VERIFIED_FIXED | 配音未知结果说明上一笔是否扣费未明、新任务可能再次计费；原任务查询不宣称原任务免费。 |
| COPY-05 | CONTRACT_VERIFIED_FIXED | 保存阶段模型只更新配置，后续继续制作才调用；按钮与说明已对齐。 |
| COPY-06 | CONFIRMED_FIXED | 编辑区与模型自由文本保留原文；只在固定系统标签作可读化。 |
| COPY-07 | CONFIRMED_FIXED | 纯诊断失败不留空白；未知原因如实标明没有可读原因。 |
| COPY-08 | CONFIRMED_FIXED | 停止、等待用户和已完成阶段不再称“正在生成”；轮次按真实上限显示。 |
| COPY-09 | CONTRACT_VERIFIED_FIXED | 通用失败不再无条件引导重试或重新创建；配音未知结果指向原任务查询／账单核对。各恢复动作权限未改。 |
| COPY-10 | CONTRACT_VERIFIED_FIXED | 审片质量意见不再一律写“必须修改”；费用和来源硬限制保持原样。 |
| COPY-11 | CONFIRMED_FIXED | 未收录的服务／模型保留可区分的标识；已在服务目录中的名称优先显示目录名称。 |
| COPY-12 | CONFIRMED_FIXED | 未知选题来源和未知推理参数不冒充已知值。 |
| COPY-13 | CONFIRMED_FIXED | 选题建议不再叫准入或开工门槛；人工核验要求仍保留。 |
| COPY-14 | CONTRACT_PENDING | 已修正视觉审片缺失时的首版例外说明；返工“必改”条目缺少可靠原因分类字段，本轮不凭文本推断可取消权限。 |
| COPY-15 | CONFIRMED_FIXED | 导览说明所有关键人工停点，不再声称只在终审操作或固定九步。 |
| COPY-16 | CONFIRMED_FIXED | 仅存文件路径时不冒充已核验上游产物。 |
| COPY-17 | CONFIRMED_FIXED | 候选和字段截断可展开；展开不触发下载或改变选择。 |
| COPY-18 | CONTRACT_VERIFIED_FIXED | 素材可复用状态附授权范围说明；“无待办”限定在已读取记录及统计范围。确认动作不冒充跨作品授权。 |
| COPY-19 | CONTRACT_VERIFIED_FIXED | 根据目标平台实际模式区分提交审核与导出发布包；结果不写成“已发布”。 |
| COPY-20 | CONFIRMED_FIXED | 未知步骤与字段保留标识，不静默吞掉区别。 |
| COPY-21 | CONFIRMED_FIXED | 产物字段按上下文显示，不把同名字段固定解释成错误业务含义。 |
| COPY-22 | CONTRACT_VERIFIED_FIXED | 已确认 `Ms` 字段按毫秒显示为秒；无法证实的语速单位标为未记录；已确认 [0,1] 的视觉审片置信度仅在有效范围内显示百分比。 |
| COPY-23 | CONFIRMED_FIXED | 缺失真实镜头编号不再用数组序号冒充。 |
| COPY-24 | CONTRACT_VERIFIED_FIXED | 素材链接读屏名称包含素材对象；候选来源链接包含镜头、候选及来源，未知镜头不编造编号。 |
| COPY-25 | CONFIRMED_FIXED | 模板页与卡片明确当前仅为资料；“发布模板”改为“保存正式版”，不暗示影响新制作。 |
| COPY-26 | CONFIRMED_FIXED | 指定固定文案中的 Provider/Broker/合同校验等技术术语改成用户可理解的说明；技术原文和诊断未全局改写。 |
| COPY-27 | CONFIRMED_FIXED | 桌面与移动导航同名；案例空态不依赖“左侧”。 |
| COPY-28 | CONFIRMED_FIXED | 报告质量复核、模型对成片的意见、人的风险接受分别标明主体与动作。 |

## 验证边界

- `npm exec --workspace @video-factory/studio -- vitest run --reporter=dot`：27 文件、520/520 通过，exit 0。
- `npm run typecheck --workspace @video-factory/studio`：exit 0。
- `npm run build --workspace @video-factory/studio`：exit 0；Vite 仅有大 chunk 提示。
- `git diff --check`：exit 0。
- `npm run test --workspace @video-factory/studio`：**未通过**。组件段 520/520 通过；随后 `text-task-production-recovery.test.ts` 的真实 socket 恢复用例出现 `treatmentCounter.calls` 期望 1、实际 0，以及一条 300 秒超时。其余长测因已有失败且继续等待无助于本轮文案判断而中断；完整服务端套件不能记为通过。本轮没有修改该测试或 ProductionPipeline/Broker 执行路径，不能据此断言根因或把它列为本轮已修复。
- 静态清单覆盖 53 个客户端 TS/TSX 文件；Oracle 审读不等于所有运行时条件分支都已出现。
- 本轮未启动真实模型、付费服务或生产环境；没有浏览器全站逐页人工走查。动态旧记录、不同服务商账单与发布平台实际返回仍需运行时复验。
- COPY-14 的返工原因分类需要明确结构化合同，不能仅为了换文案放宽锁定。该项保留 `CONTRACT_PENDING`。
