import assert from 'node:assert/strict';
import { runRoleAgentLoop } from '../../../packages/production-pipeline/src/role-agent-loop.ts';

let stored: any;
let calls = 0;
const execute = () => runRoleAgentLoop({
  role: '导演前期构思', contractVersion: 'review-host-recovery-v1',
  criteria: ['符合明确用户要求'], maxIterations: 3, planningRole: true,
  checkpoint: { key: 'review-host-recovery', load: async () => stored,
    save: async (value: unknown) => { stored = structuredClone(value); } },
  assessPlanningReadiness: () => ({ status: 'ready' as const, issues: [] }),
  produce: async () => { calls++; return { output: { title: '抽象色彩表达' } }; },
  audit: async () => ({ output: { version: 'video-factory/role-audit-v1',
    verdict: 'pass', score: 94, summary: '可执行且符合用户要求', issues: [],
    repairInstructions: [], planningDisposition: null,
    hostReadinessReview: { misclassifiedIssueIds: [] } } }),
  validate: (value: unknown) => value as { title: string },
});

const first = await execute();
assert.equal(first.output.title, '抽象色彩表达');
console.log('first invocation: passed; saved hostReadiness=', stored.completed[0].hostReadiness);
try {
  await execute();
  console.log('second invocation: passed');
} catch (error) {
  console.log('second invocation:', (error as Error).message);
  process.exitCode = 1;
}
console.log('producer calls:', calls);
