import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp,mkdir,realpath,rm,writeFile,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=join(import.meta.dirname,'..','..','..');
function validStats(dataset: 'live' | 'validation' = 'validation', days = 3) {
 const today = new Date().toISOString().slice(0, 10);
 const earlier = (offset: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - offset * 86400000).toISOString().slice(0, 10);
 return { coverage: 'received_only', status: 'no_received_data', watermark: 0, asOf: new Date().toISOString(), dataset, days,
   completeDays: { from: earlier(days), to: earlier(1), baselineDay: earlier(days + 1), overallAggregates: [], overallComparisons: [], aggregates: [], comparisons: [] },
   unlocatedByReceivedDay: [], unlocatedOverallByReceivedDay: [], todayInProgress: { day: today, comparison: false, overallReceivedAggregates: [], receivedAggregates: [] }, truncated: false };
}
async function run(args:string[],env:NodeJS.ProcessEnv, timeoutMs = 8000){return await new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-strip-types','packages/project-metrics/src/cli.ts',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='',err='';const timeout=setTimeout(()=>p.kill('SIGKILL'),timeoutMs);p.stdout.setEncoding('utf8').on('data',x=>out+=x);p.stderr.setEncoding('utf8').on('data',x=>err+=x);p.once('error',error=>{clearTimeout(timeout);reject(error);});p.once('close',code=>{clearTimeout(timeout);resolve({code,out,err});});});}
test('CLI validation and days flags affect the authorized read without enabling collection',async t=>{const dir=await mkdtemp(join(await realpath(tmpdir()),'metrics-cli-'));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));const requests:any[]=[];const server=createServer((req,res)=>{requests.push({url:req.url,auth:req.headers.authorization,namespace:req.headers['x-project-namespace']});if(req.url?.startsWith('/api/v2/')){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(validStats()));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;const write=join(dir,'write'),read=join(dir,'read'),config=join(dir,'config.json');await writeFile(write,'w'.repeat(40),{mode:0o600});await writeFile(read,'r'.repeat(40),{mode:0o600});await writeFile(config,JSON.stringify({enabled:false,endpoint,namespace:'cli-ns',dataset:'live',writeTokenFile:write,readTokenFile:read,outboxDir:join(dir,'outbox')}),{mode:0o600});const result=await run(['stats','--days','3','--validation'],{...process.env,PI_METRICS_CONFIG:config});assert.equal(result.code,0);assert.equal(result.err,'');const output=JSON.parse(result.out);assert.equal(output.local.enabled,false);assert.equal(output.local.pending,0);assert.equal(requests.length,2);assert.equal(requests[0].url,'/api/v2/project-stats?days=3&dataset=validation');assert.equal(requests[1].url,'/api/v1/project-stats?days=3&dataset=validation');assert.equal(requests[0].auth,'Bearer '+'r'.repeat(40));assert.equal(requests[0].namespace,'cli-ns');assert.equal(JSON.stringify(result).includes('w'.repeat(40)),false);});
test('CLI stats fail closed against extra response fields and token echoes even inside allowed labels', async t => {
 const dir = await mkdtemp(join(await realpath(tmpdir()), 'metrics-cli-echo-'));
 await chmod(dir, 0o700);
 t.after(() => rm(dir, { recursive: true, force: true }));
 let token = 'secret-read-token-'.repeat(3);
 let reply: unknown = validStats();
 const server = createServer((req, res) => {
   // Confirm the incoming request contains the secret without ever reflecting it to test output.
   assert.equal(req.headers.authorization, `Bearer ${token}`);
   if (req.url?.startsWith('/api/v2/')) { res.writeHead(404); res.end(); return; }
   res.writeHead(200, { 'content-type': 'application/json' });
   res.end(JSON.stringify(reply));
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
 const endpoint = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const write = join(dir, 'write'), read = join(dir, 'read'), config = join(dir, 'config.json');
 await writeFile(write, 'w'.repeat(40), { mode: 0o600 });
 await writeFile(read, token, { mode: 0o600 });
 await writeFile(config, JSON.stringify({ enabled: false, endpoint, namespace: 'cli-ns', dataset: 'validation', writeTokenFile: write, readTokenFile: read, outboxDir: join(dir, 'outbox') }), { mode: 0o600 });
 const env = { ...process.env, PI_METRICS_CONFIG: config };
 const valid = await run(['stats', '--validation', '--days', '3'], env);
 assert.equal(valid.code, 0);
 assert.equal(JSON.parse(valid.out).coverage, 'received_only');
 assert.equal(JSON.stringify(valid).includes(token), false);
 for (const forged of [
   { ...validStats(), authorization: `Bearer ${token}` },
   { ...validStats(), completeDays: { ...validStats().completeDays, aggregates: [{ day: validStats().completeDays.to, kind: 'background_generation', model: token, provider: null, eventCount: 0, knownCount: 1, unknownCount: 0, meanDurationMs: 7 }] } },
   { ...validStats(), todayInProgress: { ...validStats().todayInProgress, receivedAggregates: [{ day: validStats().todayInProgress.day, kind: 'background_generation', model: null, provider: `Bearer ${token}`, eventCount: 0, knownCount: 1, unknownCount: 0, meanDurationMs: 7 }] } },
 ]) {
   reply = forged;
   const rejected = await run(['stats', '--validation', '--days', '3'], env);
   assert.notEqual(rejected.code, 0);
   assert.equal(rejected.out, '');
   assert.equal(rejected.err, 'metrics command failed (stats_invalid_response); inspect private configuration and local status\n');
   assert.equal(JSON.stringify(rejected).includes(token), false);
 }
 token = 'secret-"\\-token'.repeat(3);
 await writeFile(read, token, { mode: 0o600 });
 reply = { ...validStats(), completeDays: { ...validStats().completeDays, aggregates: [{ day: validStats().completeDays.to, kind: 'background_generation', model: token, provider: null, eventCount: 0, knownCount: 1, unknownCount: 0, meanDurationMs: 7 }] } };
 const escaped = await run(['stats', '--validation', '--days', '3'], env);
 assert.notEqual(escaped.code, 0, 'JSON escaping cannot hide a secret echoed inside a valid field');
 assert.equal(escaped.out, '');
 assert.equal(escaped.err, 'metrics command failed (stats_invalid_response); inspect private configuration and local status\n');
});
test('CLI errors use fixed text and nonzero exit without printing secrets',async()=>{const secret='s'.repeat(40);const result=await run(['unknown'],{...process.env,PI_METRICS_CONFIG:undefined});assert.notEqual(result.code,0);assert.equal(result.out,'');assert.equal(result.err,'metrics command failed; inspect private configuration and local status\n');assert.equal(result.err.includes(secret),false);});

async function cliFixture(t: { after(fn: () => Promise<void>): void }, respond: (res: import('node:http').ServerResponse, req: import('node:http').IncomingMessage) => void) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'metrics-stats-cli-'));
  await chmod(dir, 0o700);
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((req, res) => respond(res, req));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = 'private-read-token-'.repeat(3), write = join(dir, 'write.token'), read = join(dir, 'read.token'), config = join(dir, 'config.json');
  await writeFile(write, 'w'.repeat(40), { mode: 0o600 });
  await writeFile(read, token, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ enabled: false, endpoint, namespace: 'private-namespace', dataset: 'validation', writeTokenFile: write, readTokenFile: read, outboxDir: join(dir, 'outbox') }), { mode: 0o600 });
  return { dir, endpoint, token, config, env: { ...process.env, PI_METRICS_CONFIG: config } };
}
function assertSafeError(result: { code: number | null; out: string; err: string }, code: string, values: string[]) {
  assert.equal(result.code, 1, `expected a completed CLI failure, not a killed/hung subprocess`);
  assert.equal(result.out, '', 'failed stats must not return an empty/success-shaped JSON result');
  assert.equal(result.err, `metrics command failed (${code}); inspect private configuration and local status\n`);
  for (const value of values) assert.equal(JSON.stringify(result).includes(value), false, 'private input cannot reach stdout or stderr');
}

