// 只读审计探针：不启动服务、不发送网络请求、不写生产文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));
const evidence = read('docs/qa/videofactory-real-local-qa-20260914-r11-repair-assets/final-evidence.json');
const durable = (prefix) => read(evidence.rows.find(r => r.requestId.startsWith(prefix)).durablePath);
const payload = d => JSON.parse(d.outcome.trace.prompt.split('<<<TASK_DATA\n')[1].split('\nTASK_DATA>>>')[0]);
const output = d => typeof d.outcome.output === 'string' ? JSON.parse(d.outcome.output) : d.outcome.output;
async function inspectModule(relative, names) {
  const filename = path.resolve(root, relative);
  const source = fs.readFileSync(filename, 'utf8');
  let code = ts.transpileModule(source + `\nexport { ${names.join(',')} };`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  code = code.replace(/from\s+(["'])([^"']+)\1/g, (all, quote, spec) => {
    let url;
    if (spec.startsWith('.')) {
      let target = path.resolve(path.dirname(filename), spec);
      if (!fs.existsSync(target) && target.endsWith('.js')) target = target.slice(0,-3) + '.ts';
      url = pathToFileURL(target).href;
    } else url = import.meta.resolve(spec);
    return `from ${quote}${url}${quote}`;
  });
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
const topic = await inspectModule('apps/studio/src/server/trend-opportunity-agent.ts', [
  'groundModelIdea','unsupportedClaim','numberTokens','latinTokens','quotedSegments','containsPhrase','isStructuralQuantity','topicRiskLevel',
]);
const initial = payload(durable('agent-7d5c874'));
const ideas = output(durable('agent-f9b090')).ideas;
const signals = initial.signals;
const diagnoses = ideas.map((idea,index) => {
  const signal = signals.find(s => s.id === idea.signalId);
  const group = [signal, ...(signal.relatedSignals ?? [])];
  const sources = signal.articleSources ?? [];
  const paragraphs = [];
  let referencesValid = true;
  for (const fact of idea.facts ?? []) {
    const source = sources.find(s => s.sourceId === fact.sourceId && ['read','partial'].includes(s.readStatus));
    for (const id of fact.paragraphIds) {
      const p = source?.paragraphs.find(p => p.id === id);
      if (!p) referencesValid = false;
      else paragraphs.push(p.text);
    }
  }
  const text = [...group.map(s => s.title),...paragraphs].join('；');
  const numbers = new Set(topic.numberTokens(text));
  const terms = new Set(topic.latinTokens(text));
  const structural = topic.topicRiskLevel(signal.title) !== 'high';
  const fields = Object.fromEntries(['title','audience','painPoint','hook','rationale','visualProof'].map(k=>[k,idea[k]??'']));
  if (idea.visualPlan) {
    fields['visualPlan.strategy'] = idea.visualPlan.strategy;
    idea.visualPlan.beats.forEach((b,i)=> { fields[`visualPlan.beats[${i}].description`] = b.description; });
  }
  const rejectedFields = Object.entries(fields).filter(([,v])=>topic.unsupportedClaim(v,text,numbers,structural)).map(([field,v])=>({
    field,
    quotes:topic.quotedSegments(v).filter(q=>!topic.containsPhrase(text,q)),
    numbers:topic.numberTokens(v).filter(n=>!numbers.has(n)&&!(structural&&topic.isStructuralQuantity(v,n))),
    latin:topic.latinTokens(v).filter(t=>!terms.has(t)),
    attribution:/透露|表示|宣称|宣布|数据显示|官方数据|调查显示|研究表明|合理估算|据报道|训练日程|内部消息|独家|采访素材/.test(v),
    clickbait:/内幕|秘密|曝光|真相|首次披露/.test(v)&&!/内幕|秘密|曝光|真相|首次披露/.test(text),
  }));
  return { index, referencesValid, accepted:topic.groundModelIdea(idea,group,sources)!==null, rejectedFields };
});
const agent = new topic.TrendOpportunityAgent({
  signals:{listSignals:async()=>signals.flatMap(s=>[s,...(s.relatedSignals??[])])},
  articleReader:{readMany:async()=>signals.flatMap(s=>s.articleSources??[])},
  model:{id:'recording-replay-not-a-real-call',generate:async()=>ideas},
});
const candidates = await agent.listCandidates();
const pipeline = await import(pathToFileURL(path.join(root,'packages/production-pipeline/src/production-pipeline.ts')).href);
const run = read(evidence.runs.find(r=>r.id.startsWith('run-25b')).path);
const cpDir = path.join(root,'workspace/qa-r11-repair-20260914/runs',run.id,'nodes/creative-planning/agent-loop-checkpoints');
const cps = fs.readdirSync(cpDir).filter(n=>n.endsWith('.json')).map(n=>({name:n,value:read(path.join(cpDir,n))}));
const affected = cps.find(c=>JSON.stringify(c.value.attemptedRequestIds).includes('agent-c1381'));
const owner = affected?.value.recoveryOwner?.workflowOperationRequestId;
const summary = await pipeline.summarizeJointPlanningExecution(path.join(root,'workspace/qa-r11-repair-20260914/runs'),run.id,owner);
const series = evidence.rows.filter(r=>r.profile==='zai'&&r.kind==='director-plan').map(r=>{
  const d=read(r.durablePath), p=payload(d), o=output(d);
  return {requestId:r.requestId,providerWaitMs:r.providerWaitMs,payloadKeys:Object.keys(p),hasPriorPlan:!!p.brief?.rework?.previousDirectorPlan,
    issues:p.brief?.planningIssues?.map(i=>({scenePositions:i.scenePositions,requiredChange:i.requiredChange,authenticity:i.availabilityBlocker?.narrativeTarget.authenticityPolicy}))??null,
    shots:o.shots.map(s=>({scene:s.scenePosition,authenticity:s.authenticityPolicy,delivery:s.deliveryType,reuse:s.reuseFromScenePosition}))};
});
const {ZaiCodePlanExecutor} = await import(pathToFileURL(path.join(root,'apps/codex-broker/src/zai-code-plan-executor.ts')).href);
const {parseTaskRequest} = await import(pathToFileURL(path.join(root,'apps/codex-broker/src/codex-executor.ts')).href);
const {taskContractDescriptorFor} = await import(pathToFileURL(path.join(root,'apps/codex-broker/src/task-definitions.ts')).href);
const {runRoleAgentLoop} = await import(pathToFileURL(path.join(root,'packages/production-pipeline/src/role-agent-loop.ts')).href);
const original = durable('agent-5321b');
const invalid = structuredClone(output(original));
invalid.shots[1].scenePosition = invalid.shots[0].scenePosition;
let transportCalls = 0, validateCalls = 0;
let emittedOutput = output(original);
const executor = new ZaiCodePlanExecutor({env:{ZAI_BIGMODEL_API_KEY:'probe-only-never-sent'},fetchFn:async()=>{
  transportCalls++;
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(emittedOutput)}}]}),{status:200});
}});
const task = parseTaskRequest({protocolVersion:'video-factory/codex-bridge-v2',kind:'director-plan',
  expectedContractDigest:taskContractDescriptorFor('director-plan').digest,payload:payload(original)},executor.identity);
