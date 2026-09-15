import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRoleAgentLoop} from '../../../packages/production-pipeline/src/role-agent-loop.ts';
import {CodexBridgeError} from '../../../packages/production-pipeline/src/codex-chat.ts';
const pass={version:'video-factory/role-audit-v1',verdict:'pass',score:92,summary:'当前标准通过',issues:[],repairInstructions:[]};
test('new successful audit after settling old failure should not be discarded as old-contract audit',async()=>{
  let stored, first=true, oldId;
  let produced=0, observed=0, currentAudits=0;
  const run=(contractVersion,resumeId)=>runRoleAgentLoop({
    role:'编剧',contractVersion,criteria:['具体'],maxIterations:3,
    checkpoint:{key:'accepted-input',resumeCompletedFailureRequestId:resumeId,load:async()=>stored,save:async x=>{stored=structuredClone(x);}},
    produce:async()=>{produced++;return{output:{title:'保留候选'}};},
    audit:async op=>{
      if(op.preparedOperation){observed++;throw new CodexBridgeError('old audit failed',false,'completed_failure',502,'model_provider_transient');}
      if(first){
        first=false;oldId=op.requestId;
        await op.requestOptions.beforeSubmit({version:'video-factory/codex-prepared-operation-v1',requestId:op.requestId,kind:'role-audit',envelope:{payload:{old:true}},serializedEnvelope:'{"payload":{"old":true}}',binding:{requestDigest:'a'.repeat(64)},brokerBinding:{},route:{socketPath:'/tmp/not-connected.sock'},taskFact:'accepted_unknown'});
        throw new CodexBridgeError('audit observation lost',false,'uncertain');
      }
      currentAudits++;return{output:pass};
    },validate:x=>x,
  });
  await assert.rejects(()=>run('old'));
  const result=await run('new',oldId);
  console.log(JSON.stringify({probe:'upgrade-plus-manual-failure-recovery',produced,observed,currentAudits,status:result.agentLoop.status}));
  assert.equal(observed,1);assert.equal(produced,1);assert.equal(currentAudits,1,'当前合同已经通过的新审计不应再被当成旧审计丢弃');
});
