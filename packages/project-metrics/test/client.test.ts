import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { submitMetric, flushMetricQueue, metricsStatus, drainLocal, queryMetricStats } from '../src/client.ts';
import { canonicalTarget } from '../src/node-crypto.ts';
const id='4a19dc3b-8397-4d74-834f-a19ec67e891c';
async function sandbox(t:any){const root=await mkdtemp(join(await realpath(tmpdir()),'project-metrics-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function service(t:any,handler:(req:any,res:any)=>void){const s=createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>s.close(()=>r())));const a=s.address() as any;return `http://127.0.0.1:${a.port}`;}
async function setupConfig(root:string,endpoint:string,dataset:'live'|'validation'='live',enabled=true){const dir=join(root,dataset),outboxDir=join(dir,'outbox');await mkdir(dir,{recursive:true,mode:0o700});await mkdir(outboxDir,{recursive:true,mode:0o700});const writeTokenFile=join(dir,'write.token'),readTokenFile=join(dir,'read.token'),path=join(dir,`config-${canonicalTarget(endpoint,'test-namespace',dataset)}.json`);await writeFile(writeTokenFile,'w'.repeat(40),{mode:0o600});await writeFile(readTokenFile,'r'.repeat(40),{mode:0o600});await writeFile(path,JSON.stringify({enabled,endpoint,namespace:'test-namespace',dataset,writeTokenFile,readTokenFile,outboxDir}),{mode:0o600});return{path,outboxDir,target:join(outboxDir,canonicalTarget(endpoint,'test-namespace',dataset))};}
function event(eventId=id){return{schemaVersion:1,eventId,kind:'fast_enabled',occurredAt:'2025-01-01T00:00:00.000Z',dataset:'live'};}
async function withConfig(path:string,fn:()=>Promise<void>){const old=process.env.PI_METRICS_CONFIG;process.env.PI_METRICS_CONFIG=path;try{await fn();}finally{if(old===undefined)delete process.env.PI_METRICS_CONFIG;else process.env.PI_METRICS_CONFIG=old;}}

test('unset or disabled collection performs no token access, network, or outbox creation',async t=>{const root=await sandbox(t);const old=process.env.PI_METRICS_CONFIG;delete process.env.PI_METRICS_CONFIG;try{await submitMetric(event());assert.deepEqual(await metricsStatus(),{enabled:false,pending:null,failed:0,unknown:true});}finally{if(old!==undefined)process.env.PI_METRICS_CONFIG=old;}let calls=0;const endpoint=await service(t,(_q,r)=>{calls++;r.end('{}');});const c=await setupConfig(root,endpoint,'live',false);await withConfig(c.path,async()=>{await submitMetric(event());assert.equal((await metricsStatus()).pending,0);});assert.equal(calls,0);assert.deepEqual(await readdir(c.target).catch(()=>[]),[]);});
test('private outbox commits before background POST and only matching ACK unlinks it',async t=>{const root=await sandbox(t);let mode='bad',seen:string[]=[];const endpoint=await service(t,(req,res)=>{seen.push(req.headers.authorization);req.resume();req.on('end',()=>{res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify({eventId:mode==='bad'?'07ee11a9-4f53-4aa3-8287-57ec5be04755':id,status:mode==='duplicate'?'duplicate':'accepted'}));});});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await submitMetric(event());await drainLocal(1000);assert.ok((await metricsStatus()).pending>=1);mode='duplicate';await flushMetricQueue();await drainLocal(1000);assert.equal((await metricsStatus()).pending,0);});assert.ok(seen.every(x=>x==='Bearer '+'w'.repeat(40)));assert.equal(seen.some(x=>x.includes('r'.repeat(40))),false);});
test('a same-ID different local payload never replaces the committed outbox record',async t=>{const root=await sandbox(t);const endpoint=await service(t,(_q,r)=>{r.writeHead(500);r.end('');});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await submitMetric(event());await drainLocal();const path=join(c.target,`${id}.json`),before=await readFile(path,'utf8');await assert.rejects(submitMetric({...event(),occurredAt:'2025-01-02T00:00:00.000Z'}));assert.equal(await readFile(path,'utf8'),before);});});
test('target changes cannot rebind a captured event to another account/dataset',async t=>{const root=await sandbox(t);let gotA=0,gotB=0;const a=await service(t,(_q,r)=>{gotA++;r.writeHead(503);r.end('{}');});const b=await service(t,(_q,r)=>{gotB++;r.writeHead(202,{'content-type':'application/json'});r.end(JSON.stringify({eventId:id,status:'accepted'}));});const ca=await setupConfig(root,a),cb=await setupConfig(root,b);await withConfig(ca.path,async()=>{await submitMetric(event());await drainLocal();});await withConfig(cb.path,async()=>{assert.equal((await flushMetricQueue()).pending,0);assert.equal((await metricsStatus()).pending,0);});assert.equal(gotB,0);await withConfig(ca.path,async()=>{await flushMetricQueue();});assert.ok(gotA>=1);});
test('4xx conflict is permanent for the attempt and preserves the queued event',async t=>{const root=await sandbox(t);const endpoint=await service(t,(_q,r)=>{r.writeHead(409,{'content-type':'application/json'});r.end('{"error":"conflict"}');});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await submitMetric(event());await drainLocal();const result=await flushMetricQueue();assert.ok(result.pending>=1);assert.ok((await metricsStatus()).failed>=1);});});
test('permanent remote rejection is durably skipped until an explicit retry',async t=>{const root=await sandbox(t);let rejected=true,calls=0;const endpoint=await service(t,(req,res)=>{req.resume();req.on('end',()=>{calls++;res.writeHead(rejected?409:202,{'content-type':'application/json'});res.end(JSON.stringify({eventId:id,status:rejected?'conflict':'accepted'}));});});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await submitMetric(event());await drainLocal();await flushMetricQueue();assert.ok((await metricsStatus()).failed>=1);const before=calls;await flushMetricQueue();assert.equal(calls,before,'permanent conflicts are not automatically retried');rejected=false;const result=await flushMetricQueue(true);assert.equal(result.pending,0);assert.equal(calls,before+1);assert.equal((await metricsStatus()).pending,0);});});
test('blocked first 16 and an empty 409 do not starve later events or retry on new submissions', async t => {
  const root = await sandbox(t);
  const attempts = new Map<string, number>();
  const later = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  let delivered!: () => void;
  const deliveredPromise = new Promise<void>(resolve => { delivered = resolve; });
  let accept = false;
  const endpoint = await service(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const eventId = JSON.parse(Buffer.concat(chunks).toString()).event.eventId as string;
      attempts.set(eventId, (attempts.get(eventId) ?? 0) + 1);
      if (eventId === later) delivered();
      res.writeHead(accept ? 202 : 409, { 'content-type': 'application/json' });
      res.end(accept ? JSON.stringify({ eventId, status: 'accepted' }) : '');
    });
  });
  const c = await setupConfig(root, endpoint);
  await withConfig(c.path, async () => {
    const rejected = Array.from({ length: 16 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
    await submitMetric(event(rejected[0]));
    await drainLocal();
    await flushMetricQueue();
    assert.equal(attempts.get(rejected[0]), 1, 'empty 409 is persisted without reading an ACK');
    assert.ok((await readdir(c.target)).includes(`.blocked-${rejected[0]}`));
    // Already-committed rejected entries are a deterministic queue fixture, not
    // 15 competing background HTTP tasks whose completion order hides starvation.
    for (const eventId of rejected.slice(1)) {
      await writeFile(join(c.target, `${eventId}.json`), JSON.stringify({ targetId: canonicalTarget(endpoint, 'test-namespace', 'live'), endpoint, namespace: 'test-namespace', dataset: 'live', event: event(eventId) }), { mode: 0o600 });
      await writeFile(join(c.target, `.blocked-${eventId}`), 'permanent_remote_rejection', { mode: 0o600 });
    }
    accept = true;
    await submitMetric(event(later));
    await drainLocal();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([deliveredPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('later_event_starved')), 2500); })]); }
    finally { if (timer) clearTimeout(timer); }
    assert.equal(attempts.get(later), 1, 'new-event automatic flush passes the first 16 blocked entries');
    assert.equal(attempts.get(rejected[0]), 1);
    assert.ok(rejected.slice(1).every(eventId => !attempts.has(eventId)));
    const result = await flushMetricQueue();
    assert.equal(result.pending, 16);
    assert.equal(attempts.get(rejected[0]), 1);
    assert.ok(rejected.slice(1).every(eventId => !attempts.has(eventId)));
    const retry = await flushMetricQueue(true);
    assert.equal(retry.sent, 16, 'explicit retry is still one bounded batch');
    assert.equal(retry.pending, 0);
    assert.equal(attempts.get(rejected[0]), 2);
    assert.ok(rejected.slice(1).every(eventId => attempts.get(eventId) === 1));
  });
});

