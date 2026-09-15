import {ProductionStudio} from '../../../apps/studio/src/server/production-studio.ts';
process.once('message', async ({workspace, run}) => {
  const pipeline = {show:async()=>structuredClone(run),loadPersisted:async()=>structuredClone(run),list:async()=>[run],pauseRequested:async()=>false};
  const studio = new ProductionStudio({workspaceRoot:workspace,pipeline,archiveStore:{list:async()=>({})},listProviders:async()=>[]});
  try {const result=await studio.queryOriginalTextTask('review-run');process.send({type:'done',state:result.taskRecovery?.taskState});}
  catch(e){process.send({type:'done',error:e.message});}
  process.disconnect();
});
