const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const {join} = require('node:path');
function policy() {
  const context = vm.createContext({require:(name)=>name==='electron'?{app:{isPackaged:false,getPath:()=>'/tmp/test',requestSingleInstanceLock:()=>false,quit(){}}}:name==='./app-preset.cjs'?require('../app-preset.cjs'):require(name),process:{env:{HOME:'/tmp/user',QIANCHUAN_API_APP_SECRET:'synthetic',ARK_API_KEY:'synthetic'},platform:'darwin'},__dirname:join(__dirname,'..'),URL,Set,console,setTimeout,clearTimeout,fetch});
  vm.runInContext(readFileSync(join(__dirname,'../main.cjs'),'utf8'),context);
  return (expression)=>vm.runInContext(expression,context);
}
test('only exact official OAuth with one state, scope and local callback can leave the app',()=>{
 const run=policy(); const url=new URL('https://qianchuan.jinritemai.com/openapi/qc/audit/oauth.html');
 url.searchParams.set('app_id','1234');url.searchParams.set('state','a'.repeat(64));url.searchParams.set('redirect_uri','http://127.0.0.1:18889/qianchuan/callback');url.searchParams.set('scope','[20101000,20121100,200000011,21121000,22100400]');
 const check=(u)=>run(`allowedExternal(${JSON.stringify(String(u))})`);
 assert.equal(check(url),true);
 for(const u of ['file:///tmp/a','javascript:alert(1)','https://example.org','https://compass.jinritemai.com.attacker.org/'])assert.equal(check(u),false);
 const extra=new URL(url);extra.searchParams.append('state','b'.repeat(64));assert.equal(check(extra),false);
 const agent=new URL(url);agent.searchParams.set('scope','[20101000,20111100,20121100,200000011,21121000,22100400]');assert.equal(check(agent),false);
 const scope=new URL(url);scope.searchParams.set('scope','[1]');assert.equal(check(scope),false);
 const redirect=new URL(url);redirect.searchParams.set('redirect_uri','http://example.org');assert.equal(check(redirect),false);
});
test('local navigation stays on the exact copilot origin and child env drops credentials',()=>{
 const run=policy();assert.equal(run("local('http://127.0.0.1:3000/live/connect')"),true);
 for(const u of ['http://127.0.0.1:3000/mvp','http://user@127.0.0.1:3000/live','http://localhost:3000/live','http://127.0.0.1:3001/live'])assert.equal(run(`local(${JSON.stringify(u)})`),false);
 const env=run("cleanEnv('server')");assert.equal(env.QIANCHUAN_API_APP_SECRET,undefined);assert.equal(env.ARK_API_KEY,undefined);assert.equal(env.ELECTRON_RUN_AS_NODE,'1');assert.equal(env.HOST,'127.0.0.1');
});
