import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assembleOfflineAgent } from "../src/server/agent/offline.js";
import { MediaRetention } from "../src/server/agent/media-retention.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { createWork } from "../src/server/agent/creative-work.js";
import { digestOf } from "../src/server/agent/util.js";
import type { ArtifactRevision, RevisionRef } from "../src/shared/agent/generated/contracts.js";

test("OPT-04 真实文件按定稿来源、当前认可、活动或未结算制作留存，回收陈旧中间稿", async t => {
  const dir = await mkdtemp(path.join(tmpdir(),"frame-media-retention-"));
  const old="2026-09-01T10:00:00.000Z", now="2026-11-22T10:00:00.000Z";
  const app=await assembleOfflineAgent({dataDir:dir,uiOrigin:"http://127.0.0.1:4318",clock:()=>now});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const owner="local-owner", db=app.database;
  const conversation=app.service.createConversation(owner,{commandId:"gc-conversation",title:"历史重制"}).conversation.id;
  const work=createWork(db,old,{ownerId:owner,conversationId:conversation},"成片");
  const blobs=new ProductionBlobs(db,dir,()=>old);
  const retention=new MediaRetention(db,blobs,()=>now,30);
  let sequence=0;
  function media(label:string,size=2048) {
    const bytes=Buffer.alloc(size); bytes.write(label); return blobs.persist(owner,conversation,bytes,"video/mp4",1000);
  }
  const rev=(id:string,content:ArtifactRevision["content"],kind:string,time=old):RevisionRef=>{
    const a="artifact-"+id;
    db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)")
      .run(a,conversation,owner,id,kind,work.id,id,++sequence,time,time);
    db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,created_at) VALUES(?,?,1,?,?,?)")
      .run(id,a,digestOf(content),JSON.stringify(content),time);
    return {artifactId:a,revisionId:id};
  };
  const mediaRevision=(id:string,blobId:string,time=old)=>rev(id,{format:"media",blobId,mimeType:"video/mp4",durationMs:1000},"video",time);
  const final=media("final"),input=media("source"),projectFile=media("source-file"),draft=media("current"),approved=media("approved");
  const current=mediaRevision("current",draft.id), accept=mediaRevision("approved",approved.id);
  const adopted=mediaRevision("source",input.id);
  const project=rev("frozen",{format:"project",files:[{relativePath:"src/main.py",blobId:projectFile.id,digest:projectFile.digest,purpose:"entry"}],
    entrypoint:{argv:["python","src/main.py"]},runtimeImage:"fixture",sourceRevisions:[adopted],timelineFiles:[],dependencyLocks:[]},"project");
  const finalized=mediaRevision("final",final.id);
  db.prepare("UPDATE artifact_revisions SET creation_binding_json=? WHERE id=?").run(JSON.stringify({inputSources:[{kind:"artifact_revision",...adopted}],
    projectRevision:project,reviewInputs:[]}),finalized.revisionId);
  db.prepare("INSERT INTO work_review_confirmations(id,owner_id,conversation_id,subject_scope,work_id,group_id,item_id,action,subject_json,source_kind,source_id,created_at) VALUES('f',?,?,'work_item',?,'group','output','finalize_video',?,'user_message','m',?)")
    .run(owner,conversation,work.id,JSON.stringify({kind:"artifact_revision",...finalized}),old);
  db.prepare("UPDATE works SET creation_state_json=? WHERE id=?").run(JSON.stringify({groups:[{id:"group",title:"审阅",items:[
    {id:"next",draft:{kind:"artifact_revision",...current},approved:{kind:"artifact_revision",...accept}}]}]}),work.id);
  const job=media("active-job"),pending=media("pending-bill");
  for (const [id,blob,state] of [["r1",job.id,"queued"],["r2",pending.id,"failed"]] as const) {
    db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES(?,?,?,?)")
      .run("snap-"+id,JSON.stringify({operations:[{inputs:[{kind:"blob",blobId:blob}]}]}),id,old);
    db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,title,state,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id,owner,conversation,work.id,"snap-"+id,"制作",state,++sequence,old,old);
    if (id==="r2") {
      db.prepare("INSERT INTO production_operations(run_id,id,spec_json,state) VALUES(?,'op','{}','failed')").run(id);
      db.prepare("INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor,billing_final) VALUES('a',?,'op',1,'provider-a','observed','failed',50,0)").run(id);
    }
  }
  const recent=media("new-revision-old-file");mediaRevision("recent",recent.id,now);
  const discarded=Array.from({length:12},(_,i)=>media("discard-"+i,8192));
  const obsolete=mediaRevision("obsolete",discarded[0]!.id);
  const shared=media("shared");
  const other=blobs.persist("other","other",await readFile(blobs.filePath(shared.digest)),"video/mp4",1000);
  const rootIds=[final,input,projectFile,draft,approved,job,pending,recent];
  const usage=retention.usage(owner);
  assert.equal(usage.finalBytes,final.size_bytes+input.size_bytes+projectFile.size_bytes);
  assert.equal(usage.reclaimableBytes,12*8192);
  assert.throws(()=>retention.sweepUnpinnedDraftBlobs(owner,{commandId:"stale",expectedRevision:999}),/清理记录已更新/);
  db.exec("CREATE TEMP TRIGGER reject_gc BEFORE INSERT ON storage_cleanups BEGIN SELECT raise(ABORT,'late transaction failure'); END");
  assert.throws(()=>retention.sweepUnpinnedDraftBlobs(owner,{commandId:"gc",expectedRevision:0}),/late transaction failure/);
  assert.ok(discarded.every(blob=>existsSync(blobs.filePath(blob.digest))));
  db.exec("DROP TRIGGER reject_gc");
  const result=retention.sweepUnpinnedDraftBlobs(owner,{commandId:"gc",expectedRevision:0});
  assert.equal(result.freedBytes,usage.reclaimableBytes);assert.equal(result.freedFiles,12);
  assert.equal(result.usage.reclaimableBytes,0);assert.equal(result.usage.revision,1);
  assert.deepEqual(retention.sweepUnpinnedDraftBlobs(owner,{commandId:"gc",expectedRevision:0}),result);
  assert.ok(rootIds.every(blob=>existsSync(blobs.filePath(blob.digest)) && blobs.get(owner,blob.id).id===blob.id));
  assert.ok(discarded.every(blob=>!existsSync(blobs.filePath(blob.digest))));
  assert.equal(blobs.get("other",other.id).digest,shared.digest);
  assert.equal(app.service.readRevision(owner,obsolete.artifactId,obsolete.revisionId).archivedAt,now);
  const archived=await app.app.inject({method:"GET",url:`/api/agent/v1/blobs/${discarded[0]!.id}/content`});
  assert.equal(archived.statusCode,410);assert.equal(archived.json().code,"MEDIA_ARCHIVED");
  const restore=Buffer.alloc(8192);restore.write("discard-0");
  const again=blobs.persist(owner,conversation,restore,"video/mp4",1000);
  assert.equal(again.id,discarded[0]!.id);assert.equal(app.service.readRevision(owner,obsolete.artifactId,obsolete.revisionId).archivedAt,undefined);
  // 模拟进程在文件改名后、事务提交前退出；下一次打开按真实登记恢复。
  const quarantined=path.join(dir,"blobs",".archiving");mkdirSync(quarantined,{recursive:true});
  renameSync(blobs.filePath(final.digest),path.join(quarantined,final.digest));
  new ProductionBlobs(db,dir,()=>now);
  assert.ok(existsSync(blobs.filePath(final.digest)));
  t.diagnostic(JSON.stringify({protected:rootIds.length,retained:rootIds.length,oldBytes:12*8192,reclaimedBytes:result.freedBytes,
    otherOwnerIntact:true,replay:result.usage.revision}));
});
