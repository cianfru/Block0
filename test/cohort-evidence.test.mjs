import { test } from 'node:test';
import assert from 'node:assert/strict';
import {boardTargets,evidenceAt,accountValidation,validationReport} from '../cohort-evidence.mjs';
import {observation} from '../observations.mjs';
import {featuresAt} from '../features.mjs';
import {advanceRecord,createExperiment,EXPERIMENT_KEY} from '../experiment.mjs';
const T=1800000000000, MIN=60000, A='0x'+'a'.repeat(40);
const sample=(at,graduated=true)=>observation({address:A,graduated,priceUsd:1},{now:at,forensic:{observedAt:at,risk:20,flags:{holders:100,insiderSellersNow:0}},market:{observedAt:at,liqUsd:20000}});
test('tracked tokens remain in the board scan after leaving discovery without increasing total scans',()=>{
 const active=Array.from({length:16},(_,i)=>({address:'a'+i})), grads=Array.from({length:24},(_,i)=>({address:'g'+i}));
 const tracked=[{address:'missing'},{address:'a1'},{address:'g2'}];
 const first=boardTargets(active,grads,tracked,40);
 assert.equal(first.length,40);assert.equal(new Set(first.map(x=>x.address)).size,40);
 assert.deepEqual(first.slice(0,3),tracked);
 assert.ok(boardTargets([],[],tracked,40).some(x=>x.address==='missing'));
});
test('curve principal and a DEX quote cannot make pre-graduation tokens trade-eligible',()=>{
 const h=Array.from({length:8},(_,i)=>sample(T+i*5*MIN,false));
 h.at(-1).curve={reportedPairedPrincipalEth:1000000};
 const f=featuresAt(h,h.at(-1).observedAt);
 assert.equal(f.stage,'pre-graduation');assert.equal(f.historyReady,true);assert.equal(f.ready,false);
 assert.equal(h.at(-1).liquidityUsd,null);assert.ok(f.reasons.some(x=>x.includes('research only')));
 assert.equal(h.reduce((r,o)=>advanceRecord(r,o,'T'),null).decisions.length,0);
});
test('graduation changes the assessment stage; stale forensic evidence is still missing',()=>{
 const o=sample(T);const f=featuresAt([o],T);
 assert.equal(f.stage,'post-graduation');assert.equal(evidenceAt(o,f,T).liquidity,true);
 assert.equal(evidenceAt(o,f,T+11*MIN).forensics,false);
});
test('validation counts missed wall-clock slots, persists across restart, and freezes at 24 hours',()=>{
 const r={address:A,trackedAt:T,trackUntil:T+2*86400000};
 const ss=at=>new Map([[A,{observedAt:at,evidence:{stage:'post-graduation',forensics:true,liquidity:true,history:true}}]]);
 let v=accountValidation(null,[r],ss(T),T);assert.equal(v.expected,1);assert.equal(v.recorded,1);
 v=accountValidation(JSON.parse(JSON.stringify(v)),[r],ss(T+3*MIN),T+3*MIN);
 assert.equal(v.expected,4);assert.equal(v.recorded,2);assert.equal(validationReport(v,T+3*MIN).observationRate,0.5);
 const same=accountValidation(v,[r],ss(T+3*MIN+1),T+3*MIN+1);assert.equal(same.recorded,2);
 v=accountValidation(v,[r],ss(T+86400000),T+86400000);
 assert.equal(v.expected,1440);assert.equal(v.recorded,2);assert.equal(validationReport(v,T+86400000).status,'complete');
 assert.deepEqual(accountValidation(v,[r],ss(T+2*86400000),T+2*86400000),v);
});
test('stage-balanced admission leaves room for post-graduation evidence',async()=>{
 const db=new Map(), items=Array.from({length:8},(_,i)=>({address:'0x'+String(i+1).padStart(40,'0'),sym:'T',graduated:i>=6,priceUsd:1}));
 const e=createExperiment({balancedStages:true,cohortSize:4,clock:()=>T,read:async k=>structuredClone(db.get(k)??null),write:async(k,v)=>db.set(k,structuredClone(v)),active:async()=>({items,total:8}),graduated:async()=>({items:[],total:0})});
 await e.cycle();const tracked=Object.values(db.get(EXPERIMENT_KEY).registry).filter(r=>r.trackUntil>T);
 assert.equal(tracked.length,4);assert.equal(tracked.filter(r=>r.graduated).length,2);
});
