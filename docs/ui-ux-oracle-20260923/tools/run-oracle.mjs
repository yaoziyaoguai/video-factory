import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pack='/Users/jinkun.wang/work_space/veidofactory/docs/ui-ux-oracle-20260923';
const mode=process.argv[2];
// 用户明确要求重发；保留上一轮记录，不将重发伪装为同一次咨询。
const attempt='03';
const slug=`vf-ui-ux-motion-20260923-${attempt}`;
if(!['preview','consult'].includes(mode))throw new Error('Expected preview or consult');
const manifest=JSON.parse(fs.readFileSync(path.join(pack,'evidence/manifest.json'),'utf8'));
const prompt='请作为 VideoFactory 的资深产品设计师、视觉/交互负责人和 React 前端架构师，完成一次 UI/UX 外审并交付普通 coding agent 可直接执行的详细资料包。附件包中 ORACLE_REQUEST.md 是本次完整任务指令，请先完整阅读并严格按其中六份 Markdown 文件的分隔格式返回正文。然后读 EVIDENCE_CONTEXT.md、SOURCE_CONTEXT.md，并实际查看附带的14张截图；区分当前截图、历史证据、源码推断和未验证项。项目是 React19/Router7/Vite8 的个人 AI 视频制作工作台，不是营销页。目标是易用、视觉系统统一美观、动效有表现力；“美团”是用户已澄清的笔误，不要模仿美团品牌。关键节点必须等用户明确确认；费用安全、版本和产物绑定、质量建议与硬边界的区分均不可改变。现有稿件/讨论双栏和手机页签应在现有源码上提升，不推翻重建。允许你从产品、视觉、无障碍、工程角度交叉分析，但只输出审计与实施建议，不执行产品修改、发布或付费操作。请选定一套明确设计，给出tokens、桌面/手机布局、动效参数、文件级实施卡、验收和真实本地UI QA手册以及MASTER_PROMPT；不要只给下载链接或泛泛建议。调用方收到完整资料包后将停止，交给另一个agent实施；当前不能宣称产品已优化或验收通过。';
const args=['--browser-thinking-time','max','--browser-attachments','always','--files-report',
  '-p',prompt,
  '--file',path.join(pack,'ORACLE_REQUEST.md'),path.join(pack,'EVIDENCE_CONTEXT.md'),path.join(pack,'SOURCE_CONTEXT.md'),
  ...manifest.screenshots.filter(s=>s.send).map(s=>path.join(pack,'evidence/screenshots',s.name))];
if(mode==='preview')args.push('--dry-run','summary');
else{
  const started=path.join(pack,`evidence/consultation-started-${attempt}.json`);
  if(fs.existsSync(started))throw new Error('Consultation was already started; inspect its recorded session instead of submitting again.');
  fs.writeFileSync(started,JSON.stringify({slug,startedAt:new Date().toISOString(),strength:'max',expectedVisiblePosition:'5 of 5',authorization:'User explicitly requested resubmission at highest thinking strength'},null,2)+'\n');
  args.push('--timeout','45m','--browser-timeout','45m','--slug',slug,'--write-output',path.join(pack,'ORACLE_RAW_ANSWER.md'),'--wait');
}
const log=fs.createWriteStream(path.join(pack,'evidence',mode==='preview'?`oracle-preview-${attempt}.log`:`oracle-consultation-${attempt}.log`),{flags:'a'});
const child=spawn('/Users/jinkun.wang/.local/bin/oracle-web',args,{cwd:'/Users/jinkun.wang/work_space/veidofactory',stdio:['ignore','pipe','pipe']});
for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{log.write(data);process.stdout.write(data);});
child.on('error',error=>{log.end(String(error)+'\n');process.exitCode=1;});
child.on('close',code=>{log.end(`\nWrapper exit code: ${code}\n`);process.exitCode=code??1;});
