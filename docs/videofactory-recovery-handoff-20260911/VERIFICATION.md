# 验证方法与证据格式

本文件定义如何证明阶段完成。执行卡中的命令优先；实际 package script 或测试文件名变化时，可按当前仓库调整，但不得缩小行为覆盖。

## 1. 基线

每个阶段开始和结束记录：

```bash
cd /Users/jinkun.wang/work_space/veidofactory
git rev-parse HEAD
git status --short --branch
git diff --stat
git ls-files --others --exclude-standard
git diff --check
```

禁止 reset、stash、checkout、clean。输出截断、无 exit code 或 timeout 不算通过。

## 2. 测试层级

### L1：纯合同

parser、canonical identity、金额整数、dependency closure、状态转换。先快速定位根因，但不能证明真实 service/runner。

### L2：真实业务模块 + fake external transport

必须使用真实 ProductionPipeline、WorkflowRunner、FileRunStore、ProductionStudio、authorization/ledger/artifact 校验。只替换模型/Provider/下载等外部 transport。验证 artifact、run revision、授权、ledger、create/reconcile 计数和终态。

### L3：进程 crash 与并发

- 用子进程和确定性 barrier 在指定边界退出，不用 throw 模拟硬崩溃。
- fake external transport 的 task/create 记录独立于被杀应用进程。
- 并发测试要让两个请求真实通过预检查并竞争持锁点，不是顺序调用两次纯函数。
- 记录 kill 点、恢复进程、run revision、artifact/authorization/ledger 数量和外部 create 次数。

### L4：组件与浏览器

组件测试保护交互状态；真实浏览器在 1440/390 下完成可见操作、键盘、滚动、断网/409/重开。截图必须带步骤和对应 run/fixture，不能用静态页面代替真实状态。

### L5：真实模型/媒体和云端

只在 C6 且获得当次权限后运行。记录实际 model/provider/参数、request/task ID、是否付费、媒体 SHA、ffprobe、双审 snapshot 和部署 SHA。无授权不执行。

## 3. 测试 stale 与产品 bug 的分类

每个失败标记一种：

- `PRODUCT_BUG`：当前实现违反权威合同。
- `STALE_TEST`：生产合同正确，fixture/断言仍描述旧行为。
- `BOTH`：测试目标正确但建模不足，或旧断言错误而产品也缺少新状态。
- `ENVIRONMENT`：有可复现环境原因；修复环境后必须重跑。
- `UNVERIFIED`：材料不足，列下一条能裁定的检查。

更新 stale test 时必须保留对应新安全断言。例如补 expected revision 不能取消 stale 409；更新 treatment artifact 不能删除 provenance/closure 检查。

## 4. 当前环境事实

- Node `v26.8.1`，ABI 147。
- `better-sqlite3@12.11.1` 原 binding ABI 127；已执行 `npm rebuild better-sqlite3`，SQLite 探针成功。
- 该重建没有源码/lockfile修改。后续如果 Node 或 node_modules 变化，要先重新验证，不回退 MemorySaver。

## 5. 当前失败基线

- root typecheck：Studio errors，exit 2。
- B4 Studio：5 failures。
- B5：3 failures。
- C1：1 failure。
- C2 service/API：8 failures。
- C2 UI：4 failures。

完整分类见 `CURRENT_STATE.md`。执行者不得把某阶段外的已知失败算作该阶段通过，也不得用它掩盖当前阶段新增失败。

## 6. 阶段审计步骤

执行者报告完成后，审计者必须：

1. 对比阶段开始基线，确认真实修改范围。
2. 阅读所有修改文件完整上下文。
3. 对照当前执行卡、`AUTHORITATIVE_DECISIONS.md` 和 `ACCEPTANCE.md`。
4. 检查错误、恢复、重试、幂等、并发、权限和 A 回归。
5. 运行关键 L1/L2/L3 测试并确认 exit。
6. 核对 `JOURNAL.md` 与实际证据。
7. 使用全新独立 Oracle Web 会话复审整个阶段；不复用旧 conversation，不用 followup。
8. 只给 `ACCEPTED`、`CHANGES_REQUIRED` 或真正需要用户决定的 `BLOCKED`。

阶段内不要每个小修都 Oracle。只有完整阶段完成后外部复审。

## 7. 通用证据记录模板

```text
阶段 / 日期：
开始 HEAD、branch、status、diff：
实际模型/provider/thinking：
用户可观察目标：

失败证据：
- ID：
- 分类：PRODUCT_BUG / STALE_TEST / BOTH / ENVIRONMENT / UNVERIFIED
- 命令、exit、关键断言：
- 根因：

修改：
- 文件与 symbol：
- 保护的合同：
- 为什么是最小范围：

验证：
- L1：
- L2：
- L3：
- L4：
- L5：not_run 时写原因

外部副作用：
- Provider create/reconcile：
- 费用与 unknown：
- commit/push/deploy：

未通过/未验证：
下一阶段前置：
```

## 8. 最终 C6 证据

至少保留三条互补真实制作：热点常青方向、系列本集、自有想法。三条均走 Web，不直接改 JSON。需要：

- accepted plan 与 executable timeline。
- 媒体/task/source/usage SHA 和实际费用。
- 自然声音、帧/时长、裁切、连续动作的技术证据。
- 两个实际 reviewer identity、同 snapshot 和最终报告。
- 一次局部返工与一次费用追加/调整/暂停恢复。
- 1440/390 截图和点击记录。
- 本地/云端 SHA 对齐、GitHub Actions 和阿里云 health/restart evidence。

真实付费验证应复用可交付试片，控制合理小额；不为每个故障状态买一整片。