test('real CLI distinguishes unauthorized, other HTTP, malformed/echoed and oversized stats responses without exposing private data', async t => {
  let status = 200, reply: string = JSON.stringify(validStats('validation', 1));
  const f = await cliFixture(t, res => { res.writeHead(status, { 'content-type': 'application/json', ...(status === 302 ? { location: 'https://private-target.invalid/path' } : {}) }); res.end(reply); });
  for (const [http, code] of [[401, 'stats_unauthorized'], [403, 'stats_unauthorized'], [503, 'stats_http_error'], [302, 'stats_transport']] as const) {
    status = http; reply = `private-server-error: ${f.token}`;
    assertSafeError(await run(['stats', '--days', '1', '--validation'], f.env), code, [f.token, f.config, f.endpoint, 'private-server-error']);
  }
  status = 200;
  for (const body of [JSON.stringify({ ...validStats('validation', 1), extra: f.token }), JSON.stringify({ ...validStats('validation', 1), completeDays: { ...validStats('validation', 1).completeDays, aggregates: [{ model: f.token }] } }), 'private-malformed-json']) {
    reply = body;
    assertSafeError(await run(['stats', '--days', '1', '--validation'], f.env), 'stats_invalid_response', [f.token, f.config, f.endpoint, 'private-malformed-json']);
  }
  reply = 'x'.repeat(2 * 1024 * 1024 + 1);
  assertSafeError(await run(['stats', '--days', '1', '--validation'], f.env), 'stats_body_too_large', [f.token, f.config, f.endpoint]);
  const missing = await run(['stats', '--days', '1', '--validation'], { ...f.env, PI_METRICS_CONFIG: join(f.dir, 'private-missing-config') });
  assertSafeError(missing, 'stats_configuration', [f.token, f.config, f.endpoint, 'private-missing-config']);
  const preload = join(f.dir, 'throwing-fetch.mjs');
  await writeFile(preload, `globalThis.fetch=()=>{const error=new Error(${JSON.stringify(f.token)});error.code='stats_timeout';throw error}`, { mode: 0o600 });
  const injected = await run(['stats', '--days', '1', '--validation'], { ...f.env, NODE_OPTIONS: `--import=${preload}` });
  assertSafeError(injected, 'stats_transport', [f.token, f.config, f.endpoint, preload]);
});

