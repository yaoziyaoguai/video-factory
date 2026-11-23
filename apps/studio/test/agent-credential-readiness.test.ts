import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS, openAgentDatabase } from "../src/server/agent/db.js";
import { rotateCredentialSecret } from "../src/server/agent/credential-cipher.js";
import { captureStockConfigs, readFreeServiceSettings, saveKeyedServiceSettings } from "../src/server/agent/free-service-settings.js";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { CreativeRunner } from "../src/server/agent/creative-runner.js";
import { defaultSkillsRoot } from "../src/server/agent/offline.js";
import { buildFrameApp } from "../src/server/agent/app.js";

test("ISS-10 OPT-06 v28 五种旧凭据迁移、重开与轮换，数据库、WAL 与备份无测试密钥明文", async t => {
  const temp=await mkdtemp(path.join(tmpdir(),"frame-cipher-"));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const data=path.join(temp,"workspace"),backup=path.join(temp,"backup");
  await mkdir(data);await mkdir(backup,{mode:0o700});
  const file=path.join(data,"agent.db"), old=new Database(file);
  old.exec("CREATE TABLE agent_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const now="2026-11-22T00:00:00.000Z";
  for (const m of MIGRATIONS.filter(m=>m.version<=28)) old.transaction(()=>{
    for (const sql of m.statements) old.exec(sql);
    m.data?.(old);old.prepare("INSERT INTO agent_schema_migrations VALUES(?,?)").run(m.version,now);
  })();
  const marker="sk-fixture-"+randomBytes(16).toString("hex");
  old.prepare("INSERT INTO text_model_versions(configuration_revision_id,binding_json,configuration_json,api_key,created_at) VALUES('t','{}','{}',?,?)").run(marker+"1",now);
  old.prepare("INSERT INTO ark_video_configuration_versions(configuration_revision_id,binding_json,profile_json,api_key,created_at) VALUES('v','{}','{}',?,?)").run(marker+"2",now);
  old.prepare("INSERT INTO additional_media_versions(configuration_revision_id,channel_id,binding_json,profile_json,api_key,created_at) VALUES('a','openai-image','{}','{}',?,?)").run(marker+"3",now);
  old.prepare("INSERT INTO free_service_settings(service_id,revision,config_json,api_key,updated_at) VALUES('pexels',1,'{\"enabled\":true}',?,?)").run(marker+"4",now);
  old.prepare("INSERT INTO provider_connections VALUES('p',?)").run(JSON.stringify({id:"p",protocol:"openai",models:[],apiKey:marker+"5"}));
  old.close();
  assert.ok((await readFile(file)).includes(marker));
  const previous=process.env.FRAME_CREDENTIAL_SECRET;
  t.after(()=>{if(previous===undefined) delete process.env.FRAME_CREDENTIAL_SECRET;else process.env.FRAME_CREDENTIAL_SECRET=previous;});
  const secret=randomBytes(32).toString("base64url"), next=randomBytes(32).toString("base64url");
  process.env.FRAME_CREDENTIAL_SECRET=secret;
  let db=openAgentDatabase(data);
  const select=`SELECT api_key AS secret FROM text_model_versions UNION ALL SELECT api_key FROM ark_video_configuration_versions
    UNION ALL SELECT api_key FROM additional_media_versions UNION ALL SELECT api_key FROM free_service_settings
    UNION ALL SELECT json_extract(configuration_json,'$.apiKey') FROM provider_connections`;
  const encrypted=db.prepare(select).pluck().all() as string[];
  assert.equal(encrypted.length,5);assert.ok(encrypted.every(raw=>raw.startsWith("enc:v1:")));
  assert.deepEqual(db.prepare(`SELECT frame_open(secret) FROM (${select})`).pluck().all(),[1,2,3,4,5].map(n=>marker+n));
  const receipt=saveKeyedServiceSettings(db,()=>now,"owner","pexels",{commandId:"change",expectedRevision:1,enabled:true,apiKey:marker+"new"});
  assert.equal(JSON.stringify(receipt).includes(marker),false);
  assert.equal(JSON.stringify(readFreeServiceSettings(db,"pexels")).includes(marker),false);
  assert.equal(captureStockConfigs(db).pexels?.apiKey,marker+"new");
  for (const name of await readdir(data)) assert.equal((await readFile(path.join(data,name))).includes(marker),false,name);
  const ciphertext=db.prepare("SELECT api_key FROM free_service_settings WHERE service_id='pexels'").pluck().get() as string;
  const parts=ciphertext.split(":");const tag=Buffer.from(parts[3]!,"base64url");tag[0]=tag[0]! ^ 1;parts[3]=tag.toString("base64url");
  db.prepare("UPDATE free_service_settings SET api_key=? WHERE service_id='pexels'").run(parts.join(":"));
  assert.throws(()=>captureStockConfigs(db),/认证失败/);
  db.prepare("UPDATE free_service_settings SET api_key=? WHERE service_id='pexels'").run(ciphertext);
  rotateCredentialSecret(db,secret,next);db.close();
  assert.throws(()=>openAgentDatabase(data),/认证失败/);
  delete process.env.FRAME_CREDENTIAL_SECRET;assert.throws(()=>openAgentDatabase(data),/已加密/);
  process.env.FRAME_CREDENTIAL_SECRET=next;db=openAgentDatabase(data);
  assert.equal(captureStockConfigs(db).pexels?.apiKey,marker+"new");
  db.close();
  const helper=path.resolve("../../scripts/frame-workspace-backup.sh"), keys=path.join(temp,"identity");
  // 在迁移前卷可能还含导入源。备份往返比较的内容中故意放一个独立标记。
  const original=Buffer.from(marker+"archive");await writeFile(path.join(data,"imported-source"),original);
  const up=execFileSync("bash",["-e","-o","pipefail","-c",`umask 077; source "$1"; frame_backup_prepare "$2"; frame_backup_write "$3" "$4"; frame_backup_decode "$4/$frame_archive_name" | tar xzOf - ./imported-source`,"frame",helper,keys,data,backup],
    {env:{PATH:process.env.PATH}});assert.deepEqual(up,original);
  const archive=path.join(backup,"workspace.tar.gz.cms");
  assert.ok(!(await readFile(archive)).includes(marker));assert.equal((await stat(archive)).mode & 0o777,0o600);
  t.diagnostic("5/5 张表密文，SQLite/WAL/备份均未检出测试密钥。错误密钥、被修改的 tag 和丢失主密钥均被拒绝。");
});

test("OPT-06 实际写锁和宿主 socket 断连在三秒内反映到 HTTP，进程活性独立",async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),"frame-probe-")),socket=path.join(dir,"runner.sock");
  const server=createServer(connection=>connection.end());
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  const runtime=await createAgentRuntime({dataDir:dir,skillsRoot:defaultSkillsRoot,host:{},models:[],defaultModelId:"none",creative:{runner:new CreativeRunner({socketPath:socket})}});
  const app=buildFrameApp({agent:{service:runtime.service,uiOrigin:"http://127.0.0.1",resolveOwner:()=>"owner"}});
  t.after(async()=>{if(server.listening) await new Promise<void>(r=>server.close(()=>r()));await app.close();await runtime.close();await rm(dir,{recursive:true,force:true});});
  const health=()=>app.inject({method:"GET",url:"/api/health"});
  assert.deepEqual((await health()).json().readiness,{database:"ready",creativeRunner:"ready"});
  const db2=new Database(path.join(dir,"agent.db"));db2.exec("BEGIN IMMEDIATE");
  const start=performance.now();
  try { const locked=await health();assert.equal(locked.statusCode,503);assert.equal(locked.json().readiness.database,"busy");assert.equal(locked.json().liveness,"ok"); }
  finally {db2.exec("ROLLBACK");db2.close();}
  const lockMs=performance.now()-start;assert.ok(lockMs<3000);
  await new Promise<void>(r=>server.close(()=>r()));
  const disconnectedAt=performance.now(),disconnected=await health(),disconnectMs=performance.now()-disconnectedAt;
  assert.equal(disconnected.statusCode,503);assert.equal(disconnected.json().readiness.creativeRunner,"unavailable");assert.ok(disconnectMs<3000);
  assert.ok(!disconnected.body.includes(dir));t.diagnostic(JSON.stringify({lockMs,disconnectMs}));
});
