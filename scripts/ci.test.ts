import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anchors, stripCode, checkMarkdown } from './ci/markdown-links.mjs';
import { createSnapshotTools } from './ci/snapshot-tools.mjs';
import { createGitSnapshot } from './ci/git-snapshot.mjs';
import { applySnapshotCoverage, buildAggregateReviewResult, buildReviewControllerOutputs, formatReviewControllerOutputs, validateAxisResult, validateReviewResult, isSuccessfulAssistantChain, parseSuccessfulAxis } from './ci/review-contract.mjs';
import { finalizeReview } from './ci/review-lifecycle.mjs';
import { saveRefreshedAuth } from './ci/save-auth.mjs';
import { EventEmitter } from 'node:events';
import { chmod } from 'node:fs/promises';
import { githubRequest } from './ci/github-api.mjs';
import { validateReviewPreflight } from './ci/review-preflight.mjs';
import { parseOAuthCredential } from './ci/oauth-credential.mjs';
import { createReviewBudget } from './ci/review-budget.mjs';
import { createReviewSpecTools } from './ci/spec-tools.mjs';
import { collectIssueNumbers, hasMeaningfulSpec, loadReviewSpecification, ReviewSpecError, resolveReviewSpec } from './ci/review-spec.mjs';
import { appendBlockedSummary, appendCandidateSummary, appendFinalSummary, formatCandidateSummary } from './ci/review-summary.mjs';
import { authorizeTrigger } from './ci/policy.mjs';
import { authorize } from './ci/authorize.mjs';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GitHub API response contract', () => {
  it('preserves Authorization on POST and rejects body/status disagreement', async () => {
    let seen;
    const fetchImpl=async (_url,options)=>{seen=options; return {status:201,ok:true,json:async()=>({status:500,url:'status'})};};
    await assert.rejects(githubRequest({fetchImpl,repo:'owner/repo',token:'secret',path:'statuses/abc',options:{method:'POST',body:'{}'}}),/mismatch/);
    assert.equal(seen.headers.authorization,'Bearer secret');
    assert.equal(seen.method,'POST');
  });
});

