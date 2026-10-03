const assert=require('node:assert/strict');const M=require('../docs/murmur-sync.js');
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};
const storage=()=>{let x=null;return {read:()=>x,write:y=>{x=y;},raw:()=>x};};
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
(async()=>{
 let server=null,sha=0,puts=0,privateRepo=true,conflict=true;
 const net=async(url,init={})=>{
  if(!url.includes('/contents/'))return response(200,{private:privateRepo});
  if(init.method!=='PUT')return server?response(200,{sha:String(sha),content:M.encode(JSON.stringify(server))}):response(404,{});
  puts++;const body=JSON.parse(init.body);if(conflict){conflict=false;server={schema:3,events:{other:{id:'other',source:'phone',device:'remote',questionId:'q2',partId:'',course:'DIGI210',topic:'Parity',credit:0,at:'2026-10-03T00:00:00Z',updatedAt:1,rev:1,revision:1,tags:[]}},records:{}};sha++;return response(409,{});}
  if((body.sha||null)!==(server?String(sha):null))return response(409,{});server=JSON.parse(M.decode(body.content));sha++;return response(200,{});
 };
 const s=storage(),c=M.create({appId:'test',storage:s,fetch:net,config:()=>({repo:'owner/private',token:'mock-not-a-secret',enabled:true})});await c.ready;
 const id=await c.recordAttempt({questionId:'q1',course:'DIGI210',topic:'Parity',credit:1,independent:true});
 await c.recordAttempt({id,questionId:'q1',course:'DIGI210',topic:'Parity',credit:1,independent:true});ok(c.events().length===1,'same event repeated once');
 await c.recordAttempt({id,questionId:'q1',course:'DIGI210',topic:'Parity',credit:.5,assisted:true,independent:false});ok(c.events().length===1&&c.events()[0].credit===.5,'correction replaces');
 await c.putRecord('digi-parts','6-4:a',{answer:'A′B+AB′',steps:2});await c.sync();ok(puts===2,'conflict retried');ok(c.events().length===2&&Object.keys(server.events).length===2,'merge preserves concurrent attempt');ok(c.topics()['DIGI210|Parity'].n===2,'unique counts');ok(c.topics()['DIGI210|Parity'].independentCorrect===0,'guided is not mastery');
 const before=puts;await c.sync();ok(puts===before,'unchanged sync makes no commit');
 await c.recordAttempts([{id:'a',questionId:'a',course:'DIGI210',topic:'Parity',credit:1,revealed:true,independent:true},{id:'b',questionId:'b',course:'DIGI210',topic:'Parity',credit:1,selfReported:true,independent:true}]);ok(c.topics()['DIGI210|Parity'].independentCorrect===0,'revealed/manual not mastery');
 const reopened=M.create({appId:'test',storage:s,fetch:net,config:()=>({enabled:false})});await reopened.ready;ok(reopened.events().length===4,'offline events survive restart');ok(reopened.getRecord('digi-parts','6-4:a').answer==='A′B+AB′','unicode record survives');
 const a=c.snapshot(),b=reopened.snapshot();ok(JSON.stringify(M.merge(a,b))===JSON.stringify(M.merge(b,a)),'commutative merge');ok(Object.keys(M.merge(a,a).events).length===4,'idempotent merge');
 const denied=M.create({appId:'denied',storage:storage(),fetch:net,config:()=>({repo:'owner/public',token:'mock',enabled:true})});await denied.ready;privateRepo=false;const p0=puts;await assert.rejects(()=>denied.sync(),/private repository/);checks++;ok(puts===p0,'public repo never written');const realNow=Date.now;Date.now=()=>realNow()+360000;try{await assert.rejects(()=>c.sync(),/private repository/);checks++;}finally{Date.now=realNow;}ok(puts===p0,'formerly private repo is rechecked before later writes');
 const offline=M.create({appId:'offline',storage:storage(),fetch:async()=>{throw new Error('offline');},config:()=>({repo:'owner/private',token:'mock',enabled:true})});await offline.ready;await offline.recordAttempt({questionId:'x',course:'DIGI210',topic:'Gates',credit:0});await assert.rejects(()=>offline.sync());checks++;ok(offline.events().length===1&&offline.pending,'offline queue retained');
 let batchWrites=0,batchChanges=0,batchValue=null;const batched=M.create({appId:'batch',storage:{read:()=>batchValue,write:v=>{batchWrites++;batchValue=v;}},config:()=>({enabled:false}),onChange:()=>batchChanges++});await batched.ready;const initialChanges=batchChanges;
 const records=Array.from({length:1000},(_,i)=>({namespace:'phone.items',key:'q'+i,value:{n:i,last:1000+i}}));await batched.putRecords(records);ok(batchWrites===1&&batchChanges===initialChanges+1,'1000 records persist and notify once');ok(batched.records('phone.items').length===1000,'batch retains all history records');
 await batched.putRecords(records);ok(batchWrites===1&&batchChanges===initialChanges+1,'unchanged batch does not write or notify');
 const beforeBatch=JSON.stringify(batched.snapshot());await assert.rejects(()=>batched.putRecords([{namespace:'phone.items',key:'valid',value:{n:1}},{namespace:'__proto__',key:'bad',value:{n:2}}]));checks++;ok(JSON.stringify(batched.snapshot())===beforeBatch&&batchWrites===1,'invalid batch is atomic');
 const revised=await batched.putRecords([{namespace:'phone.items',key:'q1',value:{n:11,last:2000}},{namespace:'phone.items',key:'q1',value:{n:12,last:3000}}]);ok(revised.length===2&&batched.getRecord('phone.items','q1').n===12&&batchWrites===2,'duplicate keys retain ordered single-record semantics');ok(batched.getRecordMeta('phone.items','q1').rev===3,'batch revisions remain monotonic');
 const resumedBatch=M.create({appId:'batch',storage:{read:()=>batchValue,write:v=>batchValue=v},config:()=>({enabled:false})});await resumedBatch.ready;ok(resumedBatch.records('phone.items').length===1000&&resumedBatch.getRecord('phone.items','q1').n===12,'batched records survive offline restart');await batched.destroy();await resumedBatch.destroy();
 for(const x of [c,reopened,denied,offline])await x.destroy();console.log(checks+' sync tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
