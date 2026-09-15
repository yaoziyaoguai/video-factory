// 步骤 19b：轮询新返工 run 的规划阶段，逐次状态变化输出一行事件，收敛后退出。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const RUN_DIR = process.argv[2];
if (!RUN_DIR) throw new Error('usage: step-19b-watch-planning.mjs <runDir>');
const POLL_MS = 15_000;

let previous = '';
for (;;) {
  let line = 'run.json 未生成';
  try {
    const run = JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
    const nodeStates = (run.nodeRuns ?? []).map((node) => `${node.nodeId}:${node.status}`).join(',');
    line = `${run.status} rev=${run.revision} ${nodeStates}`;
    const planning = path.join(RUN_DIR, 'nodes/creative-planning');
    if (existsSync(planning)) {
      const drafts = readdirSync(planning, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory()
          ? readdirSync(path.join(planning, entry.name)).filter((f) => f.endsWith('.json')).map((f) => `${entry.name}/${f}`)
          : []))
        .sort();
      if (drafts.length) line += ` drafts=${drafts.join('|')}`;
    }
  } catch (error) {
    line = `读取失败：${error.code ?? error.message}`;
  }
  if (line !== previous) {
    console.log(line);
    previous = line;
  }
  const settled = /creative-planning:(needs_human|succeeded|failed|blocked)/.test(line)
    || /\b(failed|rejected|completed|blocked)\b/.test(line.split(' ')[0] ?? '');
  if (settled) {
    console.log(`收敛：${line}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
