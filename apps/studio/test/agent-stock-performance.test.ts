import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StockClient } from "../src/server/agent/stock-providers.js";
import { orderedResults } from "../src/server/agent/ordered-results.js";

const ids = [1,2,3,4,5,6];
const json = (body: unknown) => Response.json(body);
for (const provider of ["nasa","met","archive"] as const) {
  test(`OPT-03 ${provider} 六个同序候选的二级请求 P95 缩短六成`, async t => {
    async function measure(serial: boolean) {
      let waiting = Promise.resolve(), active = 0, peak = 0;
      const fetcher = async (address: string, init?: RequestInit) => {
        const u = new URL(address);
        if (u.pathname.endsWith("/search") || u.pathname.includes("advancedsearch")) {
          if (provider === "nasa") return json({ collection:{ items: ids.map(n => ({ data:[{ nasa_id:String(n), media_type:"image", center:"JSC" }] })) } });
          if (provider === "met") return json({ objectIDs: ids, total:6 });
          return json({ response:{ docs:ids.map(n => ({ identifier:String(n) })) } });
        }
        const id = Number(u.pathname.split("/").at(-1));
        const work = async () => {
          active++; peak=Math.max(active,peak);
          try { await delay(24 + (6-id),undefined,{signal:init?.signal ?? undefined}); }
          finally { active--; }
        };
        if (serial) { waiting = waiting.then(work); await waiting; } else await work();
        if (provider === "nasa") return json({collection:{items:[{href:`https://images-assets.nasa.gov/image/${id}~orig.jpg`}]}});
        if (provider === "met") return json({objectID:id,isPublicDomain:true,primaryImage:`https://images.metmuseum.org/${id}.jpg`,objectURL:`https://www.metmuseum.org/art/${id}`});
        return json({metadata:{identifier:String(id),mediatype:"movies",collection:["stock_footage"],licenseurl:"https://creativecommons.org/licenses/by/4.0/",creator:"Studio"},
          files:[{ name:`${id}.mp4`, format:"MPEG4",width:1280,height:720,size:12345,length:"3.1" }]});
      };
      const client = new StockClient({[provider]:{enabled:true,apiKey:null}},fetcher);
      const samples: number[] = [];
      for (let round=0; round<7; round++) {
        let n=0;
        const start=performance.now();
        const found=await client.search(provider,{query:"creation",kind:provider==="archive"?"video":"image",limit:6,newCandidateId:()=>String(++n)});
        samples.push(performance.now()-start);
        assert.deepEqual(found.map(row => row.candidate.providerAssetId),ids.map(String));
        assert.deepEqual(found.map(row => row.candidateId),ids.map(String));
      }
      return { p95:samples.sort((a,b)=>a-b).at(-1)!, peak };
    }
    const before=await measure(true), after=await measure(false);
    t.diagnostic(JSON.stringify({provider,before,after,reduction:1-after.p95/before.p95}));
    assert.equal(before.peak,1); assert.equal(after.peak,4); assert.ok(after.p95 < before.p95 * 0.4);
  });
}

test("OPT-03 满足排名靠前的候选后取消其余元数据请求，外部停止也传到四个请求", async () => {
  const cancelled: number[] = [];
  const values=await orderedResults(ids,1,undefined,async (n,signal) => {
    signal.addEventListener("abort",()=>cancelled.push(n),{once:true});
    await delay(n===1?4:200,undefined,{signal}); return n;
  });
  assert.deepEqual(values,[1]); assert.deepEqual(cancelled,[1,2,3,4]);
  const external=new AbortController();
  const search=orderedResults(ids,6,external.signal,async(n,signal)=>{await delay(200,undefined,{signal});return n;});
  external.abort(); await assert.rejects(search,{name:"AbortError"});
});

test("OPT-03 Incompetech 24h 内存与磁盘命中，过期用 ETag 和修改时间续期",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"frame-music-cache-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const tracks=Array.from({length:3500},(_,i)=>({title:`Track ${i}`,isrc:`US${i}`,filename:`${i}.mp3`,instruments:"piano",length:"00:01:05"}));
  const modified="Sun, 01 Nov 2026 09:00:00 GMT";
  let network=0;
  const fetcher=async()=>{network++;return Response.json(tracks,{headers:{etag:'"tracks-v1"',"last-modified":modified}});};
  const settings={incompetech:{enabled:true,apiKey:null}};
  const req={query:"Track 3499",kind:"audio" as const,limit:1,newCandidateId:()=>"candidate-1"};
  const client=new StockClient(settings,fetcher,root);
  assert.equal((await client.search("incompetech",req))[0]!.candidate.durationMs,65000);
  const start=performance.now();
  assert.equal((await client.search("incompetech",req))[0]!.candidate.title,"Track 3499");
  const warmMs=performance.now()-start;
  assert.ok(warmMs<5); assert.equal(network,1);
  const restarted=new StockClient(settings,async()=>{throw new Error("热磁盘缓存不应联网");},root);
  assert.equal((await restarted.search("incompetech",req)).length,1);
  const file=path.join(root,"incompetech-pieces.json"), disk=JSON.parse(await readFile(file,"utf8"));
  disk.fetchedAt=Date.now()-86_400_001; await writeFile(file,JSON.stringify(disk));
  const stale=new StockClient(settings,async(_url,init)=>{
    network++;
    const headers=new Headers(init?.headers);
    assert.equal(headers.get("if-none-match"),'"tracks-v1"'); assert.equal(headers.get("if-modified-since"),modified);
    return new Response(null,{status:304});
  },root);
  assert.equal((await stale.search("incompetech",req)).length,1);
  assert.equal(network,2);
  assert.ok(JSON.parse(await readFile(file,"utf8")).fetchedAt>disk.fetchedAt);
  t.diagnostic(JSON.stringify({catalogTracks:tracks.length,warmMs,network}));
});