test('target diagnostics do not follow a changed account or dataset; restart retains durable blocked evidence', async t => {
  const root = await sandbox(t);
  const a = await service(t, (_req, res) => { res.writeHead(409); res.end(); });
  const b = await service(t, (req, res) => {
    if (req.url?.startsWith('/api/v2/project-stats')) { res.writeHead(404); res.end(); return; }
    if (req.url?.startsWith('/api/v1/project-stats')) {
      const today = new Date().toISOString().slice(0, 10);
      const earlier = (days: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - days * 86400000).toISOString().slice(0, 10);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ coverage: 'received_only', status: 'no_received_data', watermark: 0, asOf: new Date().toISOString(), dataset: 'live', days: 7, completeDays: { from: earlier(7), to: earlier(1), baselineDay: earlier(8), overallAggregates: [], overallComparisons: [], aggregates: [], comparisons: [] }, unlocatedByReceivedDay: [], unlocatedOverallByReceivedDay: [], todayInProgress: { day: today, comparison: false, overallReceivedAggregates: [], receivedAggregates: [] }, truncated: false }));
    } else { res.writeHead(503); res.end(); }
  });
  const ca = await setupConfig(root, a);
  const cb = await setupConfig(root, b);
  const cv = await setupConfig(root, a, 'validation');
  await withConfig(ca.path, async () => {
    await submitMetric(event());
    await drainLocal();
    await flushMetricQueue();
    assert.ok((await metricsStatus()).failed > 0);
  });
  for (const config of [cb, cv]) await withConfig(config.path, async () => {
    const status = await metricsStatus();
    assert.equal(status.pending, 0);
    assert.equal(status.failed, 0, 'A failure must not be attributed to B or validation');
    assert.equal(status.unknown, true);
    if (config === cb) {
      const stats = await queryMetricStats() as { local: { failed: number; pending: number; unknown: boolean }; coverage: string };
      assert.equal(stats.local.failed, 0);
      assert.equal(stats.local.pending, 0);
      assert.equal(stats.local.unknown, true);
      assert.equal(stats.coverage, 'received_only');
    }
  });
  const moduleUrl = new URL('../src/client.ts', import.meta.url).href;
  const script = `import {metricsStatus} from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify(await metricsStatus()));`;
  const restarted = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { env: { ...process.env, PI_METRICS_CONFIG: ca.path }, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => output += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  assert.equal(restarted.code, 0);
  assert.equal(JSON.parse(restarted.output).pending, 1);
  assert.ok(JSON.parse(restarted.output).failed >= 1, 'durable blocked marker survives restart');
  await withConfig(cb.path, async () => {
    await chmod(cb.outboxDir, 0o755);
    const status = await metricsStatus();
    assert.equal(status.pending, null);
    assert.equal(status.unknown, true);
    assert.equal(status.failed, 0);
  });
});