test('real unauthorized stats headers with an endless body close immediately instead of retaining the CLI socket', async t => {
  let closed = false;
  const f = await cliFixture(t, res => {
    res.once('close', () => { closed = true; });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.flushHeaders(); // deliberately never end the unauthorized body
  });
  const started = Date.now();
  const result = await run(['stats', '--days', '1', '--validation'], f.env, 2500);
  assertSafeError(result, 'stats_unauthorized', [f.token, f.config, f.endpoint]);
  assert.ok(Date.now() - started < 2500, 'headers suffice; no body read or five-second wait');
  assert.equal(closed, true, 'abort releases the native response/socket');
});

test('real CLI exits by the five-second stats body deadline and never prints a late response', async t => {
  let closeObserved = false, releaseLate!: () => void;
  const late = new Promise<void>(resolve => { releaseLate = resolve; });
  const f = await cliFixture(t, res => {
    res.once('close', () => { closeObserved = true; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders(); // native HTTP stream has headers but no body before deadline
    setTimeout(() => {
      try { if (!res.destroyed) res.end(JSON.stringify(validStats('validation', 1))); }
      finally { releaseLate(); }
    }, 5500);
  });
  const started = Date.now();
  const result = await run(['stats', '--days', '1', '--validation'], f.env, 7800);
  assertSafeError(result, 'stats_timeout', [f.token, f.config, f.endpoint]);
  assert.ok(Date.now() - started >= 4900 && Date.now() - started < 7000, 'real CLI must not wait for SDK body timeout');
  assert.equal(closeObserved, true, 'native response socket was aborted on deadline');
  await late;
  assert.equal(result.out, '', 'delayed server data cannot turn a finished CLI failure into JSON');
});
