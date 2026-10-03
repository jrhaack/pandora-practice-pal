'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname, '../docs/ai.js'), 'utf8');
let tests = 0;
async function test(name, fn) { try { await fn(); tests++; } catch (e) { console.error('FAIL', name); throw e; } }
function boot(saved = {}) {
  const timers = new Map(); let clock = 0, timerId = 0, saves = 0, requests = [];
  const c = { settings: { keys: {}, models: {}, ...saved }, console, AbortController, performance: { now: () => clock }, location: { origin: 'https://example.test' }, saveSettings: () => saves++, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; }, clearTimeout: id => timers.delete(id), fetch: async (...args) => { requests.push(args); throw Error('No live network in tests'); } };
  vm.createContext(c); vm.runInContext(source + '\n globalThis.Test = { AIChain, Brain, PROVIDERS };', c);
  return { c, ...c.Test, requests, get saves() { return saves; }, tick(ms) { clock += ms; const due = [...timers].filter(([, t]) => t.at <= clock); for (const [id, t] of due) { timers.delete(id); t.fn(); } }, timers };
}
// Existing routing tests start with three configured free accounts. Policy cases
// below intentionally omit them to test the supplemental paid gate.
function paidBoot(saved = {}) {
  return boot({ paidAI: true, paidAIConsent: 1, ...saved, keys: {
    gemini: 'free-gemini', groq: 'free-groq', cerebras: 'free-cerebras',
    openrouter: 'free-openrouter', mistral: 'free-mistral', ...saved.keys
  } });
}
const plain = x => JSON.parse(JSON.stringify(x));
(async () => {
  await test('default priorities and existing cloud behavior survive migration', () => { const b = boot(); b.AIChain.init(); assert.equal(b.saves, 1); assert.deepEqual(plain(b.AIChain.slots()), ['gemini','groq','cerebras','openrouter','mistral']); assert.deepEqual(plain(b.Brain.active()), ['signalcraft']); b.AIChain.init(); assert.equal(b.saves, 1); assert.equal(b.requests.length, 0); });
  await test('removing slots stops at three and rejection is atomic', () => { const b = boot(); b.AIChain.init(); assert(b.AIChain.setSlot(4, '').ok); assert(b.AIChain.setSlot(3, '').ok); const before = JSON.stringify(b.c.settings); const count = b.saves; const r = b.AIChain.setSlot(2, ''); assert.equal(r.ok, false); assert.match(r.message, /at least 3/); assert.equal(JSON.stringify(b.c.settings), before); assert.equal(b.saves, count); });
  await test('moving an existing provider clears previous slot and preserves credentials', () => { const b = boot({ keys: { groq: 'private-test-key' }, models: { groq: 'existing-model' } }); const r = b.AIChain.setSlot(0, 'groq'); assert(r.ok); assert.deepEqual(plain(r.slots), ['groq','','cerebras','openrouter','mistral']); assert.equal(b.c.settings.keys.groq, 'private-test-key'); assert.equal(b.c.settings.models.groq, 'existing-model'); assert.match(r.message, /previous slot is now empty/); });
  await test('move into empty slot preserves three but collision at minimum is rejected', () => { const b = boot({ aiSlots: ['gemini','groq','cerebras','',''] }); assert(b.AIChain.setSlot(4, 'groq').ok); assert.deepEqual(plain(b.AIChain.slots()), ['gemini','','cerebras','','groq']); assert.equal(b.AIChain.setSlot(0, 'groq').ok, false); });
  await test('invalid identifiers and out of range slots never mutate settings', () => { const b = boot(); b.AIChain.init(); const before = JSON.stringify(b.c.settings); for (const [i, p] of [[-1,'groq'],[5,'groq'],[1.5,'groq'],[NaN,'groq'],[0,'__proto__'],[0,'signalcraft'],[0,null]]) assert.equal(b.AIChain.setSlot(i,p).ok, false); assert.equal(JSON.stringify(b.c.settings), before); });
  await test('malformed saved priorities recover unique valid choices and minimum', () => { const b = boot({ aiSlots: ['mistral','mistral','invalid',null,'groq','gemini'] }); b.AIChain.init(); const a = plain(b.AIChain.slots()); assert.equal(a.length,5); assert.equal(a[0],'mistral'); assert.equal(a[4],'groq'); assert.equal(a.filter(Boolean).length,3); assert.equal(new Set(a.filter(Boolean)).size,3); });
  await test('selected providers and ready providers are distinct counts', () => { const b = boot({ aiSlots: ['mistral','','gemini','','groq'], noCloud:true }); assert.equal(b.AIChain.slots().filter(Boolean).length,3); assert.equal(b.Brain.active().length,0); b.c.settings.keys.groq='x'; assert.deepEqual(plain(b.Brain.active()),['groq']); });
  await test('execution follows selected order, skips missing keys and unselected providers', () => { const b=boot({aiSlots:['mistral','','gemini','','groq'],keys:{gemini:'x',groq:'y',cerebras:'not-selected',mistral:'z'}}); assert.deepEqual(plain(b.Brain.active()),['mistral','gemini','groq','signalcraft']); b.c.settings.noCloud=true; assert.deepEqual(plain(b.Brain.active()),['mistral','gemini','groq']); });
  await test('fallback continues the same conversation in new priority order', async () => { const b=boot({aiSlots:['groq','mistral','gemini','',''],keys:{groq:'x',mistral:'y',gemini:'z'},noCloud:true}); const seen=[],messages=[{role:'user',content:'Keep this exact history'}]; b.Brain.one=async(p,system,msg,signal)=>{seen.push({p,system,msg,signal});if(p==='groq')throw Error('transient failure');return{text:'worked',provider:p};}; const r=await b.Brain.chat('context',messages); assert.equal(r.provider,'mistral');assert.deepEqual(seen.map(x=>x.p),['groq','mistral']);assert(seen.every(x=>x.msg===messages&&x.system==='context'));assert(seen.every(x=>x.signal.aborted));assert.equal(b.timers.size,0); });
  await test('slow first provider is hedged and abandoned requests are cancelled', async () => { const b=boot({aiSlots:['groq','mistral','gemini','',''],keys:{groq:'x',mistral:'y'},noCloud:true}),seen=[]; b.Brain.one=(p,sys,msg,signal)=>{seen.push({p,signal});return p==='groq'?new Promise(()=>{}):Promise.resolve({text:'answer',provider:p});};const pending=b.Brain.chat('context',[],{hedgeMs:50,totalMs:1000});assert.deepEqual(seen.map(x=>x.p),['groq']);b.tick(50);const r=await pending;assert.equal(r.provider,'mistral');assert(seen.every(x=>x.signal.aborted));assert.equal(b.timers.size,0); });
  await test('no ready provider fails without requests', async () => { const b=boot({noCloud:true});await assert.rejects(b.Brain.chat('x',[]),/no AI keys/);assert.equal(b.requests.length,0); });
  await test('all selected providers failing returns error without reordering or leaking keys', async () => { const b=boot({keys:{gemini:'secret-1',groq:'secret-2'},noCloud:true}),seen=[];b.Brain.one=async p=>{seen.push(p);throw Error(p+' unavailable');};await assert.rejects(b.Brain.chat('x',[]),/gemini unavailable/);assert.deepEqual(seen,['gemini','groq']);assert(!JSON.stringify(b.Brain.status).includes('secret-'));assert.equal(b.timers.size,0); });
  await test('deadline cancels a stalled provider without starting unselected services', async () => { const b=boot({aiSlots:['groq','mistral','gemini','',''],keys:{groq:'x'},noCloud:true});let signal;b.Brain.one=(p,sys,msg,s)=>{signal=s;return new Promise(()=>{});};const pending=b.Brain.chat('x',[],{hedgeMs:500,totalMs:100});const result=assert.rejects(pending,/all providers failed/);b.tick(100);await result;assert(signal.aborted);assert.equal(b.timers.size,0);assert.equal(b.requests.length,0); });
  await test('repeated priority changes preserve uniqueness, minimum and provider-key ownership', () => { const b=boot({keys:{gemini:'a',groq:'b',mistral:'c'}}),keys=JSON.stringify(b.c.settings.keys);let seed=9103;for(let i=0;i<1000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const slot=seed%5;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const choice=['',...b.AIChain.providers()][seed%6],before=JSON.stringify(b.AIChain.slots());const r=b.AIChain.setSlot(slot,choice),selected=r.slots.filter(Boolean);assert.equal(r.slots.length,5);assert(selected.length>=3);assert.equal(new Set(selected).size,selected.length);if(!r.ok)assert.equal(JSON.stringify(b.AIChain.slots()),before);assert.equal(JSON.stringify(b.c.settings.keys),keys);}assert.equal(b.requests.length,0); });
  await test('paid defaults are off and stale keys/slots cannot bypass the gate', async () => { const b=boot({aiSlots:['openai','anthropic','deepseek','',''],keys:{openai:'own-key',anthropic:'own-key',deepseek:'own-key'},noCloud:true});assert.equal(b.AIChain.paidEnabled(),false);assert.equal(b.Brain.active().length,0);assert.equal(b.AIChain.setSlot(4,'xai').ok,false);for(const p of ['openai','anthropic','deepseek'])await assert.rejects(b.Brain.one(p,'x',[]),/disabled/);assert.equal(b.requests.length,0);b.c.settings.paidAI=true;assert.equal(b.Brain.active().length,0);assert.equal(b.AIChain.setPaidEnabled(true,false).ok,false);assert(b.AIChain.setPaidEnabled(true,true).ok);assert.equal(b.Brain.active().length,3);assert.equal(b.AIChain.accountProviders().length,3);assert.equal(b.AIChain.paidReady(),true); });
  await test('paid request schemas use personal keys and fixed verified models', async () => {const b=paidBoot({keys:{openai:'user-openai',anthropic:'user-claude',deepseek:'user-deepseek',xai:'user-xai'},models:{openai:'unapproved-expensive-model'}}),seen=[];b.c.fetch=async(url,options)=>{seen.push({url,options,body:JSON.parse(options.body)});return{ok:true,json:async()=>url.includes('anthropic')?{content:[{type:'thinking',thinking:'not spoken'},{type:'text',text:'Answer one'},{type:'text',text:'Answer two'}]}:{choices:[{message:{content:'Answer'}}]}}};const messages=[{role:'user',content:'Question'},{role:'assistant',content:'Previous answer'},{role:'user',content:'Follow-up'}];for(const provider of ['openai','anthropic','deepseek']){const result=await b.Brain.one(provider,'System text',messages);assert(result.text.startsWith('Answer'));}assert.equal(seen.length,3);assert(seen.every(x=>x.options.method==='POST'));assert.equal(seen[0].body.model,'gpt-4.1-mini');assert.equal(seen[0].options.headers.Authorization,'Bearer user-openai');assert.equal(seen[1].options.headers['x-api-key'],'user-claude');assert.equal(seen[1].options.headers['anthropic-version'],'2023-06-01');assert.equal(seen[1].options.headers['anthropic-dangerous-direct-browser-access'],'true');assert.equal(seen[1].body.system,'System text');assert.deepEqual(seen[1].body.messages,messages);assert.equal(seen[2].body.thinking.type,'disabled');assert(seen.every(x=>x.body.max_tokens<=1024));assert.equal(messages.length,3);});
  await test('paid eligible chain never hedges a slow request',async()=>{const b=paidBoot({aiSlots:['openai','anthropic','groq','',''],keys:{openai:'x',anthropic:'y',groq:'z'},noCloud:true});let resolve,seen=[];b.Brain.one=(p,s,m,signal)=>{seen.push(p);return new Promise(r=>resolve=r)};const pending=b.Brain.chat('x',[],{hedgeMs:10,totalMs:1000});b.tick(50);assert.deepEqual(seen,['openai']);resolve({text:'Done',provider:'openai'});assert.equal((await pending).provider,'openai');assert.equal(b.timers.size,0);});
  await test('definitive unpaid rejection may fall back sequentially',async()=>{const b=paidBoot({aiSlots:['openai','anthropic','groq','',''],keys:{openai:'x',anthropic:'y'},noCloud:true}),seen=[];b.c.fetch=async(url,options)=>{seen.push(url);return url.includes('openai')?{ok:false,status:401}:{ok:true,json:async()=>({content:[{type:'text',text:'Response'}]})}};assert.equal((await b.Brain.chat('x',[])).provider,'anthropic');assert.equal(seen.length,2);assert(seen[0].includes('openai'));assert(seen[1].includes('anthropic'));});
  await test('ambiguous paid network failure never automatically charges a fallback',async()=>{const b=paidBoot({aiSlots:['openai','anthropic','groq','',''],keys:{openai:'x',anthropic:'y'},noCloud:true}),seen=[];b.c.fetch=async url=>{seen.push(url);throw Error('network failed')};await assert.rejects(b.Brain.chat('x',[]),/no automatic second paid request/);assert.equal(seen.length,1);assert.equal(b.Brain.paidController,null);});
  await test('paid deadline stops without automatic second request',async()=>{const b=paidBoot({aiSlots:['openai','anthropic','groq','',''],keys:{openai:'x',anthropic:'y'},noCloud:true}),seen=[];b.Brain.one=(p)=>{seen.push(p);return new Promise(()=>{})};const pending=b.Brain.chat('x',[],{hedgeMs:10,totalMs:100});const checked=assert.rejects(pending,/no automatic second paid request/);b.tick(100);await checked;assert.deepEqual(seen,['openai']);assert.equal(b.timers.size,0);});
  await test('turning paid off aborts current request and blocks later use',async()=>{const b=paidBoot({keys:{openai:'x'}});let requestSignal;b.c.fetch=async(url,{signal})=>{requestSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))};const pending=b.Brain.one('openai','x',[]),checked=assert.rejects(pending,/aborted/);await Promise.resolve();await Promise.resolve();assert(requestSignal);b.AIChain.setPaidEnabled(false);await checked;assert(requestSignal.aborted);assert.equal(b.Brain.key('openai'),'');assert.equal(b.c.settings.keys.openai,'x');assert.equal(b.Brain.paidController,null);});
  await test('simultaneous paid calls cannot create parallel charges',async()=>{const b=paidBoot({keys:{openai:'x',anthropic:'y'}});let release,calls=0;b.c.fetch=async()=>{calls++;return new Promise(r=>release=()=>r({ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})}))};const one=b.Brain.one('openai','x',[]);await assert.rejects(b.Brain.one('anthropic','x',[]),/still running/);await Promise.resolve();assert.equal(calls,1);release();await one;assert.equal(b.Brain.paidController,null);});
  await test('disabling paid restores three eligible choices and preserves personal keys',()=>{const b=paidBoot({aiSlots:['openai','groq','anthropic','','deepseek'],keys:{openai:'keep-this',groq:'g'}});b.AIChain.setPaidEnabled(false);const slots=plain(b.AIChain.slots());assert(slots.filter(Boolean).length>=3);assert.equal(slots[1],'groq');assert(slots.every(p=>!p||!b.PROVIDERS[p].paid));assert.deepEqual(plain(b.c.settings.aiSlots),slots);assert.equal(b.c.settings.keys.openai,'keep-this');b.AIChain.setPaidEnabled(true,true);assert(!b.AIChain.slots().includes('openai'));});
  await test('stale paid slots recover on startup without activating paid keys',()=>{const b=boot({aiSlots:['openai','anthropic','deepseek','',''],keys:{openai:'saved'},noCloud:true});b.AIChain.init();assert(b.AIChain.slots().filter(Boolean).length>=3);assert(b.AIChain.slots().every(p=>!p||!b.PROVIDERS[p].paid));assert.equal(b.Brain.active().length,0);assert.equal(b.requests.length,0)});
  await test('model discovery clears its timer after success or failure',async()=>{const b=boot({keys:{gemini:'x'}});b.c.fetch=async()=>({ok:true,json:async()=>({data:[{id:'gemini-2.5-flash'}]})});await b.Brain.model('gemini');assert.equal(b.timers.size,0);delete b.c.settings.models.gemini;b.c.fetch=async()=>{throw Error('offline')};await b.Brain.model('gemini');assert.equal(b.timers.size,0);});
  await test('browser-unavailable Grok cannot be selected, restored or called directly', async()=>{const b=boot({paidAI:true,paidAIConsent:1,aiSlots:['xai','groq','gemini','',''],keys:{xai:'retained-key'},noCloud:true});assert.equal(b.AIChain.setSlot(3,'xai').ok,false);b.AIChain.init();assert(!b.AIChain.slots().includes('xai'));assert.equal(b.Brain.active().length,0);assert.equal(b.c.settings.keys.xai,'retained-key');await assert.rejects(b.Brain.one('xai','x',[]),/browser app/);await assert.rejects(b.Brain.request('xai','x',[]),/browser app/);await assert.rejects(b.Brain.model('xai'),/browser app/);assert.equal(b.requests.length,0);});
  await test('free prefix still hedges when a paid fallback is configured', async()=>{const b=paidBoot({aiSlots:['groq','mistral','openai','',''],keys:{groq:'a',mistral:'b',openai:'c'},noCloud:true}),seen=[];b.Brain.one=(p,s,m,signal)=>{seen.push(p);return p==='groq'?new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true})):Promise.resolve({text:'Fast free answer',provider:p});};const pending=b.Brain.chat('same history',[],{hedgeMs:50,totalMs:1000});b.tick(50);assert.equal((await pending).provider,'mistral');assert.deepEqual(seen,['groq','mistral']);assert.equal(b.timers.size,0);});
  await test('a stalled free group is cancelled and settled before paid fallback starts', async()=>{const b=paidBoot({aiSlots:['groq','mistral','openai','',''],keys:{groq:'a',mistral:'b',openai:'c'},noCloud:true}),seen=[];let freeRunning=0;b.Brain.one=(p,s,m,signal)=>{seen.push(p);if(p==='openai'){assert.equal(freeRunning,0);return Promise.resolve({text:'Paid fallback',provider:p});}freeRunning++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{freeRunning--;reject(Error('cancelled'));},{once:true}));};const pending=b.Brain.chat('x',[],{hedgeMs:50,totalMs:1000});b.tick(50);b.tick(50);assert.equal((await pending).provider,'openai');assert.deepEqual(seen,['groq','mistral','openai']);assert.equal(b.timers.size,0);});
  await test('definitive paid failure continues to a hedged free group in priority order', async()=>{const b=paidBoot({aiSlots:['openai','groq','mistral','',''],keys:{groq:'a',mistral:'b',openai:'c'},noCloud:true}),seen=[];b.Brain.one=(p,s,m,signal)=>{seen.push(p);if(p==='openai')return Promise.reject(Object.assign(Error('401'),{safeToFallback:true}));if(p==='groq')return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));return Promise.resolve({text:'Free answer',provider:p});};const pending=b.Brain.chat('x',[],{hedgeMs:50,totalMs:1000});for(let i=0;i<8;i++)await Promise.resolve();b.tick(50);assert.equal((await pending).provider,'mistral');assert.deepEqual(seen,['openai','groq','mistral']);assert.equal(b.timers.size,0);});
  await test('the shared deadline ends a stalled free prefix without sending paid requests', async()=>{const b=paidBoot({aiSlots:['groq','mistral','openai','',''],keys:{groq:'a',mistral:'b',openai:'c'},noCloud:true}),seen=[];b.Brain.one=(p,s,m,signal)=>{seen.push(p);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};const pending=b.Brain.chat('x',[],{hedgeMs:50,totalMs:75});const checked=assert.rejects(pending,/timed out|cancelled/);b.tick(50);b.tick(25);await checked;assert.deepEqual(seen,['groq','mistral']);assert.equal(b.timers.size,0);});
  await test('an uncooperative free request cannot overlap paid fallback', async()=>{const b=paidBoot({aiSlots:['groq','openai','gemini','',''],keys:{groq:'a',openai:'c'},noCloud:true}),seen=[];b.Brain.one=p=>{seen.push(p);return new Promise(()=>{});};const pending=b.Brain.chat('x',[],{hedgeMs:50,totalMs:100});const checked=assert.rejects(pending,/timed out|cancelled/);b.tick(50);for(let i=0;i<8;i++)await Promise.resolve();assert.deepEqual(seen,['groq']);b.tick(50);await checked;assert.deepEqual(seen,['groq']);assert.equal(b.timers.size,0);});
  await test('caller cancellation aborts mixed free requests and never reaches paid', async()=>{const b=paidBoot({aiSlots:['groq','openai','gemini','',''],keys:{groq:'a',openai:'c'},noCloud:true}),ctl=new AbortController(),seen=[];b.Brain.one=(p,s,m,signal)=>{seen.push(p);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};const pending=b.Brain.chat('x',[],{signal:ctl.signal});const checked=assert.rejects(pending,/cancelled/);ctl.abort();await checked;assert.deepEqual(seen,['groq']);assert.equal(b.timers.size,0);});
  await test('cancelled model discovery cannot send delayed generation after group abandonment', async()=>{const b=boot({keys:{groq:'a'}}),ctl=new AbortController(),seen=[];b.c.fetch=(url,{signal})=>{seen.push(url);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};const pending=b.Brain.one('groq','x',[],ctl.signal),checked=assert.rejects(pending,/cancelled before sending/);ctl.abort();await checked;assert.equal(seen.length,1);assert(seen[0].endsWith('/models'));assert.equal(b.timers.size,0);});
  await test('already cancelled caller sends no all-free requests', async()=>{const b=boot({keys:{groq:'a'},noCloud:true}),ctl=new AbortController();ctl.abort();await assert.rejects(b.Brain.chat('x',[],{signal:ctl.signal}),/cancelled/);assert.equal(b.requests.length,0);assert.equal(b.timers.size,0);});
  await test('three selected providers allow any free/paid mix and reject fewer atomically', () => {
    const b = paidBoot({ keys: { openai: 'one', anthropic: 'two', deepseek: 'three' } });
    assert(b.AIChain.setSlot(0, 'openai').ok);
    assert(b.AIChain.setSlot(1, 'anthropic').ok);
    assert(b.AIChain.setSlot(2, 'deepseek').ok);
    assert(b.AIChain.setSlot(3, '').ok);
    assert(b.AIChain.setSlot(4, '').ok);
    assert.deepEqual(plain(b.AIChain.slots()), ['openai', 'anthropic', 'deepseek', '', '']);
    assert.equal(b.AIChain.paidReady(), true);
    const before = JSON.stringify(b.c.settings), writes = b.saves;
    const result = b.AIChain.setSlot(2, '');
    assert.equal(result.ok, false);
    assert.match(result.message, /at least 3/);
    assert.equal(JSON.stringify(b.c.settings), before);
    assert.equal(b.saves, writes);
  });
  await test('valid paid-heavy saved priorities remain unchanged and retain all account keys', () => {
    const b = boot({ paidAI: true, paidAIConsent: 1,
      aiSlots: ['openai', 'groq', 'anthropic', 'mistral', 'deepseek'],
      keys: { openai: 'one', groq: 'two', anthropic: 'three', mistral: 'four', deepseek: 'five' } });
    const before = JSON.stringify(b.c.settings);
    b.AIChain.init();
    assert.equal(JSON.stringify(b.c.settings), before);
    assert.equal(b.AIChain.paidReady(), true);
    assert.equal(b.saves, 0);
  });
  await test('paid use needs three selected nonempty account keys in any mix', async () => {
    const b = boot({ aiSlots: ['gemini', 'groq', 'cerebras', '', ''],
      keys: { gemini: 'one', groq: '   ', cerebras: '', mistral: 'not-selected', openai: 'paid-key' } });
    assert(b.AIChain.setPaidEnabled(true, true).ok);
    assert(b.AIChain.setSlot(3, 'openai').ok);
    assert.equal(b.AIChain.paidEnabled(), true);
    assert.equal(b.AIChain.keyProviders().length, 2);
    assert.equal(b.AIChain.paidReady(), false);
    assert(!b.Brain.active().includes('openai'));
    for (const operation of [() => b.Brain.one('openai', 'x', []),
      () => b.Brain.request('openai', 'x', []), () => b.Brain.model('openai')])
      await assert.rejects(operation(), /3 selected provider accounts/);
    assert.equal(b.requests.length, 0);
    b.AIChain.setKey('groq', '  third-account  ');
    assert.equal(b.AIChain.paidReady(), true);
    assert(b.Brain.active().includes('openai'));
    assert.equal(b.c.settings.keys.groq, 'third-account');
    assert.equal(b.Brain.status.groq, undefined); // Presence is not connection verification.
    b.AIChain.setKey('groq', '   ');
    assert.equal(b.AIChain.paidReady(), false);
    assert.equal(b.c.settings.keys.openai, 'paid-key');
  });
  await test('one-paid-two-free, two-paid-one-free and three-paid accounts all qualify', () => {
    for (const choices of [['openai', 'groq', 'gemini'], ['openai', 'anthropic', 'groq'], ['openai', 'anthropic', 'deepseek']]) {
      const keys = Object.fromEntries(choices.map(p => [p, 'account-' + p]));
      const b = boot({ paidAI: true, paidAIConsent: 1, aiSlots: [...choices, '', ''], keys, noCloud: true });
      assert.equal(b.AIChain.paidReady(), true);
      assert.deepEqual(plain(b.Brain.active()), choices);
    }
  });
  await test('Murmur backup and saved but unselected accounts do not qualify paid use', () => {
    const b = boot({ paidAI: true, paidAIConsent: 1,
      aiSlots: ['openai', 'groq', 'gemini', 'cerebras', ''],
      keys: { openai: 'paid', groq: 'one', mistral: 'unselected', openrouter: 'also-unselected' } });
    assert.deepEqual(plain(b.Brain.active()), ['groq', 'signalcraft']);
    assert.equal(b.AIChain.keyProviders().length, 2);
    assert.equal(b.AIChain.paidReady(), false);
  });
  await test('clearing a required account key aborts active paid work and retains unrelated keys', async () => {
    const b = boot({ paidAI: true, paidAIConsent: 1,
      aiSlots: ['openai', 'groq', 'gemini', '', ''], keys: { openai: 'paid', groq: 'one', gemini: 'two' } });
    let signal;
    b.c.fetch = async (url, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
    };
    const pending = b.Brain.one('openai', 'x', []), checked = assert.rejects(pending, /aborted/);
    await Promise.resolve(); await Promise.resolve();
    assert(signal);
    b.AIChain.setKey('groq', '');
    await checked;
    assert(signal.aborted);
    assert.equal(b.Brain.key('openai'), '');
    assert.equal(b.c.settings.keys.openai, 'paid');
    assert.equal(b.Brain.paidController, null);
  });
  await test('changing a selected account to one without a key aborts paid work below three', () => {
    const b = boot({ paidAI: true, paidAIConsent: 1,
      aiSlots: ['openai', 'groq', 'gemini', '', ''],
      keys: { openai: 'paid', groq: 'one', gemini: 'two' } });
    const ctl = new AbortController(); b.Brain.paidController = ctl;
    assert(b.AIChain.setSlot(1, 'mistral').ok);
    assert(ctl.signal.aborted);
    assert.equal(b.AIChain.accountProviders().length, 3);
    assert.equal(b.AIChain.paidReady(), false);
    assert.equal(b.c.settings.keys.groq, 'one');
  });
  await test('an account-key change during async model selection cannot send a paid request', async () => {
    const b = boot({ paidAI: true, paidAIConsent: 1,
      aiSlots: ['openai', 'groq', 'gemini', '', ''], keys: { openai: 'paid', groq: 'one', gemini: 'two' } });
    let release;
    b.Brain.model = () => new Promise(resolve => { release = resolve; });
    const pending = b.Brain.one('openai', 'x', []);
    const checked = assert.rejects(pending, /3 selected provider accounts/);
    b.c.settings.keys.groq = '';
    release('gpt-4.1-mini');
    await checked;
    assert.equal(b.requests.length, 0);
    assert.equal(b.Brain.paidController, null);
  });
  await test('paid-enabled priority edits keep three unique eligible accounts in any mix', () => {
    const b = paidBoot(), credentials = JSON.stringify(b.c.settings.keys);
    const choices = ['', ...b.AIChain.providers()]; let seed = 7129;
    for (let i = 0; i < 1000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const index = seed % 5;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      b.AIChain.setSlot(index, choices[seed % choices.length]);
      const eligible = b.AIChain.accountProviders();
      assert(eligible.length >= 3);
      assert.equal(new Set(eligible).size, eligible.length);
      assert.equal(JSON.stringify(b.c.settings.keys), credentials);
    }
    assert.equal(b.requests.length, 0);
  });
  console.log(tests + ' AI priority/fallback tests passed (no live API calls)');
})().catch(e => {console.error(e);process.exitCode=1;});