test('timeout covers response body and outbox survives unknown ACK outcome',async t=>{const root=await sandbox(t);let calls=0;const endpoint=await service(t,(req,res)=>{req.resume();req.on('end',()=>{calls++;res.writeHead(202,{'content-type':'application/json'});if(calls===1)res.end('{"eventId":"wrong","status":"accepted"}');else res.write('{"eventId":');});});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await submitMetric(event());await drainLocal();const start=Date.now();const status=await flushMetricQueue();assert.ok(Date.now()-start<6000);assert.ok(status.pending>=1);assert.ok(status.failed>=1);});});
test('oversized ACK, redirects, and transport errors preserve queued events and never follow another origin',async t=>{const root=await sandbox(t);let redirected=0,destination=0;const target=await service(t,(_q,r)=>{redirected++;r.writeHead(302,{location:`http://127.0.0.1:${destinationPort}/capture`});r.end();});const destinationServer=createServer((_q,r)=>{destination++;r.end('{}');});await new Promise<void>(r=>destinationServer.listen(0,'127.0.0.1',r));const destinationPort=(destinationServer.address() as any).port;t.after(()=>new Promise<void>(r=>destinationServer.close(()=>r())));const huge=await service(t,(_q,r)=>{r.writeHead(202,{'content-type':'application/json'});r.end('x'.repeat(4096));});for(const endpoint of [target,huge,'http://127.0.0.1:1']){const c=await setupConfig(root,endpoint,'validation');await mkdir(c.target,{recursive:true,mode:0o700});await writeFile(join(c.target,`${id}.json`),JSON.stringify({targetId:canonicalTarget(endpoint,'test-namespace','validation'),endpoint:new URL(endpoint).origin,namespace:'test-namespace',dataset:'validation',event:{...event(),dataset:'validation'}}),{mode:0o600});await withConfig(c.path,async()=>{const result=await flushMetricQueue();assert.equal(result.pending,1);assert.ok(result.failed>=1);});}assert.equal(redirected,1);assert.equal(destination,0);});
test('process queue caps in-memory work and bounded live locks are never stolen',async t=>{const root=await sandbox(t);const endpoint=await service(t,(_q,r)=>{r.writeHead(503);r.end('');});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await mkdir(c.target,{mode:0o700});const lock=join(c.target,'.lock'),body=JSON.stringify({pid:process.pid,nonce:'held-by-live-owner'});await writeFile(lock,body,{mode:0o600});const started=Date.now();await assert.rejects(submitMetric(event()),/outbox_locked/u);assert.ok(Date.now()-started<1500);assert.equal(await readFile(lock,'utf8'),body);await rm(lock);const attempts=Array.from({length:40},()=>submitMetric({...event(randomUUID()),occurredAt:new Date().toISOString()}));const results=await Promise.allSettled(attempts);const committed=results.filter(r=>r.status==='fulfilled').length;assert.ok(committed>0&&committed<=32);assert.equal(results.filter(r=>r.status==='rejected'&&(r.reason as Error).message==='metrics_queue_full').length,8);assert.equal((await metricsStatus()).pending,committed);await drainLocal(1000);});});
test('separate processes share one private outbox without overwriting or losing committed events',async t=>{const root=await sandbox(t);const endpoint=await service(t,(_q,r)=>{r.writeHead(503);r.end('');});const c=await setupConfig(root,endpoint);const moduleUrl=new URL('../src/client.ts',import.meta.url).href;const script=`import {randomUUID} from 'node:crypto';import {submitMetric,drainLocal} from ${JSON.stringify(moduleUrl)};await submitMetric({schemaVersion:1,eventId:randomUUID(),kind:'fast_enabled',occurredAt:new Date().toISOString(),dataset:'live'});await drainLocal();`;const execute=()=>new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{env:{...process.env,PI_METRICS_CONFIG:c.path},stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.setEncoding('utf8').on('data',s=>stderr+=s);child.once('error',reject);child.once('close',code=>resolve(code));});await withConfig(c.path,async()=>{await Promise.all([execute(),execute()]).then(codes=>assert.deepEqual(codes,[0,0]));assert.equal((await metricsStatus()).pending,2);assert.equal((await readdir(c.target)).filter(n=>n.endsWith('.json')).length,2);});});
test('stale dead-owner locks are reclaimed, while live symlink locks are preserved',async t=>{const root=await sandbox(t);let markPosted!:()=>void;const posted=new Promise<void>(resolve=>markPosted=resolve);const endpoint=await service(t,(req,r)=>{req.resume();req.on('end',()=>{r.writeHead(500);r.end('');markPosted();});});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await mkdir(c.target,{mode:0o700});const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);await new Promise<void>(resolve=>child.once('spawn',()=>resolve()));const deadPid=child.pid!;child.kill();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));const stale=join(c.target,'.lock');await writeFile(stale,JSON.stringify({pid:deadPid,nonce:'dead-owner'}),{mode:0o600});await submitMetric(event());await posted;assert.equal((await metricsStatus()).pending,1);await rm(stale).catch(()=>{});const outside=join(root,'foreign-lock');await writeFile(outside,'untouched',{mode:0o600});await symlink(outside,stale);await assert.rejects(submitMetric({...event(),eventId:'07ee11a9-4f53-4aa3-8287-57ec5be04755'}),/outbox_locked/u);assert.equal(await readFile(outside,'utf8'),'untouched');});});
test('target-mismatched envelope is retained and never sent using current account credentials',async t=>{const root=await sandbox(t);let calls=0;const endpoint=await service(t,(_q,r)=>{calls++;r.writeHead(202);r.end('{}');});const c=await setupConfig(root,endpoint);await mkdir(c.target,{mode:0o700});await writeFile(join(c.target,`${id}.json`),JSON.stringify({targetId:'wrong',endpoint,namespace:'test-namespace',dataset:'live',event:event()}),{mode:0o600});await withConfig(c.path,async()=>{const result=await flushMetricQueue();assert.equal(result.pending,1);assert.ok(result.failed>=1);});assert.equal(calls,0);});
test('outbox capacity is enforced under lock and never evicts old files',async t=>{const root=await sandbox(t);const endpoint='https://metrics.example';const c=await setupConfig(root,endpoint);await mkdir(c.target,{recursive:true,mode:0o700});const second=join(c.outboxDir,canonicalTarget('https://other.example','test-namespace','live'));await mkdir(second,{mode:0o700});for(let i=0;i<256;i++){await writeFile(join(c.target,`${i}.json`),'x',{mode:0o600});await writeFile(join(second,`${i}.json`),'x',{mode:0o600});}await withConfig(c.path,async()=>{await assert.rejects(submitMetric(event()),/outbox_full/u);});assert.equal((await readdir(c.target)).length,256);assert.equal((await readdir(second)).length,256);});
test('symlinked outbox path refuses writes',async t=>{const root=await sandbox(t);const endpoint='https://metrics.example';const c=await setupConfig(root,endpoint);const outside=join(root,'outside');await mkdir(outside,{mode:0o700});await rm(c.outboxDir,{recursive:true});await symlink(outside,c.outboxDir);await withConfig(c.path,async()=>{await assert.rejects(submitMetric(event()));});assert.deepEqual(await readdir(outside),[]);});
test('all persisted records are private bounded target envelopes',async t=>{const root=await sandbox(t);const endpoint=await service(t,(_q,r)=>{r.writeHead(500);r.end('');});const c=await setupConfig(root,endpoint);await withConfig(c.path,async()=>{await submitMetric(event());await drainLocal();await flushMetricQueue();});const names=await readdir(c.target);assert.equal(names.length,1);const raw=await readFile(join(c.target,names[0]),'utf8');assert.ok(Buffer.byteLength(raw)<16*1024);assert.equal(JSON.parse(raw).targetId,canonicalTarget(endpoint,'test-namespace','live'));});
