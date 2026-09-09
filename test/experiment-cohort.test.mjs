import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, EXPERIMENT_KEY, recordKey, archiveKey } from '../experiment.mjs';
import { fetchLiveMarkets } from '../pons.mjs';
const T=1800000000000, MIN=60000, address=i=>'0x'+i.toString(16).padStart(40,'0');
const meta=(i,at=T)=>({address:address(i),sym:'T'+i,priceUsd:1,pool:address(0),launchedAt:new Date(at-3600000).toISOString()});
function harness(options={}) {
  const db=new Map();let now=T;
  const base={read:async k=>structuredClone(db.get(k)??null),write:async(k,v)=>db.set(k,structuredClone(v)),clock:()=>now,
    active:async()=>({items:[],total:0}),graduated:async()=>({items:[],total:0}),...options};
  return {db,base,service:createExperiment(base),time:t=>now=t};
}
test('full registry of absent young tokens cannot starve available quotes; retirement preserves history',async()=>{
  const h=harness({active:async()=>({items:[meta(6000)],total:1}),cohortSize:1,live:async ts=>({items:ts.map(t=>({...t,priceUsd:2}))})});
  const registry={};for(let i=1;i<=5000;i++)registry[address(i)]={...meta(i),firstSeenAt:T-MIN,lastSeenAt:T-MIN,sampledAt:0};
  h.db.set(EXPERIMENT_KEY,{schema:1,registry,nextPage:2,coverage:{}});
  h.db.set(recordKey(address(1)),{observations:[{retained:true}]});
  await h.service.cycle();const s=await h.service.snapshot({limit:0,includeCalls:false});
  assert.equal(s.coverage.sampledThisCycle,1);assert.equal(s.coverage.trackedObservedThisCycle,1);
  assert.equal(s.coverage.registrySize,5000);assert.equal(s.coverage.retiredEntries,1);
  assert.ok(h.db.get(archiveKey(address(1)))[address(1)]);assert.equal(h.db.get(recordKey(address(1))).observations[0].retained,true);
});
test('a cohort follows moving discovery pages for 40 minutes and across restart',async()=>{
  let step=0;const requested=[];
  const h=harness({cohortSize:2,sampleBudget:2,marketBudget:2,
    active:async()=>({items:[meta(100+step),meta(200+step)],total:2}),
    live:async ts=>{requested.push(ts.map(t=>t.address));return {items:ts.map(t=>({...t,graduated:true,priceUsd:1+step/100}))};},
    board:()=>[100,200].map(i=>({address:address(i),observedAt:T+step*MIN,risk:20,flags:{holders:100+step,insiderSellersNow:0}})),
    market:async()=>({liqUsd:20000})});
  let service=h.service;
  for(step=0;step<=40;step++){h.time(T+step*MIN);if(step===20)service=createExperiment(h.base);await service.cycle();}
  assert.ok(requested.every(xs=>xs.join()===requested[0].join()));
  for(const i of [100,200]){const r=h.db.get(recordKey(address(i)));assert.equal(r.observations.length,41);assert.equal(r.features.ready,true);}
  assert.equal((await service.snapshot({limit:0})).coverage.eligibleTokens,2);
});
test('failed explicit follow-up never reuses a catalog price and does not consume available sample slots',async()=>{
  let fail=false;
  const h=harness({cohortSize:1,sampleBudget:1,active:async()=>({items:[meta(1),meta(2)],total:2}),
    live:async ts=>{if(fail)throw Error('timeout');return {items:ts.map(t=>({...t,priceUsd:2}))};}});
  await h.service.cycle();fail=true;h.time(T+MIN);await h.service.cycle();
  const s=await h.service.snapshot({limit:0});assert.equal(s.coverage.followupMissing,1);assert.match(s.error,/timeout/);
  assert.equal(h.db.get(recordKey(address(1))).observations.length,1);
  assert.equal(h.db.get(recordKey(address(2))).observations.length,1);
  assert.equal(s.coverage.sampledThisCycle,1);
});
test('pending and ever-eligible records cannot be retired at the registry cap',async()=>{
  const h=harness({maxTokens:2,cohortSize:2,active:async()=>({items:[meta(3)],total:1})});
  h.db.set(EXPERIMENT_KEY,{schema:1,registry:{[address(1)]:{...meta(1),sampledAt:T,pending:true},[address(2)]:{...meta(2),sampledAt:T,everEligible:true}},coverage:{}});
  await h.service.cycle();const registry=h.db.get(EXPERIMENT_KEY).registry;
  assert.ok(registry[address(1)]);assert.ok(registry[address(2)]);assert.equal(registry[address(3)],undefined);
});
test('live-market adapter validates shape and identity, preserves missing prices and uses two-field queries',async()=>{
  const t=meta(1);let url;
  const r=await fetchLiveMarkets([t],{fetch:async u=>{url=new URL(u);return {ok:true,json:async()=>[{token:t.address,pool:t.pool,priceUsd:null,graduated:null},{token:address(2),priceUsd:99}]};}});
  assert.equal(url.searchParams.get('market'),t.address+','+t.pool);assert.equal(r.items.length,1);
  assert.equal(r.items[0].priceUsd,null);assert.equal(r.items[0].priceSource,'pons-live-markets');
  await assert.rejects(()=>fetchLiveMarkets([t],{fetch:async()=>({ok:true,json:async()=>({})})}),/schema changed/);
});

test('runtime admission waits for fresh forensics instead of locking an empty startup cohort',async()=>{
  let ready=false;
  const h=harness({admissionRequiresForensics:true,cohortSize:1,active:async()=>({items:[meta(1)],total:1}),
    board:()=>ready?[{address:address(1),observedAt:T+MIN}]:[],live:async ts=>({items:ts.map(t=>({...t,priceUsd:2}))})});
  await h.service.cycle();assert.equal((await h.service.snapshot({limit:0})).coverage.cohortSize,0);
  ready=true;h.time(T+MIN);await h.service.cycle();assert.equal((await h.service.snapshot({limit:0})).coverage.cohortSize,1);
});
test('missing pending quotes reach unknown even when the observation budget is used by other tokens',async()=>{
  const {freezeDecision}=await import('../decisions.mjs');
  const h=harness({cohortSize:1,sampleBudget:1,active:async()=>({items:[meta(2)],total:1}),live:async()=>({items:[]})});
  const d=freezeDecision(address(1),{at:T-20*MIN,version:'test'});
  h.db.set(recordKey(address(1)),{address:address(1),observations:[],decisions:[d]});
  h.db.set(EXPERIMENT_KEY,{schema:1,registry:{[address(1)]:{...meta(1),sampledAt:T-2*MIN,pending:true,decisionAt:d.at}},coverage:{}});
  await h.service.cycle();const s=await h.service.snapshot({limit:0});
  assert.equal(s.calls[0].outcome.status,'unknown');assert.equal(s.coverage.sampledThisCycle,1);
});
test('cohort leases expire and release slots without erasing the old record',async()=>{
  let n=1;const h=harness({cohortSize:1,trackingMs:2*MIN,
    active:async()=>({items:[meta(n)],total:1}),live:async ts=>({items:ts.map(t=>({...t,priceUsd:1}))})});
  await h.service.cycle();n=2;h.time(T+3*MIN);await h.service.cycle();
  assert.ok(h.db.get(recordKey(address(1))));assert.ok(h.db.get(recordKey(address(2))));
  assert.equal(h.db.get(EXPERIMENT_KEY).registry[address(2)].trackedAt,T+3*MIN);
});
