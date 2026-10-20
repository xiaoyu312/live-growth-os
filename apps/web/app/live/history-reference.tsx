"use client";
import { useEffect, useState } from "react";
import { operatorHistoryReferenceSchema, type OperatorHistoryReference, type OperatorHistoryHourRecord } from "@live-growth/contracts";
import { resolveLiveBackend } from "./backend-url";

type HistoryView={status:string;dateRange?:{from:string;to:string};builtAt?:string;reference?:OperatorHistoryReference;scopeNote?:string};
function normalize(input:unknown):HistoryView {
  if(!input||typeof input!=="object")throw new Error("历史参照响应无效");
  const o=input as Record<string,unknown>;const ref=operatorHistoryReferenceSchema.safeParse(o.reference);
  return {status:typeof o.status==="string"?o.status:"invalid",...(o.dateRange&&typeof o.dateRange==="object"?{dateRange:o.dateRange as {from:string;to:string}}:{}),...(typeof o.builtAt==="string"?{builtAt:o.builtAt}:{}),...(ref.success?{reference:ref.data}:{}),...(typeof o.scopeNote==="string"?{scopeNote:o.scopeNote}:{})};
}
function median(rows:OperatorHistoryHourRecord[],key:"gmvFen"|"adSpendFen") {const values=rows.flatMap(r=>r.metrics[key]===undefined?[]:[r.metrics[key]!/100]).sort((a,b)=>a-b);if(values.length<2)return "样本不足";const n=Math.floor(values.length/2);return `¥${(values.length%2?values[n]!:((values[n-1]!+values[n]!)/2)).toFixed(0)}`;}
export default function HistoryReference({sessionId}:{sessionId:string}){
  const [view,setView]=useState<HistoryView|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const api=()=>resolveLiveBackend(window.location).api;
  useEffect(()=>{const abort=new AbortController();const refresh=async()=>{try{const r=await fetch(`${api()}/api/live/sessions/${encodeURIComponent(sessionId)}/operator-history`,{signal:abort.signal,cache:"no-store"});if(!r.ok)throw new Error();const value=normalize(await r.json());if(!abort.signal.aborted){setView(value);setError("");}}catch{if(!abort.signal.aborted)setError("历史参照暂时读不到");}};void refresh();const timer=setInterval(()=>{void refresh();},10000);return()=>{abort.abort();clearInterval(timer);};},[sessionId]);
  const importFile=async(file:File)=>{setBusy(true);setError("");try{if(file.size>4_000_000)throw new Error("文件过大，请使用生成的小时基线包");const body=JSON.parse(await file.text());const r=await fetch(`${api()}/api/live/operator-history`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error("导入失败，请检查基线文件和本机连接");const fresh=await fetch(`${api()}/api/live/sessions/${encodeURIComponent(sessionId)}/operator-history`);setView(normalize(await fresh.json()));}catch(e){setError(e instanceof Error?e.message:"导入失败");}finally{setBusy(false);}};
  const ref=view?.reference;const fallback=ref?.status!=="ok"?ref?.unlabeledFallback:undefined;const rows=ref?.status==="ok"?ref.records:fallback?.records??ref?.records??[];
  return <details className="live-pilot-guide" style={{marginTop:16}}><summary>示例项目 历史小时参照{view?.status==="available"?` · ${view.dateRange?.to??"已导入"}`:" · 尚未就绪"}</summary>
    <p>历史与本场实时窗口分开展示，不用小时数据替代当前 10 分钟判断。</p>
    {error&&<p role="alert">{error}</p>}
    {ref&&<><p>{ref.query.hour}:00—{ref.query.hour+1}:00 · 同星期 · {ref.query.mode==="pulse"?"脉冲场":"非脉冲场"}</p><p>{ref.status==="ok"?`${ref.sampleDateCount} 个历史日期可作小时参照`:fallback?"非脉冲标签不足。以下仅列场型未标注的历史，不能当作非脉冲基线。":"同场型历史不足 2 个日期，不做高低判断。"}</p>
      {rows.length>0&&<><p>小时成交金额中位数：{median(rows,"gmvFen")}　小时消耗中位数：{median(rows,"adSpendFen")}</p><small>样本日期：{rows.map(r=>r.localDate).join("、")}</small></>}
    </>}
    {view?.dateRange&&<p>数据范围：{view.dateRange.from} 至 {view.dateRange.to}；更新于 {view.builtAt?new Date(view.builtAt).toLocaleDateString():"未知"}。</p>}
    <label>导入历史基线包 <input type="file" accept="application/json,.json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file);e.target.value="";}} /></label>
    <p><small>基线文件单独导入；安装包不携带经营数据或飞书凭据。</small></p>
  </details>;
}
