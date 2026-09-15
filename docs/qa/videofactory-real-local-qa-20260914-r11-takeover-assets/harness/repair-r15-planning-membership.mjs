// R11 收尾轮：修复被旧代码写坏的规划版本成员表（一次性落盘修复，不是产品功能）。
//
// 【为什么需要】
// 旧代码的 dispatchNarrationRevision 在改字时把「原稿」从 planning 节点当前接受版本里
// 踢了出去，而可执行方案仍按 artifact id 引用它（plan.scriptArtifactId = 原稿 id）。
// 于是 voice 消费方案时 fail closed：
//   "Executable plan reference 'artifact-35bacec2-…' (script) is not a member of the
//    current accepted planning output version."
// 修好之后的代码不会再写出这种版本，但**已经写坏的这一版无法靠产品动作救回**：
//   - applyNodeRevision 硬约束 retainedArtifactIds ⊆ 当前版本成员（workflow-runner.ts:767-771），
//     所以任何返修/override 都不能把原稿加回版本；
//   - retryFailedNode 只是用同一份 run.json 重跑 voice，必然同一条报错；
//   - 没有任何"回退到上一个版本 / 撤销 revision"的操作；
//   - 重跑 creative-planning 会失效 assets 下游，等于重买已付费素材。
//
// 【这个脚本做什么】
// 只做一件事：把原稿 id 加回当前接受版本的 artifactIds（插在父版本里的同一位置），
// 使落盘状态**等于修好后的代码本来会写出的那一版**（保留全部旧成员 + 新增的两件）。
// 不碰：方案文件、原稿文件、规划 commit 文件、素材、任何金额或授权记录、revision 计数。
//
// 【为什么不是造假】
// 被加回的产物真实存在于磁盘，sha256 / provenance / commit 三方一致且未改动；这里恢复的是
// 「它本来就该在版本里」这一条成员关系。配音、渲染、复审仍然全部真实执行。
// 但它确实是**手工落盘修复**，不是产品路径 —— 报告里必须如实标注。
//
// 用法：node repair-r15-planning-membership.mjs [--apply]   （默认 dry-run，只打印）
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/jinkun.wang/work_space/veidofactory';
const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ROOT, 'workspace/qa-r11-repair-20260914/runs', RUN_ID);
const RUN_JSON = path.join(RUN_DIR, 'run.json');
const BACKUP_DIR = path.join(ROOT, '.local/runtime/qa-r11-repair-20260914/backups');
const APPLY = process.argv.includes('--apply');

const fail = (message) => { throw new Error(`refusing to repair: ${message}`); };

const run = JSON.parse(readFileSync(RUN_JSON, 'utf8'));
const planning = run.nodeRuns?.find((node) => node.nodeId === 'creative-planning');
if (!planning) fail('no creative-planning node');
// 只修"voice 已经因为这条成员关系失败"的运行：其余状态不在这个脚本的射程内。
if (run.status !== 'failed') fail(`run.status is '${run.status}', expected 'failed'`);
const versions = planning.outputState?.versions ?? [];
const effective = versions.find((version) => version.id === planning.outputState.effectiveVersionId);
if (!effective) fail('no effective planning output version');
const parent = versions.find((version) => version.id === effective.parentVersionId);
if (!parent) fail('effective version has no parent version to take the member order from');

const planArtifact = run.artifacts.find((artifact) => (
  effective.artifactIds.includes(artifact.id)
  && artifact.kind === 'executable_plan'
  && artifact.producer?.nodeId === 'creative-planning'
));
if (!planArtifact?.uri) fail('no current executable plan artifact');
const plan = JSON.parse(readFileSync(planArtifact.uri, 'utf8'));
const evictedId = plan.scriptArtifactId;
const evicted = run.artifacts.find((artifact) => artifact.id === evictedId);
if (!evicted) fail(`plan references unregistered artifact '${evictedId}'`);
if (evicted.kind !== 'script' || evicted.producer?.nodeId !== 'creative-planning') {
  fail(`plan's script reference is kind='${evicted.kind}' producer='${evicted.producer?.nodeId}'`);
}
if (!existsSync(evicted.uri)) fail(`evicted script file is missing: ${evicted.uri}`);
// 只处理"当前版本丢了成员、而父版本里有它"这一种损坏：这正是旧代码的写法留下的形状。
if (effective.artifactIds.includes(evictedId)) fail('the plan\'s script is already a version member');
const indexInParent = parent.artifactIds.indexOf(evictedId);
if (indexInParent < 0) fail('the parent version does not contain the evicted script either');
// 版本成员只增不减地相对父版本：除被踢掉的那一件以外，父版本成员必须都还在。
const missingFromEffective = parent.artifactIds.filter((id) => !effective.artifactIds.includes(id));
if (missingFromEffective.length !== 1 || missingFromEffective[0] !== evictedId) {
  fail(`unexpected membership drift vs parent: ${JSON.stringify(missingFromEffective)}`);
}

const repaired = [...effective.artifactIds];
repaired.splice(indexInParent, 0, evictedId);
const nodeLevel = planning.artifactIds;
const nodeLevelRepaired = nodeLevel.includes(evictedId) ? nodeLevel : (() => {
  const next = [...nodeLevel];
  next.splice(indexInParent, 0, evictedId);
  return next;
})();

console.log(`run ${run.id} status=${run.status} revision=${run.revision}`);
console.log(`effective version ${effective.id} (parent ${parent.id})`);
console.log(`\nbefore (${effective.artifactIds.length}):`);
for (const id of effective.artifactIds) console.log(`  ${id}  ${run.artifacts.find((a) => a.id === id)?.kind ?? '?'}`);
console.log(`\nafter  (${repaired.length}):`);
for (const id of repaired) console.log(`  ${id}  ${run.artifacts.find((a) => a.id === id)?.kind ?? '?'}`);
console.log(`\ninsert '${evictedId}' (${evicted.kind}) at index ${indexInParent}, same slot as in the parent version`);
console.log(`node-level artifactIds ${nodeLevel.length} -> ${nodeLevelRepaired.length}`);

if (!APPLY) {
  console.log('\ndry-run: nothing written. Re-run with --apply to write.');
  process.exit(0);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(BACKUP_DIR, `${RUN_ID}-rev${run.revision}-before-membership-repair-${stamp}.json`);
copyFileSync(RUN_JSON, backup);
console.log(`\nbackup: ${backup}`);

effective.artifactIds = repaired;
planning.artifactIds = nodeLevelRepaired;
const temporary = `${RUN_JSON}.repair-${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
renameSync(temporary, RUN_JSON);
console.log(`written: ${RUN_JSON}`);
