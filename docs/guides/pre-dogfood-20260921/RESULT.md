# 发布结果与执行记录

状态：执行中，尚未推送或清理云端数据。

## 基线

- 本地/远端 main 和服务器 release 均 86ebd37。服务器基础仓库为更早的5f12009且有既存stock_assets.py修改；不覆盖它，由既有release worktree发布。
- 旧工作区27个run：21 failed、4 rejected、2 paused；其中一条9月3日配音结果不确定。Broker active=0/queued=0。旧run和账目必须可恢复保留。
- 本地与云端配置差异：云端未登记已在本地配置的百炼音画审片，且部分素材/百炼Key未同步。不会将“代码部署”误报为配置一致。

## 修复与验证

- Flickr既有6项测试最初5通过/1失败（worker未注册）；新增畸形URL用例又证实ValueError。修复接线、地址检查、实际文件尺寸后7/7。
- Python阶段日志3项行为测试；TS日志白名单、故障隔离及实际子进程协议/错误脱敏测试通过。
- 第一轮npm全量因系统Python缺Pillow失败；改用项目已有venv的PATH后不再出现，不安装另一套依赖。
- 新增Flickr目录测试一度错误要求ready项仍显示配置提示，现按既有UI合同只检查未配置状态的提示。
- 全量：TS 934 pass/1 opt-in E2E skip；Broker262/262；Studio前端465/465、后端604/604；Python199/199。typecheck/build通过。
- 宿主Broker精简包验证发现新日志引用根入口会缺index.js；已改为独立diagnostics子路径并进入Docker提取包。新增离仓回归复现后通过，package4/4。
- 默认npm镜像无audit接口（404 NOT_IMPLEMENTED），明确切官方registry复核为0漏洞。
- 本地Docker daemon未运行且docker compose插件入口不可用，不能声称本地完整容器构建通过；Linux构建/容器smoke由现有Actions验证，不绕过。
- git diff --check通过；未发起付费任务。

## 咨询

Oracle会话 vf-pre-dogfood-clean-release-20260921 已完成：第5档、GPT-5.6 Sol，正文完整捕获；精确临时Chrome已结束、临时profile已删除。没有发起第二轮咨询。

附件已由用户补充：EXECUTION-PACK.md、execution-evidence.template.yaml、review-verification.json，三份全文已读取并留存在私有证据目录。没有收到probe脚本；已用仓库实际子进程测试重现同类问题，不把Oracle探针当成本项目验收。云端清理和发布尚未执行。

正文建议已对照当前代码核实：Flickr接线和Compose变量已完成；进一步修复stderr洪泛误杀、原始错误泄露、日志sink故障、停服metadata备份、旧配置回滚和DeepSeek独立unit恢复；Actions增加唯一bundle、发布锁和已发布版本前进检查。

- 原始子进程输出泄漏以新增失败测试证实后修复；worker/diagnostics 10/10通过，包括5MiB级stderr和同步抛异常的日志sink。
- 部署事务测试31/31通过；再新增无legacy unit时独立恢复DeepSeek的行为用例，进入最终全量回归。
- typecheck通过；workflow YAML及内嵌SSH shell用Ruby标准库解析和bash -n校验通过。尝试Node yaml与venv PyYAML均因未安装未成功，未据此声称通过，也未为检查另装依赖。
- 一次性清理脚本进一步收窄：独立声音试听previews不清理；runs/archive/idempotency必须有逐项关联证明。增加完整卷外配置备份及独立解压一致性检查。脚本目前只做语法检查，尚未作用于云端。

## 附件补充项与边界

- 协议校验错误改为固定描述，Python未受控异常不再把原文或调用栈送进响应；保留错误类型和关联阶段。Python全量200/200通过。
- 发布目录改为mktemp唯一目录，不覆盖同秒已有release；失败日志不再向Actions输出原始旧服务日志；TERM/INT进入原回滚路径，失败unit备份留在私有deployment目录。
- CI增加候选镜像内Flickr正式Python入口离线测试；Linux渲染smoke显式禁网。不能把该离线测试标成真实Flickr检索。
- 一次性清理回执绑定最终SHA。源码确认Broker start只加载socket/durable目录，不自动重派历史任务，所以清理后仅重启Broker供部署探针，app保持停止；不为此新增维护状态机。
- 本轮9月3日MiniMax旧结果仍属于历史不确定记录，不等于正在执行任务，也不称已退款/无消费。其账目与Broker防重放数据完整保留，绝不重投；不为了空白列表抹掉财务事实。
- 现有模型目录服务端已经通过公共schema去除密钥并验证持久化；没有重建模型注册体系。本轮不穷举每个畸形响应或生产断电场景，未验证项如实保留。
- 用户已有所有tracked/untracked源码在仓库外打包备份；此备份与运行证据不上传公开仓库。

## 冻结提交前最终门禁

- 最新全量npm test退出0：TS936通过/1明确opt-in skip、Broker263/263、Studio465/465+604/604、package4/4，包含类型检查和正式构建。
- 最新Python全量200/200；最后发布脚本调整后独立部署事务32/32。YAML、SSH内嵌脚本、shell和Compose配置验证通过。
- 云端dry-run复核：27个目标run、27条对应production-start幂等记录、2条归档；无活动媒体worker/ffmpeg进程，Broker空闲。workspace/Broker持久目录均无symlink和xattr；DeepSeek服务没有额外drop-in。未进行任何清理。
- 云端保持旧86ebd37，最近一次Action成功且没有并行发布；远端main未变化。下一步冻结本地提交，完整备份、独立恢复核验后才执行一次性清理与Actions发布。
