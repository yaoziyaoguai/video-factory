import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pack='/Users/jinkun.wang/work_space/veidofactory/docs/ui-ux-oracle-20260923';
const raw=fs.readFileSync(path.join(pack,'ORACLE_RAW_ANSWER.md'),'utf8');
const files=['01_AUDIT.md','02_DESIGN_SPEC.md','03_IMPLEMENTATION_PLAN.md','04_ACCEPTANCE.md','05_QA_RUNBOOK.md','MASTER_PROMPT.md'];
const outputs=files.map(name=>{
  const start=`<!-- BEGIN_FILE: ${name} -->`;
  const end=`<!-- END_FILE: ${name} -->`;
  const from=raw.indexOf(start);
  const to=raw.indexOf(end,from+start.length);
  if(from<0||to<0||raw.indexOf(start,from+start.length)!==-1)throw new Error(`Missing or duplicated complete section: ${name}`);
  const body=raw.slice(from+start.length,to).trim()+'\n';
  if(body.length<200)throw new Error(`Suspiciously short section: ${name}`);
  if(fs.existsSync(path.join(pack,name)))throw new Error(`Refusing to overwrite existing handoff file: ${name}`);
  return {name,body};
});
for(const {name,body}of outputs)fs.writeFileSync(path.join(pack,name),body);
const manifest={source:'ORACLE_RAW_ANSWER.md',sourceSha256:crypto.createHash('sha256').update(raw).digest('hex'),extractedAt:new Date().toISOString(),files:outputs.map(({name,body})=>({name,bytes:Buffer.byteLength(body),sha256:crypto.createHash('sha256').update(body).digest('hex')}))};
fs.writeFileSync(path.join(pack,'evidence/extraction.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));
