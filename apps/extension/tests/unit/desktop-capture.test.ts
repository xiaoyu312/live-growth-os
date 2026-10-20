import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { transformSync } from "esbuild";
// Execute the real dispatcher in isolation: Chrome user-gesture capture must stay synchronous
// in the normal build, and must not be requested at all in the desktop build.
const source = readFileSync(fileURLToPath(new URL("../../src/service-worker.ts", import.meta.url)), "utf8");
const code = source.slice(source.indexOf("function enqueueProbeMessage("), source.indexOf("chrome.debugger.onEvent.addListener"));
const compiled = transformSync(code, {loader:"ts",format:"cjs"}).code;
describe("desktop capture permission boundary",()=>{
 it.each([true,false])("desktop=%s dispatch keeps session setup while controlling tab capture",async(desktop)=>{
   const media=vi.fn(async()=>"stream");const handle=vi.fn(async()=>({ok:true}));
   const context=vm.createContext({desktopCaptureOnly:desktop,chrome:{tabCapture:{getMediaStreamId:media}},LIVE_START_DEADLINE_MS:1000,livePairReady:Promise.resolve(),handleMessage:handle,runtimeQueue:{enqueueWithDeadline:(fn:()=>unknown)=>fn(),enqueue:(fn:()=>unknown)=>fn()}});
   vm.runInContext(compiled,context);
   await vm.runInContext('enqueueProbeMessage({type:"probe:start_live",tabId:1,url:"https://compass.jinritemai.com"},Date.now())',context);
   expect(handle).toHaveBeenCalledOnce();expect(media).toHaveBeenCalledTimes(desktop?0:1);
 });
});

it("desktop connects the real transaction without audio/offscreen or a second dashboard", async () => {
  const { runLiveStartTransaction } = await import("../../src/live-start");
  const fn = source.slice(source.indexOf("async function startLive("), source.indexOf("async function stopNetwork("));
  const audio = vi.fn(async () => ({ ok: true })); const reveal = vi.fn(); const metric = vi.fn(async () => {});
  const network = vi.fn(async () => ({ ok: true })); const create = vi.fn(async () => ({ sessionId: "fixture", pairToken: "fixture", dashboardPath: "/live/fixture", reused: false }));
  const context = vm.createContext({ desktopCaptureOnly: true, activateContext: () => ({}), classifyPageUrl: () => ({ status: "allowed", routeId: "compass-live-shop" }), LIVE_START_DEADLINE_MS: 1000,
    beginLiveStart: () => Symbol(), sharedLive: { get: () => null }, loadPersistedLivePair: async () => null, pairStorage: {},
    runLiveStartTransaction, startNetwork: network, createLiveSession: create, collectLiveDomMetric: metric, startAudio: audio,
    activeSessionIdentity: null, cancelLiveStart: () => {}, responseWithPair: (r: unknown) => r, persistContext: () => {},
    shouldOpenLiveDashboard: () => true, revealLiveDashboard: reveal
  });
  vm.runInContext(transformSync(fn, { loader: "ts", format: "cjs" }).code, context);
  const result = await vm.runInContext('startLive(1,"https://compass.jinritemai.com")', context);
  expect(result).toMatchObject({ ok: true, live: { sessionId: "fixture" } });
  expect(network).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce(); expect(metric).toHaveBeenCalledOnce();
  expect(audio).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled();
});
