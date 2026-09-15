// R11 续轮：授权后流水线观察器。
// 媒体生成期间节点会长时间停在 running，"卡住"与"在干活"靠状态无法区分，
// 故把 run 目录的**实际字节产出**并入观测键：产出变化即进展，长时间无变化即疑似停滞。
// run 离开 running（终态或闸门）即退出。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const RUN_DIR = process.env.QA_RUN_DIR ?? '/Users/jinkun.wang/work_space/veidofactory/workspace/qa-r11-repair-20260914/runs/run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN = path.join(RUN_DIR, 'run.json');
const POLL_MS = Number(process.env.QA_POLL_MS ?? 30_000);
const STALL_MS = Number(process.env.QA_STALL_MS ?? 12 * 60_000);

const GATES = new Set(['needs_human', 'awaiting_spend_approval', 'awaiting_input']);
const TERMINAL = new Set(['succeeded', 'failed', 'rejected', 'cancelled']);

// 统计 nodes/ 下所有文件的个数与总字节，作为"是否真的在产出"的证据
function production() {
  let files = 0, bytes = 0, newest = 0;
  const stack = [path.join(RUN_DIR, 'nodes')];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try { const s = statSync(p); files++; bytes += s.size; if (s.mtimeMs > newest) newest = s.mtimeMs; } catch {}
    }
  }
  return { files, bytes, newest };
}

function snapshot() {
  const r = JSON.parse(readFileSync(RUN, 'utf8'));
  const nodes = (r.nodeRuns ?? []).map((n) => `${n.nodeId}=${n.status}`).join(' ');
  const meter = (r.executionReceipts ?? []).filter((x) => x.billing === 'metered');
  const spent = meter.reduce((s, x) => s + (typeof x.actualCostCny === 'number' ? x.actualCostCny : 0), 0);
  const pend = meter.filter((x) => typeof x.actualCostCny !== 'number').length;
  const prod = production();
  return {
    key: `${r.status}|${r.revision}|${nodes}|${meter.length}|${spent}|${pend}|${prod.files}|${prod.bytes}`,
    status: r.status, revision: r.revision, nodes, spent, pend, meterCount: meter.length,
    currentNodeId: r.currentNodeId, finishedAt: r.finishedAt, prod,
  };
}

const lines = (s) => [
  `run=${s.status} rev=${s.revision} 当前节点=${s.currentNodeId ?? '-'}`,
  `  节点: ${s.nodes}`,
  `  已发生 ¥${s.spent.toFixed(2)}（metered 回执 ${s.meterCount} 笔，未结算 ${s.pend} 笔）`,
  `  产出: ${s.prod.files} 个文件 / ${(s.prod.bytes / 1048576).toFixed(1)} MB`,
];

let last = null, lastChangeAt = Date.now(), stallReported = false;
for (;;) {
  let s;
  try { s = snapshot(); } catch (e) {
    console.log(`!! 读取 run.json 失败: ${String(e).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, POLL_MS)); continue;
  }
  if (s.key !== last) {
    console.log(last === null ? '=== 观察开始 ===' : '=== 状态/产出变化 ===');
    for (const l of lines(s)) console.log(l);
    last = s.key; lastChangeAt = Date.now(); stallReported = false;
  } else if (!stallReported && Date.now() - lastChangeAt > STALL_MS) {
    console.log(`!! 疑似停滞：${Math.round((Date.now() - lastChangeAt) / 60000)} 分钟无状态变化也无新产出`);
    for (const l of lines(s)) console.log(l);
    stallReported = true;
  }
  if (TERMINAL.has(s.status) || GATES.has(s.status)) {
    console.log(`=== 停止观察：run ${s.status} ===`);
    for (const l of lines(s)) console.log(l);
    if (s.finishedAt) console.log(`finishedAt=${s.finishedAt}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
