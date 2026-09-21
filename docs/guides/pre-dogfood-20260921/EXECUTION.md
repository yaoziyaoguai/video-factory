# Dogfood 前发布收尾执行包

## 目标与边界

交付最新可运行云端版本、清空旧制作列表、保留配置、提供可排错日志，随后停止，交由用户 dogfood。不新增供应商、不解决 Mac 出网、不做 NASA 长视频截取、不新增付费任务。个人开发只使用 main；保留既有唯一服务器 release 工作目录及其回滚机制。

NASA 已实测的 mobile 版本为 320×180，不能据此把手机短视频素材降到180p；优先合适短素材及满足最终裁剪的最小版本，未来再做按段读取。当前128MB视频上限保持。

## 依序执行

1. 核对本地/远端 HEAD、工作树、现有生产版本；保留所有用户改动，读取但不输出凭据。只提交产品代码、测试和相关文档，排除密钥、媒体、临时证据和原始咨询会话。
2. Flickr 完成现有接线：设置目录、导演能力、免费路由、Pipeline 参数、worker、CLI、署名；没 Key 不可用。采用时复核权限和许可，拒绝畸形地址，真实尺寸覆盖 API 声明。不因此改变收费生成路径。
3. 日志复用现有 run/node/command/request ID，输出模型排队/执行、素材搜索/物化/核验、进程与协议结果。仅允许状态、耗时、数量和身份，不记录 payload、prompt、凭据或签名 URL；Python stdout 保持一个 JSON，阶段日志走 stderr；Docker 10MB×3轮转。现有状态事件、付费回执继续作事实依据。
4. 行为回归、类型检查、正式构建、离仓 Broker 提取包、Python、依赖审计、shell/compose 配置全部通过才推进。真实付费 E2E 不属于此次冒烟。
5. 云端数据清理：持发布锁，确认 Broker idle 和没有执行中的 run；停 app/Broker 写入；完整备份 workspace（含所有媒体）、Broker 状态及卷外凭据配置。除源目录 tar compare 与 SHA-256 校验，还要解压到独立目录，核验内容、成员、权限、属主和链接。冻结27个旧run清单，逐项证明archive和27条production-start幂等响应均属于这些run，再将 runs/archive/idempotency 移到活跃工作区外的永久保留隔离目录。两个系列、独立选题、共享上传、声音试听缓存与旧run无确定归属，全部保留；与 settings/templates/budgets 一起核对摘要不变。清理后恢复Broker供部署探针读取，app保持停服，直到Actions完成。旧run内的生成/下载素材和报价账目随run归档；不直接删除 volume、不改 VPN、不触碰其他项目。
6. 旧“不确定配音”及所有旧账目保留在隔离备份中，不能称为未消费、已退款或已核销，也不重投任务。新环境只是不再列出旧制作历史。
7. 配置同步只补云端缺失的已配置素材/百炼参数；不覆盖现有非空 Key。用 SSH 私密流传输本地已登记的百炼音画模型，Broker 私有配置600、正确属主；不写入Git或日志。若云端已有冲突注册，停止核对，不覆盖。
8. 单次正常 push main，Actions verify/security → serialized deploy；取消被新提交替代的 CI，跳过过期 release。bundle按run/attempt隔离；服务器从fetch到回滚持同一把锁，拒绝回退到上次成功发布之前。checkout前捕获旧Compose，并以容器实际环境覆盖；失败回滚使用旧配置，独立恢复DeepSeek unit。停服时metadata备份使用独立只读挂载，不依赖docker exec。不强推、不削弱保护、不逐文件推送。
9. 部署后核对运行 SHA、app/Broker health、注册模型与缺配置状态、旧 run 为0、配置摘要、登录入口与保护接口。失败走原部署回滚，不临时绕开CI。结束时不开始 dogfood。

## 验收证据

- 正式路径 Flickr 测试、权限撤销/NC/下载/真实尺寸；缺 Key 的目录/导演行为。
- 日志脱敏、日志失败不影响业务、worker协议不被日志破坏、实际 Docker 提取的 Broker 模块可离仓导入。
- 完整测试命令与退出状态；每个失败都记录原因，重跑必须有修正依据。
- 清理前数量、归档位置、备份摘要与一致性检查、保留文件摘要、清理后数量。
- Git commit、Action run URL/结论、运行容器与 Broker 的新版本、零新增模型/付费媒体任务。

## 当前结果记录

见同目录 RESULT.md。Oracle 只提供建议，不扩大权限；其建议必须以当前源码与云端实况复核。