const control = await executor.runTask(task);
assert.deepEqual(JSON.parse(control.output), output(original));
const validControlCalls = transportCalls;
transportCalls = 0;
emittedOutput = invalid;
let diagnostic;
try { await runRoleAgentLoop({role:'visual-director',contractVersion:'audit-probe',criteria:['valid scene identity'],maxIterations:1,deferAudit:true,
  produce:async()=>{try {return await executor.runTask(task);}catch(e){diagnostic=e.details;throw e;}},
  audit:async()=>{throw new Error('audit must not run');},validate:v=>{validateCalls++;return v;}}); }catch {}
assert.ok(diagnostic, 'invalid candidate must have an explicit diagnostic');
const runPage = fs.readFileSync(path.join(root,'apps/studio/src/client/pages/RunPage.tsx'),'utf8');
const ast = ts.createSourceFile('RunPage.tsx',runPage,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const preference = ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='preferRunSnapshot');
assert.ok(preference,'expected snapshot preference function');
const isolated = ts.transpileModule(preference.getText(ast),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {preferRunSnapshot} = await import('data:text/javascript;base64,'+Buffer.from(isolated).toString('base64'));
const snapshot = preferRunSnapshot({id:'probe',revision:2,status:'failed',planningStages:[{id:'director',issue:'duplicate_scene_position'}]},
  {id:'probe',revision:2,status:'failed'});
console.log(JSON.stringify({snapshot:{sameRevisionThinEventDropsPlanningStages:!snapshot.planningStages},semanticBoundary:{validControlCalls,transportCalls,validateCalls,diagnostic},topic:{candidateCount:candidates.length,diagnoses},recovery:{owner,summary,
  checkpoint:affected?{name:affected.name,attemptedRequestIds:affected.value.attemptedRequestIds,durations:affected.value.phaseDurationsMs}:null,
  physicalDirectorRequests:evidence.rows.filter(r=>r.requestId.startsWith('agent-c1381')||r.requestId.startsWith('agent-c389')).map(({requestId,providerWaitMs,queueWaitMs})=>({requestId,providerWaitMs,queueWaitMs}))},series},null,2));