describe('CI authorization entrypoint', () => {
  it('writes GITHUB_OUTPUT, binds PR/main, and keeps status authorization header on POST', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'authorize-test-'));
    try {
      const eventPath = join(dir, 'event.json'); const outputPath = join(dir, 'out');
      await writeFile(eventPath, JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'ZHOUKAILIAN/repo' } }));
      const calls = [];
      const fetchImpl = async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/pulls/8')) return { ok: true, status: 200, json: async () => ({ number: 8, state: 'open', user: { login: 'external-user' }, head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repo: { full_name: 'external-user/fork', owner: { login: 'external-user' }, name: 'fork' } }, base: { ref: 'main', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', repo: { full_name: 'ZHOUKAILIAN/repo', owner: {login:'ZHOUKAILIAN'}, name:'repo' } } }) };
        if (url.endsWith('/branches/main')) return { ok: true, status: 200, json: async () => ({ commit: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }) };
        return { ok: true, status: 201, json: async () => ({}) };
      };
      const git = (_cmd, args) => { if (args[0] === 'merge-base') return; };
      const result = await authorize({ env: { EVENT_PATH: eventPath, EVENT_NAME: 'workflow_dispatch', ACTOR: 'ZHOUKAILIAN', TRIGGERING_ACTOR: 'ZHOUKAILIAN', INPUT_PR: '8', REPOSITORY: 'ZHOUKAILIAN/repo', GH_TOKEN: 'test-token', GITHUB_OUTPUT: outputPath }, fetchImpl, git });
      assert.equal(result.eligible, 'true');
      const reviewedPr = await fetchImpl('https://api.github.com/repos/ZHOUKAILIAN/repo/pulls/8').then((response) => response.json());
      assert.deepEqual(validateReviewPreflight({ pr: reviewedPr, main: {commit:{sha:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}}, repository:'ZHOUKAILIAN/repo', expectedHead:result.head, expectedBase:result.base, expectedNumber:result.pr, dispatch:true }), {head:result.head,base:result.base});
      assert.match(await readFile(outputPath, 'utf8'), /eligible=true[\s\S]*dispatch=true/);
      const post = calls.find(({ options }) => options.method === 'POST');
      assert.equal(post.options.headers.authorization, 'Bearer test-token');
      assert.equal(JSON.parse(post.options.body).state, 'pending');
      assert.ok(post.url.endsWith('/statuses/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects blocked event and GitHub HTTP errors', async () => {
    assert.equal(authorizeTrigger({ event: {}, eventName: 'push', actor: 'ZHOUKAILIAN', triggeringActor: 'ZHOUKAILIAN', repository: 'ZHOUKAILIAN/repo' }).eligible, false);
    const dir = await mkdtemp(join(tmpdir(), 'authorize-test-'));
    try {
      const eventPath = join(dir, 'event.json'); await writeFile(eventPath, JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'ZHOUKAILIAN/repo' } }));
      await assert.rejects(authorize({ env: { EVENT_PATH: eventPath, EVENT_NAME: 'workflow_dispatch', ACTOR: 'ZHOUKAILIAN', TRIGGERING_ACTOR: 'ZHOUKAILIAN', INPUT_PR: '8', REPOSITORY: 'ZHOUKAILIAN/repo', GH_TOKEN: 'x' }, fetchImpl: async () => ({ ok: false, status: 503 }), git: () => {} }), /503/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('CI trigger authorization policy', () => {
  const repo = 'ZHOUKAILIAN/my-pi-extension-owner-ai-ci';
  const event = (author = 'ZHOUKAILIAN', headRepo = repo) => ({ pull_request: { number: 7, user: { login: author }, head: { repo: { full_name: headRepo } } } });
  it('allows only same-repository owner PR runs with owner actor and triggering actor', () => {
    assert.equal(authorizeTrigger({ event: event(), eventName: 'pull_request_target', actor: 'ZHOUKAILIAN', triggeringActor: 'ZHOUKAILIAN', repository: repo }).eligible, true);
    for (const input of [
      { event: event('outsider'), actor: 'ZHOUKAILIAN', triggeringActor: 'ZHOUKAILIAN' },
      { event: event(), actor: 'outsider', triggeringActor: 'ZHOUKAILIAN' },
      { event: event(), actor: 'ZHOUKAILIAN', triggeringActor: 'outsider' },
      { event: event('ZHOUKAILIAN', 'outsider/fork'), actor: 'ZHOUKAILIAN', triggeringActor: 'ZHOUKAILIAN' },
    ]) assert.equal(authorizeTrigger({ ...input, eventName: 'pull_request_target', repository: repo }).eligible, false);
  });
  it('requires owner-authored same-repository automatic PRs, while owner dispatch allows external fork authors', () => {
    const main = {commit:{sha:'b'.repeat(40)}};
    const forkPr = {number:8,state:'open',user:{login:'external-user'},head:{sha:'a'.repeat(40),repo:{full_name:'external-user/fork',owner:{login:'external-user'},name:'fork'}},base:{ref:'main',sha:'b'.repeat(40),repo:{full_name:repo,owner:{login:'ZHOUKAILIAN'},name:'my-pi-extension-owner-ai-ci'}}};
    assert.doesNotThrow(() => validateReviewPreflight({pr:forkPr,main,repository:repo,expectedHead:'a'.repeat(40),expectedBase:'b'.repeat(40),expectedNumber:8,dispatch:true}));
    assert.throws(() => validateReviewPreflight({pr:forkPr,main,repository:repo,expectedHead:'a'.repeat(40),expectedBase:'b'.repeat(40),expectedNumber:8,dispatch:false}),/Automatic review/);
    assert.throws(() => validateReviewPreflight({pr:{...forkPr,state:'closed'},main,repository:repo,expectedHead:'a'.repeat(40),expectedBase:'b'.repeat(40),expectedNumber:8,dispatch:true}),/not open/);
    assert.throws(() => validateReviewPreflight({pr:{...forkPr,head:{...forkPr.head,repo:{...forkPr.head.repo,name:'other'}}},main,repository:repo,expectedHead:'a'.repeat(40),expectedBase:'b'.repeat(40),expectedNumber:8,dispatch:true}),/repository binding/);
  });
  it('allows dispatch only from main with a numeric PR number and both owner identities', () => {
    const dispatch = { repository: { full_name: repo }, ref: 'refs/heads/main' };
    const args = { event: dispatch, eventName: 'workflow_dispatch', actor: 'ZHOUKAILIAN', triggeringActor: 'ZHOUKAILIAN', repository: repo, inputPr: '12' };
    assert.equal(authorizeTrigger(args).eligible, true);
    for (const change of [{ event: { ...dispatch, ref: 'refs/heads/feature' } }, { inputPr: 'abc' }, { actor: 'outsider' }, { triggeringActor: 'outsider' }]) assert.equal(authorizeTrigger({ ...args, ...change }).eligible, false);
  });
});

describe('strict review contract', () => {
  const paths = ['docs/guide.md'];
  const fingerprint='a'.repeat(64);
  const axis = (name, patch = {}) => ({ axis: name, status: 'PASSED', findings: [], uncovered: [], coverage: [{source:'diff',path:null,start:1,end:2,note:'diff lines inspected'}], reason: '', ...patch });
  const aggregate=(reviews,patch={})=>buildAggregateReviewResult({head:'h',base:'b',model:'m',changedPaths:paths,specFingerprint:fingerprint,reviews,...patch});
  const validate=(result,changedPaths=paths,specFingerprintValue=fingerprint)=>validateReviewResult(result,{head:'h',base:'b',model:'m',changedPaths,specFingerprint:specFingerprintValue});
  it('binds both axes and permits NA only from authoritative pure-doc paths', () => {
    const result=aggregate([axis('five-layer consistency'),axis('code review',{status:'NOT_APPLICABLE',reason:'docs only'})]);
    assert.equal(result.status,'PASSED'); assert.deepEqual(validate(result),[]);
    assert.ok(validate(result,['src/a.ts']).length);
    assert.ok(validate({...result,reviews:[result.reviews[1],result.reviews[0]]}).length);
  });
  it('binds the producer fingerprint to the authoritative source and rejects missing, wrong and extra aggregate fields', () => {
    const result=aggregate([axis('five-layer consistency'),axis('code review')]);
    assert.deepEqual(validate(result),[]);
    assert.deepEqual(buildReviewControllerOutputs(result,{head:'h',base:'b',model:'m',changedPaths:paths,specFingerprint:fingerprint}),{result:'PASSED',specFingerprint:fingerprint});
    const {specFingerprint:_missing,...missing}=result;
    assert.ok(validate(missing).some((error)=>error.includes('exact aggregate schema')));
    assert.ok(validate({...result,specFingerprint:'b'.repeat(64)}).includes('source specification fingerprint mismatch'));
    assert.ok(validate({...result,specFingerprint:'not-a-fingerprint'}).includes('source specification fingerprint mismatch'));
    assert.ok(validate(result,paths,'b'.repeat(64)).includes('source specification fingerprint mismatch'));
    assert.ok(validateReviewResult(result,{head:'h',base:'b',model:'m',changedPaths:paths,specFingerprint:undefined}).includes('source specification fingerprint mismatch'));
    assert.ok(validate({...result,extra:true}).some((error)=>error.includes('exact aggregate schema')));
    assert.throws(()=>buildReviewControllerOutputs({...result,specFingerprint:'b'.repeat(64)},{head:'h',base:'b',model:'m',changedPaths:paths,specFingerprint:fingerprint}),/source specification fingerprint mismatch/);
  });
  it('rejects bad finding lines, severity, empty strings, missing coverage, and false aggregate status', () => {
    for (const finding of [{ severity: 'P9', path: 'x', line: 1, evidence: 'e', impact: 'i', closure: 'c', mustFix: false }, { severity: 'P2', path: 'x', line: 0, evidence: 'e', impact: 'i', closure: 'c', mustFix: false }, { severity: 'P1', path: 'x', line: null, evidence: '', impact: 'i', closure: 'c', mustFix: true }]) assert.ok(validate(aggregate([axis('five-layer consistency',{findings:[finding]}),axis('code review')])).length);
    assert.ok(validate(aggregate([axis('five-layer consistency',{coverage:[]}),axis('code review')])).length);
    assert.ok(validateAxisResult({status:'PASSED',findings:[],uncovered:[],coverage:['complete'],reason:''},'code review',{changedPaths:paths}).length);
    const blocking = axis('code review', { status: 'CHANGES_REQUESTED', findings: [{ severity: 'P2', path: 'x', line: 2, evidence: 'e', impact: 'i', closure: 'c', mustFix: true }] });
    const blocked=aggregate([axis('five-layer consistency'),blocking]);
    assert.equal(blocked.status,'CHANGES_REQUESTED'); assert.deepEqual(validate(blocked),[]);
    assert.ok(validate({...blocked,status:'PASSED'}).includes('aggregate status mismatch'));
  });
  it('requires exact provider, requested model and optional actual response model plus successful stop/toolUse chain', () => {
    const expectedModel={provider:'openai-codex',model:'gpt-6-astra'};
    const msg=(stopReason,patch={})=>({role:'assistant',provider:'openai-codex',model:'gpt-6-astra',responseModel:'gpt-6-astra',stopReason,...patch});
    assert.equal(isSuccessfulAssistantChain([msg('toolUse'),msg('stop')],expectedModel),true);
    const noResponseModel=msg('stop'); delete noResponseModel.responseModel;
    assert.equal(isSuccessfulAssistantChain([noResponseModel],expectedModel),true);
    for(const reason of ['error','aborted','length','deferred']) assert.equal(isSuccessfulAssistantChain([msg(reason)],expectedModel),false);
    for(const patch of [{provider:'other'},{model:'gpt-6-astra-lite'},{responseModel:'gpt-6-astra-lite'},{responseModel:undefined},{provider:undefined},{model:undefined}]) assert.equal(isSuccessfulAssistantChain([msg('stop',patch)],expectedModel),false);
    const json=JSON.stringify({status:'PASSED',findings:[],uncovered:[],coverage:[{source:'diff',path:null,start:1,end:2,note:'complete diff page'}],reason:''});
    const parse=(messages,model=expectedModel)=>parseSuccessfulAxis({messages,text:json,expectedModel:model,axis:'code review',changedPaths:['src/a.ts']});
    assert.equal(parse([msg('stop')]).ok,true);
    assert.equal(parse([msg('stop',{provider:'other'})]).ok,false,'valid final JSON cannot override a wrong provider');
    const noProvider=msg('stop'); delete noProvider.provider;
    assert.equal(parse([noProvider]).ok,false,'provider field is required');
    assert.equal(parse([msg('stop',{responseModel:'gpt-6-astra-lite'})]).ok,false,'valid final JSON cannot override a mismatched actual response model');
    assert.equal(parse([msg('stop')],{provider:'openai-codex',model:'gpt-6-astra-lite'}).ok,false,'requested model mismatch must fail');
  });
});

describe('source specification binding', () => {
  const repository='owner/repo';
  const pr=(body='Detailed original goal and confirmed decisions.')=>({number:12,state:'open',title:'Improve review authorization',body,html_url:'https://github.com/owner/repo/pull/12',updated_at:'2026-01-01T00:00:00Z'});
  it('maps complete local URLs, local shorthand and closing refs only; foreign/incomplete refs stay unmapped', () => {
    const body='Fixes https://github.com/other/repo/issues/19; closes https://github.com/OWNER/REPO/issues/20; fixes other/repo#21; fixes owner/repo#22; Closes #23; Fixes https://github.com/owner/repo/issues/; Fixes https://evil.example/owner/repo/issues/24';
    assert.deepEqual(collectIssueNumbers({repository,title:'',body}),[20,22,23]);
  });
  it('fetches exact local source numbers and never requests foreign URL or foreign shorthand references', async () => {
    const requested=[];
    const body='Original goal: guard external PR review.\nFixes https://github.com/other/repo/issues/19\ncloses https://github.com/OWNER/REPO/issues/20\nfixes other/repo#21\nFixes owner/repo#22\nCloses #23\nFixes https://github.com/owner/repo/issues/';
    const issues=new Map([20,22,23].map((number)=>[number,{number,title:`Requirement ${number}`,body:'Protect the shared execution guard from external authors.',html_url:`https://github.com/owner/repo/issues/${number}`,updated_at:'now',state:'open'}]));
    const loaded=await loadReviewSpecification({pr:pr(body),repository,request:async(path)=>{requested.push(path); const issueNumber=Number(path.slice('issues/'.length)); return issues.get(issueNumber);}});
    assert.deepEqual(requested,['issues/20','issues/22','issues/23']);
    assert.deepEqual(loaded.references.map((source)=>source.id),['issue#20','issue#22','issue#23']);
  });
  it('judges the actual GitHub PR template empty until a user supplies original goal text', async () => {
    const template=await readFile(new URL('../.github/PULL_REQUEST_TEMPLATE.md',import.meta.url),'utf8');
    assert.equal(hasMeaningfulSpec(template),false);
    assert.equal(hasMeaningfulSpec(`${template}\n本次变更修复外部 PR 审核授权错误。`),true);
  });
  it('binds substantive PR and referenced issue sources into a deterministic fingerprint', async () => {
    const calls=[];
    const issue={number:21,title:'Guard fork PR execution',body:'Original requirement: external fork authors are permitted on owner dispatch.',html_url:'https://github.com/owner/repo/issues/21',updated_at:'2026-01-02T00:00:00Z',state:'open'};
    const input={pr:pr('Fixes #21\n\nThe issue is the original source.'),repository,fetchIssue:async(number)=>{calls.push(number); return issue;}};
    const first=await resolveReviewSpec(input); const second=await resolveReviewSpec(input);
    assert.deepEqual(calls,[21,21]); assert.equal(first.fingerprint,second.fingerprint);
    assert.deepEqual(first.sources.map((source)=>source.id),['pr#12','issue#21']);
    assert.match(first.sources[1].content,/Original requirement/);
    const changed=await resolveReviewSpec({...input,fetchIssue:async()=>({...issue,updated_at:'2026-01-03T00:00:00Z'})});
    assert.notEqual(first.fingerprint,changed.fingerprint);
    const bodyChanged=await resolveReviewSpec({...input,fetchIssue:async()=>({...issue,body:'Changed requirement with an unchanged update timestamp.'})});
    assert.notEqual(first.fingerprint,bodyChanged.fingerprint,'body hash must bind source changes even when update metadata is stale');
  });
  it('accepts concise substantive PR text rather than requiring a long-form body', async () => {
    const result=await resolveReviewSpec({pr:pr('修复登录'),repository,fetchIssue:async()=>{throw new Error('no issue reference expected');}});
    assert.equal(result.sources[0].id,'pr#12');
  });
  it('blocks placeholder-only PR and issue descriptions before worker invocation', async () => {
    await assert.rejects(resolveReviewSpec({pr:pr('## 原始目标与决定\n\n<!-- 请填写 -->'),repository,fetchIssue:async()=>{throw new Error('must not fetch without a recognized source');}}),(error)=>error instanceof ReviewSpecError&&error.code==='SPEC_DESCRIPTION_MISSING');
    await assert.rejects(resolveReviewSpec({pr:pr('Fixes #22'),repository,fetchIssue:async()=>({number:22,title:'TBD',body:'<!-- describe the goal -->',html_url:'https://github.com/owner/repo/issues/22',updated_at:'x'})}),(error)=>error instanceof ReviewSpecError&&error.code==='SPEC_DESCRIPTION_MISSING');
  });
  it('rejects cross-repository issue fetches, pull-request references and source budget overflow', async () => {
    await assert.rejects(resolveReviewSpec({pr:pr('Fixes #23'),repository,fetchIssue:async()=>({number:23,pull_request:{url:'x'}})}),/unavailable as an issue/);
    await assert.rejects(resolveReviewSpec({pr:pr('Fixes #24'),repository,fetchIssue:async()=>({number:24,title:'Detailed requirement',body:'x'.repeat(210_000),html_url:'https://github.com/owner/repo/issues/24',updated_at:'x'})}),(error)=>error instanceof ReviewSpecError&&error.code==='SPEC_BUDGET_EXCEEDED');
    await assert.rejects(resolveReviewSpec({pr:pr(`Detailed requirement\n${'line\n'.repeat(5_000)}`),repository,fetchIssue:async()=>{throw new Error('unexpected');}}),(error)=>error instanceof ReviewSpecError&&error.code==='SPEC_BUDGET_EXCEEDED');
  });
});

describe('original specification read tools', () => {
  it('paginates each source with line ranges and requires every source page', () => {
    const tools=createReviewSpecTools([{id:'pr#12',type:'pull_request',number:12,title:'Spec',url:'https://example/pr/12',updatedAt:'now',content:'line 1\nline 2\nline 3'},{id:'issue#21',type:'issue',number:21,title:'Issue',url:'https://example/issue/21',updatedAt:'now',content:'req 1\nreq 2'}]);
    assert.equal(tools.list().length,2);
    const prPage=tools.read({sourceId:'pr#12',start:1,count:2});
    assert.deepEqual([prPage.start,prPage.end,prPage.totalLines,prPage.nextStart],[1,2,3,3]);
    tools.read({sourceId:'issue#21',start:1,count:2});
    assert.equal(tools.coverageGaps().length,1);
    tools.read({sourceId:'pr#12',start:3,count:1});
    assert.deepEqual(tools.coverageGaps(),[]);
    assert.equal(tools.coverageRecords().length,2);
  });
  it('makes missing spec pages block a claimed passing review and attaches source ranges only after full read', () => {
    const tools=createReviewSpecTools([{id:'pr#12',type:'pull_request',number:12,title:'Spec',url:'https://example/pr/12',updatedAt:'now',content:'goal\ndecision'}]);
    const fp='b'.repeat(64), binding={head:'h',base:'b',model:'m',changedPaths:['src/a.ts'],specFingerprint:fp};
    const axis={status:'PASSED',findings:[],uncovered:[],coverage:[{source:'diff',path:null,start:1,end:1,note:'diff inspected'}],reason:''};
    const incomplete=applySnapshotCoverage(axis,{specGaps:tools.coverageGaps(),specCoverage:tools.coverageRecords()});
    const result=buildAggregateReviewResult({...binding,reviews:[{axis:'five-layer consistency',...axis},{axis:'code review',...incomplete}]});
    assert.equal(result.status,'CHANGES_REQUESTED'); assert.deepEqual(validateReviewResult(result,binding),[]);
    assert.ok(validateReviewResult({...result,status:'PASSED'},binding).includes('aggregate status mismatch'));
    tools.read({sourceId:'pr#12',start:1,count:2});
    const complete=applySnapshotCoverage(axis,{specGaps:tools.coverageGaps(),specCoverage:tools.coverageRecords()});
    const passed=buildAggregateReviewResult({...binding,reviews:[{axis:'five-layer consistency',...axis},{axis:'code review',...complete}]});
    assert.equal(passed.status,'PASSED');
    assert.deepEqual(passed.reviews.map((review)=>review.coverage.filter((entry)=>entry.source==='spec')),[[],[{source:'spec',path:'pr#12',start:1,end:2,note:'source requirement fully read'}]]);
    assert.deepEqual(validateReviewResult(passed,binding),[]);
  });
});

describe('producer-to-finalizer review contract', () => {
  it('carries the authoritative source fingerprint and independent session ledgers through candidate, controller outputs, and finalization', async () => {
    const repository='owner/repo';
    const sourceSpec=await resolveReviewSpec({repository,pr:{number:12,state:'open',title:'Review external authors',body:'Original goal: make owner-dispatched fork review safe.',html_url:'https://github.com/owner/repo/pull/12',updated_at:'pr-time'},fetchIssue:async()=>{throw new Error('no issue reference');}});
    const ledgers=[];
    const reviews=[];
    for(const axisName of ['five-layer consistency','code review']) {
      const tools=createReviewSpecTools(sourceSpec.sources);
      for(const item of tools.list()) for(let start=1;start<=item.totalLines;start+=200) tools.read({sourceId:item.id,start,count:Math.min(200,item.totalLines-start+1)});
      assert.deepEqual(tools.coverageGaps(),[]);
      const ledger=tools.coverageRecords(); ledgers.push(ledger);
      const axis={axis:axisName,status:'PASSED',findings:[],uncovered:[],coverage:[{source:'diff',path:null,start:1,end:1,note:'diff inspected'}],reason:''};
      reviews.push(applySnapshotCoverage(axis,{specGaps:tools.coverageGaps(),errors:tools.errors(),specCoverage:ledger}));
    }
    const binding={head:'h',base:'b',model:'openai-codex/gpt-6-astra',changedPaths:['src/guard.ts'],specFingerprint:sourceSpec.fingerprint};
    const produced=buildAggregateReviewResult({...binding,reviews});
    const candidate=JSON.parse(JSON.stringify(produced));
    assert.deepEqual(validateReviewResult(candidate,binding),[]);
    assert.equal(candidate.status,'PASSED'); assert.equal(candidate.specFingerprint,sourceSpec.fingerprint);
    assert.deepEqual(candidate.reviews.map((review)=>review.coverage.filter((item)=>item.source==='spec')),ledgers);
    const outputs=buildReviewControllerOutputs(candidate,binding);
    assert.equal(outputs.specFingerprint,sourceSpec.fingerprint);
    const githubOutputText=formatReviewControllerOutputs(outputs);
    assert.equal(githubOutputText,`result=PASSED\nspec_fingerprint=${sourceSpec.fingerprint}\n`);
    const githubOutput=Object.fromEntries(githubOutputText.trim().split('\n').map((line)=>line.split('=')));
    assert.equal(githubOutput.spec_fingerprint,sourceSpec.fingerprint);
    const summary=formatCandidateSummary(candidate,{fingerprint:outputs.specFingerprint,sources:sourceSpec.sources.map(({type,id,url,updatedAt})=>({type,id,url,updatedAt}))});
    assert.ok(summary.includes(sourceSpec.fingerprint));
    let published=0,failed=0;
    const outcomes={authorization:'success',install:'success',review:'success',save:'success',result:outputs.result};
    const expected={head:binding.head,base:binding.base,specFingerprint:githubOutput.spec_fingerprint};
    const finalized=await finalizeReview({outcomes,expected,readCurrent:async()=>({head:binding.head,base:binding.base,main:binding.base,specFingerprint:sourceSpec.fingerprint}),publishSuccess:async()=>published++,publishFailure:async()=>failed++});
    assert.equal(finalized.finalized,true); assert.equal(published,1); assert.equal(failed,0);
    const wrongCandidate=buildAggregateReviewResult({...binding,specFingerprint:'0'.repeat(64),reviews});
    assert.throws(()=>buildReviewControllerOutputs(wrongCandidate,binding),/source specification fingerprint mismatch/);
    published=0; failed=0;
    const stale=await finalizeReview({outcomes,expected,readCurrent:async()=>({head:binding.head,base:binding.base,main:binding.base,specFingerprint:'0'.repeat(64)}),publishSuccess:async()=>published++,publishFailure:async()=>failed++});
    assert.equal(stale.finalized,false); assert.equal(published,0); assert.equal(failed,1);
  });
});

describe('hard review execution budget', () => {
  it('irreversibly blocks over-budget calls even after diff coverage is complete and aborts on deadline', () => {
    let aborts=0;
    const ledger=createSnapshotTools({headFiles:new Map(),baseFiles:new Map(),diff:'one\ntwo',axis:'code review'});
    ledger.diff({start:1,count:2}); assert.deepEqual(ledger.coverageGaps(),[]);
    const budget=createReviewBudget({maxToolCalls:2,deadline:1000,abort:()=>aborts++});
    budget.recordToolCall(); budget.recordToolCall();
    assert.throws(()=>budget.recordToolCall(),/budget/);
    assert.match(budget.check(999)[0],/tool-call budget/);
    const deadline=createReviewBudget({deadline:1000,abort:()=>aborts++});
    assert.match(deadline.check(1000)[0],/deadline/); assert.ok(aborts>=2);
  });
});

describe('snapshot tool isolation and coverage', () => {
  const tools = createSnapshotTools({ headFiles: new Map([['a.txt','one\ntwo'],['b.txt','needle']]), baseFiles: new Map([['a.txt','old']]), diff: 'd1\nd2\nd3', axis: 'code review' });
  it('supports base/head reads, paginated search/list, and rejects unsafe paths', () => {
    assert.equal(tools.read({ path: 'a.txt', version: 'base' }).lines[0], '1: old');
    assert.equal(tools.read({ path: 'toString' }).unavailable, true);
    for (const path of ['../a','/etc/passwd','__proto__','a\0b']) assert.throws(() => tools.read({ path }));
    assert.equal(tools.list({ size: 1 }).nextCursor, 1);
    assert.deepEqual(tools.search({ query: 'needle', size: 1 }).items[0], {path:'b.txt',line:1,text:'needle',truncated:false});
  });
  it('requires exact diff-page coverage and returns bounded output', () => {
    tools.diff({ start: 1, count: 1 }); assert.equal(tools.coverageGaps().length, 1);
    tools.diff({ start: 2, count: 2 }); assert.deepEqual(tools.coverageGaps(), []);
  });
  it('does not truncate dangerous diff tails and records an irreversible gap for overlong lines/output', () => {
    const dangerous='x'.repeat(5000)+'DANGEROUS_TAIL';
    const long=createSnapshotTools({headFiles:new Map([['long.txt','x'.repeat(17000)]]),baseFiles:new Map(),diff:`${dangerous}\nnext`,axis:'code review'});
    const visible=long.diff({start:1,count:1}).lines[0];
    assert.ok(visible.endsWith('DANGEROUS_TAIL')); assert.equal(visible.length,dangerous.length+3);
    assert.deepEqual(long.diff({start:1,count:2}).lines,['1: '+dangerous,'2: next']);
    const huge=createSnapshotTools({headFiles:new Map(),baseFiles:new Map(),diff:'z'.repeat(17001),axis:'code review'});
    assert.throws(()=>huge.diff({start:1,count:1}));
    assert.equal(huge.coverageErrors().length,1);
    const outputLimit=createSnapshotTools({headFiles:new Map(),baseFiles:new Map(),diff:Array(50).fill('y'.repeat(12000)).join('\n'),axis:'code review'});
    assert.throws(()=>outputLimit.diff({start:1,count:50}));
    assert.match(outputLimit.coverageErrors()[0],/output limit/);
  });
  it('keeps version/path/line-specific debt for clipped search hits until that exact line is fully read', () => {
    const head='needle'+'x'.repeat(2100)+'DANGEROUS_GUARD';
    const clipped=createSnapshotTools({headFiles:new Map([['guard.ts',`${head}\nneighbor`]]),baseFiles:new Map([['guard.ts','base line']]),diff:'d1\nd2',axis:'code review'});
    clipped.diff({start:1,count:2});
    assert.equal(clipped.search({query:'needle'}).items[0].truncated,true);
    assert.match(clipped.coverageGaps().join('\n'),/head search hit needs full read at guard.ts:1/);
    clipped.read({path:'guard.ts',version:'base',start:1,count:2});
    assert.match(clipped.coverageGaps().join('\n'),/head search hit needs full read at guard.ts:1/);
    clipped.read({path:'guard.ts',version:'head',start:2,count:1});
    assert.match(clipped.coverageGaps().join('\n'),/head search hit needs full read at guard.ts:1/);
    const complete=clipped.read({path:'guard.ts',version:'head',start:1,count:1});
    assert.ok(complete.lines[0].endsWith('DANGEROUS_GUARD'));
    assert.deepEqual(clipped.coverageGaps(),[]);
  });
  it('rejects a passing aggregate until a clipped unmodified shared-guard line is read from the matching snapshot', () => {
    const guard='authorizationGuard('+('x'.repeat(2100))+')';
    const tools=createSnapshotTools({headFiles:new Map([['src/guard.ts',guard]]),baseFiles:new Map([['src/guard.ts','old guard']]),diff:'feature diff line',axis:'code review'});
    tools.diff({start:1,count:1});
    tools.search({query:'authorizationGuard',version:'head'});
    const makeAxis=(axis)=>({axis,status:'PASSED',findings:[],uncovered:[],coverage:[{source:'diff',path:null,start:1,end:1,note:'changed hunk inspected'}],reason:''});
    const accepted=(uncovered)=>buildAggregateReviewResult({head:'h',base:'b',model:'m',changedPaths:['src/feature.ts'],specFingerprint:'c'.repeat(64),reviews:[makeAxis('five-layer consistency'),{...makeAxis('code review'),uncovered}]});
    const debt=tools.coverageGaps();
    assert.ok(debt.length);
    const withoutRead=accepted(applySnapshotCoverage(makeAxis('code review'),{gaps:debt}).uncovered);
    assert.equal(withoutRead.status,'CHANGES_REQUESTED');
    assert.deepEqual(validateReviewResult(withoutRead,{head:'h',base:'b',model:'m',changedPaths:['src/feature.ts'],specFingerprint:'c'.repeat(64)}),[]);
    assert.ok(validateReviewResult({...withoutRead,status:'PASSED'},{head:'h',base:'b',model:'m',changedPaths:['src/feature.ts'],specFingerprint:'c'.repeat(64)}).includes('aggregate status mismatch'));
    tools.read({path:'src/guard.ts',version:'base',start:1,count:1});
    assert.ok(tools.coverageGaps().length,'base version cannot discharge head search debt');
    tools.read({path:'src/guard.ts',version:'head',start:2,count:1});
    assert.ok(tools.coverageGaps().length,'neighbor line cannot discharge the searched line debt');
    const fullRead=tools.read({path:'src/guard.ts',version:'head',start:1,count:1});
    assert.ok(fullRead.lines[0].includes('authorizationGuard('));
    const gaps=tools.coverageGaps(); assert.deepEqual(gaps,[]);
    const withRead=accepted(applySnapshotCoverage(makeAxis('code review'),{gaps}).uncovered);
    assert.deepEqual(validateReviewResult(withRead,{head:'h',base:'b',model:'m',changedPaths:['src/feature.ts'],specFingerprint:'c'.repeat(64)}),[]);
  });
  it('does not clear clipped-hit debt when the exact line is unreadable', () => {
    const text='needle'+'x'.repeat(17000);
    const clipped=createSnapshotTools({headFiles:new Map([['guard.ts',text]]),baseFiles:new Map(),diff:'one',axis:'code review'});
    clipped.diff({start:1,count:1}); clipped.search({query:'needle'});
    assert.throws(()=>clipped.read({path:'guard.ts',version:'head',start:1,count:1}));
    assert.match(clipped.coverageGaps().join('\n'),/head search hit needs full read at guard.ts:1/);
    assert.equal(clipped.coverageErrors().length,1);
    const axis={axis:'code review',status:'PASSED',findings:[],uncovered:[],coverage:[{source:'diff',path:null,start:1,end:1,note:'diff read'}],reason:''};
    const withErrors=applySnapshotCoverage(axis,{gaps:clipped.coverageGaps(),errors:clipped.coverageErrors()});
    const aggregate=buildAggregateReviewResult({status:'PASSED',head:'h',base:'b',model:'m',changedPaths:['src/feature.ts'],specFingerprint:'d'.repeat(64),reviews:[{axis:'five-layer consistency',status:'PASSED',findings:[],uncovered:[],coverage:[{source:'diff',path:null,start:1,end:1,note:'diff read'}],reason:''},withErrors]});
    assert.equal(aggregate.status,'CHANGES_REQUESTED','unreadable overlong guard line must prevent aggregate PASS');
    assert.deepEqual(validateReviewResult(aggregate,{head:'h',base:'b',model:'m',changedPaths:['src/feature.ts'],specFingerprint:'d'.repeat(64)}),[]);
  });
});

describe('Git snapshot extraction', () => {
  it('uses verified commit trees, includes base/head, and handles NUL-separated paths and large lockfiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-snapshot-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init','-q'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
      await writeFile(join(root,'old file.txt'),'before'); await writeFile(join(root,'package-lock.json'),'x'.repeat(300000));
      git('add','.'); git('commit','-qm','base'); const base = git('rev-parse','HEAD');
      await writeFile(join(root,'old file.txt'),'after'); await writeFile(join(root,'new file.txt'),'new');
      git('add','.'); git('commit','-qm','head'); const head = git('rev-parse','HEAD');
      const snapshot = await createGitSnapshot({ root }).create({ base, head, isAncestor: (a,b) => { try { execFileSync('git',['merge-base','--is-ancestor',a,b],{cwd:root,stdio:'ignore'}); return true; } catch { return false; } } });
      assert.equal(snapshot.baseFiles.get('old file.txt'),'before'); assert.equal(snapshot.headFiles.get('old file.txt'),'after');
      assert.ok(snapshot.changedPaths.includes('new file.txt')); assert.ok(snapshot.headFiles.get('package-lock.json').length === 300000);
      await assert.rejects(createGitSnapshot({ root }).create({ base: 'HEAD', head, isAncestor: () => true }), /full 40-character/);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('blocks binaries and configured size-limit violations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-snapshot-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init','-q'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
      await writeFile(join(root,'bin'),Buffer.from([0,1,2])); git('add','.'); git('commit','-qm','base'); const sha=git('rev-parse','HEAD');
      await assert.rejects(createGitSnapshot({root}).create({base:sha,head:sha,isAncestor:()=>true}), /Binary/);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});

describe('OAuth save process boundary', () => {
  it('accepts the Pi 1.0.4 openai-codex credentialsFromToken shape and rejects malformed credentials', () => {
    const piCredential={type:'oauth',access:'access-token-value-012345',refresh:'refresh-token-value-012345',expires:1_800_000_000_000,accountId:'chatgpt-account-123'};
    assert.deepEqual(parseOAuthCredential({'openai-codex':piCredential}),piCredential);
    for(const bad of [ {...piCredential,accountId:''}, {...piCredential,expires:'1800000000000'}, {...piCredential,extra:'unexpected'}, {...piCredential,refresh:'short'} ]) assert.throws(()=>parseOAuthCredential({'openai-codex':bad}));
    assert.throws(()=>parseOAuthCredential({'openai-codex':piCredential,other:{type:'oauth'}}));
  });
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(),'auth-save-')); await chmod(dir,0o700);
    await writeFile(join(dir,'auth.json'),JSON.stringify({'openai-codex':{type:'oauth',access:'access-token-value-012345',refresh:'refresh-token-value-012345',expires:123456,accountId:'account-123' }}),{mode:0o600});
    return dir;
  }
  it('uses only environment token, sends only the provider, masks credentials, and records saved output', async () => {
    const dir = await fixture(); const output=join(dir,'output'); const captured=[]; let payload;
    try {
      const spawnImpl=(cmd,args,options)=>{ captured.push({cmd,args,options}); const child=new EventEmitter(); child.stdin=new EventEmitter(); child.stdin.end=(data)=>{payload=data; child.emit('close',0);}; return child; };
      let masks=''; await saveRefreshedAuth({dir,env:{CI_ENVIRONMENT_TOKEN:'environment-token',REPOSITORY:'owner/repo',PATH:'/bin',GITHUB_OUTPUT:output},spawnImpl,write:(text)=>{masks+=text;}});
      assert.equal(captured[0].cmd,'gh'); assert.equal(captured[0].options.env.GH_TOKEN,'environment-token'); assert.deepEqual(captured[0].options.env,{PATH:'/bin',GH_TOKEN:'environment-token'});
      assert.deepEqual(Object.keys(JSON.parse(payload)),['openai-codex']);
      assert.equal(JSON.parse(payload)['openai-codex'].accountId,'account-123');
      assert.ok(masks.includes('::add-mask::access-token-value-012345'));
      assert.deepEqual(parseOAuthCredential(JSON.parse(payload)),JSON.parse(payload)['openai-codex']);
      assert.equal(await readFile(output,'utf8'),'saved=true\n');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('fails closed on spawn error, EPIPE, nonzero HTTP-backed gh result, and invalid provider set', async () => {
    for (const mode of ['spawn','pipe','exit','provider']) {
      const dir=await fixture();
      try {
        if(mode==='provider') await writeFile(join(dir,'auth.json'),JSON.stringify({'openai-codex':{type:'oauth',access:'1234567890123456',refresh:'1234567890123456',expires:1,accountId:'account-123'},other:{secret:'bad'}}),{mode:0o600});
        const spawnImpl=()=>{ const child=new EventEmitter(); child.stdin=new EventEmitter(); child.stdin.end=()=>{ if(mode==='spawn') child.emit('error',new Error('raw')); else if(mode==='pipe') child.stdin.emit('error',new Error('raw')); else child.emit('close',1); }; return child; };
        await assert.rejects(saveRefreshedAuth({dir,env:{CI_ENVIRONMENT_TOKEN:'token',REPOSITORY:'owner/repo',PATH:'/bin'},spawnImpl,write:()=>{}}));
      } finally { await rm(dir,{recursive:true,force:true}); }
    }
  });
});

describe('candidate summary safety', () => {
  it('redacts credential patterns and controller-known secrets across every model text field at the append entrypoint', async () => {
    const secrets={accountId:'account-id-without-any-token-prefix-72Qx',password:'PassWordSentinel-293847',oauth:'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature_123456',github:'ghp_abcdefghijklmnopqrstuvwxyz0123456789',openai:'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',privateKey:'-----BEGIN PRIVATE KEY-----\nPRIVATE_KEY_SENTINEL\n-----END PRIVATE KEY-----',basic:'Basic QWxhZGRpbjpvcGVuU2VzYW1lMTIzNDU2Nzg=',header:'HeaderSentinel-293847',apiKey:'ApiKeySentinel-293847',auth:'AuthSentinel-293847',cookie:'CookieSentinel-293847'};
    const result={status:'PASSED',head:'a'.repeat(40),base:'b'.repeat(40),model:'openai-codex/gpt-6-astra',reviews:[{axis:'code review',status:'PASSED',reason:`password=${secrets.password}, ordinary reason remains and ${secrets.accountId}`,findings:[{severity:'P2',path:`src/${secrets.github}`,line:8,impact:`Bearer ${secrets.oauth} ${secrets.basic} ordinary impact remains ::add-mask::workflow-command-value\n<script>workflow()</script>`,evidence:`token=${secrets.openai}`,closure:`${secrets.privateKey} ${secrets.oauth} ${secrets.openai} compare the guard before model dispatch`,mustFix:true}],uncovered:[`cookie=${secrets.cookie}`],coverage:[{source:'file',path:'src/guard.ts',start:8,end:9,note:`header=${secrets.header}, api_key=${secrets.apiKey}, authorization=${secrets.auth}, ordinary coverage note remains`}]}]};
    const spec={fingerprint:'f'.repeat(64),sources:[]};
    let published='';
    await appendCandidateSummary(result,{GITHUB_STEP_SUMMARY:'injected-by-test'},async(text)=>{published+=text;},spec,{knownSecrets:Object.values(secrets)});
    const expected=formatCandidateSummary(result,spec,{knownSecrets:Object.values(secrets)});
    assert.equal(published,`${expected}\n`);
    const patternOnly=formatCandidateSummary(result,spec);
    for(const key of ['password','oauth','github','openai','privateKey','basic','header','apiKey','auth','cookie']) assert.ok(!patternOnly.includes(secrets[key]),`pattern projection leaked ${key}`);
    assert.ok(patternOnly.includes(secrets.accountId),'unpatterned controller secret is removed only when supplied exactly');
    for(const secret of Object.values(secrets)) assert.ok(!published.includes(secret),`public summary leaked ${secret}`);
    assert.match(published,/ordinary reason remains/); assert.match(published,/ordinary impact remains/); assert.match(published,/compare the guard before model dispatch/); assert.match(published,/ordinary coverage note remains/);
    assert.match(published,/Must fix: yes/); assert.match(published,/P2/); assert.match(published,/a{40}/); assert.match(published,/b{40}/); assert.match(published,/f{64}/);
    assert.doesNotMatch(published,/::add-mask::|<script>|PRIVATE_KEY_SENTINEL/); assert.match(published,/&lt;script&gt;workflow\(\)&lt;\/script&gt;/);
  });
  it('projects error and final Step Summary paths without exposing known runtime credentials', async () => {
    const secret='unprefixed-runtime-secret-4387';
    let blocked=''; let final='';
    const env={GITHUB_STEP_SUMMARY:'summary',GITHUB_SERVER_URL:'https://github.com',REPOSITORY:'owner/repo',GITHUB_RUN_ID:'7'};
    await appendBlockedSummary(`Bearer ${secret} ::error::\n<script>bad()</script>`,env,async(text)=>{blocked+=text;},{knownSecrets:[secret]});
    await appendFinalSummary('failure',{...env,GITHUB_SERVER_URL:`https://github.com/${secret}`},async(text)=>{final+=text;},{knownSecrets:[secret]});
    assert.doesNotMatch(blocked,/unprefixed-runtime-secret|::error::|<script>/); assert.match(blocked,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(final,/unprefixed-runtime-secret/); assert.match(final,/Finalized: failure \/ blocked/);
  });
  it('renders only escaped source citations and fingerprints, never source body text', () => {
    const html=formatCandidateSummary({status:'PASSED',head:'h',base:'b',model:'m',reviews:[]},{fingerprint:'a'.repeat(64),sources:[{type:'issue',id:'issue#7',title:'<script>source title</script>',url:'https://github.com/owner/repo/issues/7?x=<unsafe>',updatedAt:'now',body:'SECRET RAW REQUIREMENT'}]});
    assert.match(html,/issue#7/); assert.match(html,/source/); assert.doesNotMatch(html,/<script>|source title|SECRET RAW REQUIREMENT|href="[^"]*<unsafe>/);
  });
  it('renders both axis details as escaped HTML and labels candidate as not finalized', () => {
    const html=formatCandidateSummary({status:'PASSED',head:'h',base:'b',model:'m',reviews:[{axis:'five-layer consistency',status:'PASSED',findings:[{severity:'P2',path:'<script>.ts',line:3,impact:'<img>',evidence:'& evidence',closure:'fix <now>',mustFix:true}],uncovered:[],coverage:[{source:'diff',path:null,start:1,end:2,note:'range'}],reason:''},{axis:'code review',status:'NOT_APPLICABLE',findings:[],uncovered:['missing'],coverage:[{source:'file',path:'docs/a.md',start:1,end:4,note:'read'}],reason:'<script>docs only & safe</script>'}]});
    assert.match(html,/candidate — not finalized/); assert.match(html,/&lt;script&gt;/); assert.match(html,/&lt;img&gt;/); assert.match(html,/NOT_APPLICABLE/); assert.match(html,/missing/); assert.match(html,/Must fix: yes/); assert.match(html,/Reason:<\/b> &lt;script&gt;docs only &amp; safe&lt;\/script&gt;/); assert.doesNotMatch(html,/<script>|<img>|Finalized: success/);
  });
});

describe('workflow wiring', () => {
  it('pins actions and runs save/finalize unconditionally after review with distinct check/status names', async () => {
    const yaml=await readFile(new URL('../.github/workflows/ai-review.yml',import.meta.url),'utf8');
    const ci=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
    const refs=[...`${yaml}\n${ci}`.matchAll(/^\s*- uses:\s+([^\s]+)/gm)].map((m)=>m[1]);
    assert.ok(refs.length>=2); assert.ok(refs.every((ref)=>/@[0-9a-f]{40}/.test(ref)));
    const finalizer=await readFile(new URL('./ci/finalize.mjs',import.meta.url),'utf8');
    assert.ok(yaml.includes('name: AI review orchestration')); assert.ok(finalizer.includes("context: 'ai-review / result'"));
    assert.ok(yaml.indexOf('id: review') < yaml.indexOf('id: save_auth'));
    assert.ok(yaml.indexOf('id: save_auth') < yaml.indexOf('Finalize the single review status'));
    assert.match(yaml,/Persist refreshed OAuth credential \(always\)[\s\S]*?if: always\(\)/);
    assert.match(yaml,/Finalize the single review status[\s\S]*?if: always\(\)/);
    assert.ok(yaml.includes('steps.install.outcome')); assert.ok(yaml.includes('steps.save_auth.outcome'));
    assert.match(yaml,/issues: read/); assert.ok(yaml.includes('SPEC_FINGERPRINT: ${{ steps.review.outputs.spec_fingerprint }}'));
    assert.match(finalizer,/specFingerprint: process\.env\.SPEC_FINGERPRINT/);
  });
});

describe('review lifecycle finalization', () => {
  it('publishes success only after all outcomes and fresh SHA checks', async () => {
    const events = [];
    const result = await finalizeReview({ outcomes: { authorization:'success', install:'success', review:'success', save:'success', result:'PASSED' }, expected: {head:'h',base:'b',specFingerprint:'a'.repeat(64)}, readCurrent: async () => { events.push('read'); return {head:'h',base:'b',main:'b',specFingerprint:'a'.repeat(64)}; }, publishSuccess: async () => events.push('publish') });
    assert.equal(result.finalized,true); assert.deepEqual(events,['read','publish']);
  });
  it('never publishes on model/setup/save failures or stale PR/main, even if review says PASSED', async () => {
    for (const change of [{review:'failure'}, {install:'skipped'}, {save:'failure'}, {authorization:'failure'}, {result:'BLOCKED'}]) {
      let success = false, failure = false;
      const outcomes = {authorization:'success',install:'success',review:'success',save:'success',result:'PASSED',...change};
      const result = await finalizeReview({ outcomes, expected:{head:'h',base:'b',specFingerprint:'a'.repeat(64)}, readCurrent:async()=>({head:'h',base:'b',main:'b',specFingerprint:'a'.repeat(64)}), publishSuccess:async()=>{success=true;}, publishFailure:async()=>{failure=true;} });
      assert.equal(result.finalized,false); assert.equal(success,false); assert.equal(failure,true);
    }
    let success = false, failure = false;
    const stale = await finalizeReview({ outcomes:{authorization:'success',install:'success',review:'success',save:'success',result:'PASSED'}, expected:{head:'h',base:'b',specFingerprint:'a'.repeat(64)}, readCurrent:async()=>({head:'new',base:'b',main:'b',specFingerprint:'a'.repeat(64)}), publishSuccess:async()=>{success=true;}, publishFailure:async()=>{failure=true;} });
    assert.equal(stale.reason,'stale snapshot or source specification changed'); assert.equal(success,false); assert.equal(failure,true);
    success=false; failure=false;
    const changedSpec=await finalizeReview({outcomes:{authorization:'success',install:'success',review:'success',save:'success',result:'PASSED'},expected:{head:'h',base:'b',specFingerprint:'a'.repeat(64)},readCurrent:async()=>({head:'h',base:'b',main:'b',specFingerprint:'b'.repeat(64)}),publishSuccess:async()=>{success=true;},publishFailure:async()=>{failure=true;}});
    assert.equal(changedSpec.finalized,false); assert.equal(success,false); assert.equal(failure,true);
  });
});

describe('CI Markdown link parsing', () => {
  it('ignores inline and fenced code and slugifies Unicode headings with duplicate suffixes', () => {
    const input = '# 你好 世界\n# 你好 世界\n`# 不应成为标题`\n```md\n# fenced\n```\n[示例](#你好-世界)';
    assert.equal(stripCode(input).includes('# fenced'), false);
    assert.deepEqual([...anchors(input)].sort(), ['你好-世界', '你好-世界-1']);
  });
  it('supports explicit anchors and excludes code-only anchors', () => {
    assert.deepEqual([...anchors('`<a id="nope">`\n<a id="yes"></a>')], ['yes']);
  });
  it('uses exact GitHub slugs and does not normalize away missing or extra hyphens', () => {
    const values = anchors('# Hello, World!\n# Hello World\n# Café 世界');
    assert.ok(values.has('hello-world')); assert.ok(values.has('hello-world-1')); assert.ok(values.has('café-世界'));
    assert.ok(!values.has('helloworld'));
  });
  it('checks collapsed and shortcut reference definitions for missing targets and anchors at the real entrypoint', async () => {
    const root=await mkdtemp(join(tmpdir(),'md-reference-links-'));
    try {
      execFileSync('git',['init','-q'],{cwd:root});
      await writeFile(join(root,'a.md'),'[指南][]\n\n[指南]: missing.md\n');
      await writeFile(join(root,'b.md'),'[shortcut]\n\n[shortcut]: missing-shortcut.md\n');
      await writeFile(join(root,'target.md'),'# Existing heading\n');
      await writeFile(join(root,'c.md'),'[指南][]\n\n[指南]: target.md#missing-collapsed\n');
      await writeFile(join(root,'d.md'),'[shortcut]\n\n[shortcut]: target.md#missing-shortcut-anchor\n');
      execFileSync('git',['add','.'],{cwd:root});
      const failures=await checkMarkdown(root);
      assert.ok(failures.some((item)=>item.includes('a.md: missing relative target missing.md')));
      assert.ok(failures.some((item)=>item.includes('b.md: missing relative target missing-shortcut.md')));
      assert.ok(failures.some((item)=>item.includes('c.md: missing anchor #missing-collapsed')));
      assert.ok(failures.some((item)=>item.includes('d.md: missing anchor #missing-shortcut-anchor')));
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('checks titled/escaped UTF-8 links and resolves symlinks without allowing escape', async () => {
    const root = await mkdtemp(join(tmpdir(),'md-links-')); const outside = await mkdtemp(join(tmpdir(),'md-outside-'));
    try {
      execFileSync('git',['init','-q'],{cwd:root});
      await writeFile(join(root,'a.md'),'# Hello, World!\n[title](b%20file.md "some title with spaces")\n[bad](#hello_world)\n');
      await writeFile(join(root,'b file.md'),'# Café 世界');
      execFileSync('git',['add','.'],{cwd:root});
      const failures = await checkMarkdown(root);
      assert.ok(failures.some((failure) => failure.includes('missing anchor #hello_world')));
      assert.ok(!failures.some((failure) => failure.includes('b%20file.md')));
      await writeFile(join(outside,'secret.md'),'# x');
      await (await import('node:fs/promises')).symlink(join(outside,'secret.md'),join(root,'link.md'));
      await writeFile(join(root,'a.md'),'[escape](link.md)');
      execFileSync('git',['add','-A'],{cwd:root});
      assert.ok((await checkMarkdown(root)).some((failure) => failure.includes('symlink target escapes')));
    } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
  });
});
