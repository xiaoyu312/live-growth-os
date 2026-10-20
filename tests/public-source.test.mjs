import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createRecoveryLock, tryAcquireRecoveryLock, releaseRecoveryLock, noteReloadAttempt, decideSourceRecovery, RECOVERY_COOLDOWN_MS } from '../packages/rules/src/source-recovery.ts';
import { classifySpeechTags, ASR_HOTWORDS } from '../packages/rules/src/speech-tags.ts';
import { isAllowedWebOrigin, assertLanBindHost } from '../apps/server/src/web-origin.ts';
import { summarizeIntervals } from '../scripts/phase-2a/refresh-summary.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const decision={ source:'compass', worstBusinessStatus:'stalled', allowlistStatus:'allowed', debuggerAttached:true, userConfirmed:false, lockHeld:false, attemptCount:0, alreadyReloadedThisEpisode:false, swGenerationMatches:true, nowMs:1000 };
test('stalled sources require human confirmation and never restart captured audio',()=>{
 assert.equal(decideSourceRecovery(decision).action,'prompt_reload');
 const confirmed=decideSourceRecovery({...decision,userConfirmed:true});
 assert.equal(confirmed.action,'execute_reload');assert.equal(confirmed.autoRestartAudio,false);assert.equal(confirmed.createNewSession,false);
 assert.equal(decideSourceRecovery({...decision,userConfirmed:true,allowlistStatus:'login'}).action,'blocked');
 assert.equal(decideSourceRecovery({...decision,userConfirmed:true,swGenerationMatches:false}).action,'blocked');
});
test('recovery lock enforces exclusivity, cooldown and a bounded retry budget',()=>{
 const lock=createRecoveryLock(7);assert.equal(tryAcquireRecoveryLock(lock,0),true);assert.equal(tryAcquireRecoveryLock(lock,0),false);
 noteReloadAttempt(lock,0);releaseRecoveryLock(lock);assert.equal(tryAcquireRecoveryLock(lock,RECOVERY_COOLDOWN_MS-1),false);
 assert.equal(tryAcquireRecoveryLock(lock,RECOVERY_COOLDOWN_MS),true);releaseRecoveryLock(lock);lock.attemptCount=3;assert.equal(tryAcquireRecoveryLock(lock,RECOVERY_COOLDOWN_MS*2),false);
});
test('empty speech remains unknown and ASR has no embedded customer vocabulary',()=>{
 assert.deepEqual(classifySpeechTags(''),['other']);assert.deepEqual(classifySpeechTags('纯合成文本'),['other']);
 assert.ok(classifySpeechTags('欢迎，演示开始，请确认参数。').includes('opening'));
 assert.ok(classifySpeechTags('价格 20 元，具体售后见商品卡。').includes('guarantee'));
 assert.deepEqual(ASR_HOTWORDS,[]);
});
test('default web access remains local and LAN binding requires explicit opt-in',()=>{
 assert.equal(isAllowedWebOrigin('http://127.0.0.1:3000',{}),true);assert.equal(isAllowedWebOrigin('https://example.org',{}),false);
 assert.doesNotThrow(()=>assertLanBindHost('127.0.0.1',{}));assert.throws(()=>assertLanBindHost('0.0.0.0',{}));
 assert.doesNotThrow(()=>assertLanBindHost('0.0.0.0',{LAN_VIEW:'1'}));
});
test('cadence summary sorts times, ignores invalid input and excludes duplicate intervals',()=>{
 const t='2030-01-01T00:00:';assert.deepEqual(summarizeIntervals([t+'15Z',t+'00Z',t+'05Z',t+'05Z','invalid']),{count:4,min:5000,median:10000,max:10000});
 assert.equal(summarizeIntervals(['invalid']),null);
});
test('independent synthetic generator reproduces its exact files without outside inputs',()=>{
 const paths=['examples/synthetic-scenarios.json','packages/source-adapters/src/calibrations/historical.ts'];
 const hash=path=>createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');
 const before=paths.map(hash);execFileSync(process.execPath,['scripts/generate-synthetic-demo.mjs'],{cwd:root,stdio:'pipe'});assert.deepEqual(paths.map(hash),before);
 const data=JSON.parse(readFileSync(resolve(root,paths[0]),'utf8'));assert.equal(data.classification,'independently_synthetic');assert.equal(data.seed,20300101);
 assert.ok(Object.values(data.profiles).every(profile=>profile.sampleSize===0));
});
