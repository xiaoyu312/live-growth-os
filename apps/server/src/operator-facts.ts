import { liveCompassMetricSnapshotSchema, qianchuanMetricSnapshotSchema, operatorSettingsSchema, type LiveEvent, type OperatorFacts, type OperatorSettings, type OperatorObservationRecord, type OperatorValue, type QianchuanMetricSnapshot, type LiveCompassMetricSnapshot } from "@live-growth/contracts";

const MINUTE = 60_000;
const QC_FRESH = 90_000;
const COMPASS_FRESH = 45_000;
type Point = { at: number; value: number };
type QRow = { at: number; snapshot: QianchuanMetricSnapshot; identity: string };
const fieldKeys = new Set(["observedAt", "sourceEndpoint", "mappingVersion", "dataStatus"]);

function ordered(events: readonly LiveEvent[]) {
  return [...events].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || Date.parse(a.eventAt) - Date.parse(b.eventAt) || a.eventId.localeCompare(b.eventId));
}
function currentQSegment(events: readonly LiveEvent[], now: number): QRow[] {
  const rows = ordered(events).flatMap((e) => {
    if (e.kind !== "live.qianchuan.metric") return [];
    const p = qianchuanMetricSnapshotSchema.safeParse(e.payload);
    if (!p.success || Date.parse(p.data.observedAt) > now) return [];
    return [{at:Date.parse(p.data.observedAt),snapshot:p.data,identity:[e.source,p.data.mappingVersion,p.data.sourceEndpoint,p.data.roomId ?? ""].join("|")}];
  });
  const last = rows.at(-1); if (!last || last.snapshot.dataStatus !== "fresh" || now-last.at>QC_FRESH) return [];
  let start = rows.length - 1;
  while (start > 0 && rows[start-1]!.identity === last.identity && rows[start-1]!.snapshot.dataStatus === "fresh") start--;
  return rows.slice(start).sort((a,b)=>a.at-b.at);
}
function bounded(points: readonly Point[], from: number, to: number, gap: number): Point[] | undefined {
  const first = [...points].reverse().find((p)=>p.at<=from);
  const last = [...points].reverse().find((p)=>p.at<=to);
  if (!first || !last || from-first.at>gap || to-last.at>gap || first.at>=last.at) return undefined;
  const selected = points.filter((p)=>p.at>=first.at && p.at<=last.at);
  if (selected.some((p,i)=>i>0 && p.at-selected[i-1]!.at>gap)) return undefined;
  return selected;
}
function mean(points: readonly Point[]): number | undefined {
  if (points.length<2) return undefined;
  let total=0,duration=0;
  for(let i=1;i<points.length;i++){const dt=points[i]!.at-points[i-1]!.at;if(dt<=0)continue;total+=points[i-1]!.value*dt;duration+=dt;}
  return duration>0?total/duration:undefined;
}
function value(p: Point, unit: string, source: string, samples: number, note?: string, baseline?: number): OperatorValue {
  return {value:p.value,unit,source,samples,observedAt:new Date(p.at).toISOString(),...(note?{note}:{}),...(baseline!==undefined?{baseline}:{})};
}

export function buildOperatorFacts(input: { events: readonly LiveEvent[]; sessionStartedAt: string; nowMs: number; settings: OperatorSettings; observation?: OperatorObservationRecord }): OperatorFacts {
  const {events,nowMs:now,settings}=input;
  const q = currentQSegment(events,now);
  const settingsEvents = events.filter((e)=>e.kind==="live.operator.settings" && Date.parse(e.eventAt)<=now && Date.parse(e.capturedAt)<=now).sort((a,b)=>Date.parse(a.eventAt)-Date.parse(b.eventAt)||Number(a.metadata?.operatorSequence??0)-Number(b.metadata?.operatorSequence??0));
  const transitions: Array<{at:number;mode:OperatorSettings["mode"]}> = [];
  let oldMode:OperatorSettings["mode"]="regular";
  for(const e of settingsEvents){const p=operatorSettingsSchema.safeParse(e.payload);if(p.success&&p.data.mode!==oldMode){oldMode=p.data.mode;transitions.push({at:Date.parse(e.eventAt),mode:oldMode});}}
  const modeAt=(at:number)=>[...transitions].reverse().find((p)=>p.at<=at)?.mode??"regular";
  const sameMode=(a:number,b:number)=>modeAt(a)===settings.mode&&modeAt(b)===settings.mode&&!transitions.some((t)=>t.at>a&&t.at<=b);
  const compass = ordered(events).flatMap((e)=>{if(e.kind!=="live.compass.metric")return [];const p=liveCompassMetricSnapshotSchema.safeParse(e.payload);return p.success&&Date.parse(p.data.observedAt)<=now&&p.data.dataStatus==="fresh"?[p.data]:[];});
  const cp=(key:keyof LiveCompassMetricSnapshot):Point[]=>compass.flatMap((p)=>typeof p[key]==="number"?[{at:Date.parse(p.observedAt),value:p[key] as number}]:[]).sort((a,b)=>a.at-b.at);
  const currentCp=(key:keyof LiveCompassMetricSnapshot)=>{const p=cp(key).at(-1);return p&&now-p.at<=COMPASS_FRESH?p:undefined;};
  const qp=(key:keyof QianchuanMetricSnapshot["metrics"]):Point[]=>q.flatMap((p)=>p.snapshot.metrics[key]?[{at:p.at,value:p.snapshot.metrics[key]!.value}]:[]);
  const currentQ=(key:keyof QianchuanMetricSnapshot["metrics"])=>{const last=q.at(-1);const m=last?.snapshot.metrics[key];return last&&m?{at:last.at,value:m.value}:undefined;};
  const delta=(key:keyof QianchuanMetricSnapshot["metrics"],minutes:number,unit:string):OperatorValue|undefined=>{
    const latest=currentQ(key); if(!latest)return undefined;
    const points=bounded(qp(key),latest.at-minutes*MINUTE,latest.at,QC_FRESH*2);
    if(!points || points.some((p,i)=>i>0&&p.value<points[i-1]!.value))return undefined;
    const amount=points.at(-1)!.value-points[0]!.value;
    return value({at:latest.at,value:amount},unit,"千川直播间累计差值",points.length,`约近${minutes}分钟；采样边界误差不超过3分钟，同源计数器重置时不计算`);
  };
  const started=q.at(-1)?.snapshot.roomStartedAt;
  const conservativeStart=started?Date.parse(started):Math.max(Date.parse(input.sessionStartedAt),q[0]?.at??0);
  const result:OperatorFacts={elapsedMinutes:Math.max(0,(now-conservativeStart)/MINUTE),mode:settings.mode};
  const assign=(key:keyof OperatorFacts,v:unknown)=>{if(v!==undefined)(result as Record<string,unknown>)[key]=v;};
  assign("spendHour",delta("adSpend",60,"元"));assign("gmvHour",delta("paidOrderGmv",60,"元"));assign("ordersHour",delta("paidOrderCount",60,"单"));assign("orders30m",delta("paidOrderCount",30,"单"));
  const stay=currentCp("averageWatchDurationSec");if(stay)result.staySeconds=value(stay,"秒","罗盘整场平均停留",1);
  const online=currentCp("onlineSnapshot");
  if(online){
    const points=bounded(cp("onlineSnapshot"),now-5*MINUTE,now,COMPASS_FRESH);
    if(points)result.onlineLow5m=points.every((p)=>p.value<=1);
    const prior=bounded(cp("onlineSnapshot"),now-35*MINUTE,now-5*MINUTE,COMPASS_FRESH);
    if(points&&prior){const usual=mean(prior);result.onlineSpike5m=usual!==undefined&&usual<=10&&points.every((p)=>p.value>20);}
  }
  const enters=currentCp("roomEnterCount5m");
  if(enters){const history=bounded(cp("roomEnterCount5m"),now-35*MINUTE,now-5*MINUTE,COMPASS_FRESH);result.enters5m=value(enters,"人/5分钟","罗盘近5分钟直播间进入",1,"参照为此前30分钟同口径滚动值的时间加权均值，不相加",history?mean(history):undefined);}
  const gpm=currentQ("gpm");
  if(gpm){const all=bounded(qp("gpm"),gpm.at-30*MINUTE,gpm.at,QC_FRESH*2);let total=0,dt=0,count=0;
    if(all)for(let i=1;i<all.length;i++){const a=all[i-1]!,b=all[i]!;if(sameMode(a.at,b.at)){total+=a.value*(b.at-a.at);dt+=b.at-a.at;count++;}}
    result.gpm=value(gpm,"元","千川接口GPM",count+1,"保留平台原口径；参照过去30分钟内同模式样本，非GSV GPM",dt>0?total/dt:undefined);
  }
  const ratio=(num:keyof QianchuanMetricSnapshot["metrics"],den:keyof QianchuanMetricSnapshot["metrics"],scale:number,unit:string,label:string):OperatorValue|undefined=>{
    const latest=q.at(-1);if(!latest?.snapshot.metrics[num]||!latest.snapshot.metrics[den])return undefined;
    const aggregate=(from:number,to:number)=>{
      const np=bounded(qp(num),from,to,QC_FRESH*2),dp=bounded(qp(den),from,to,QC_FRESH*2);if(!np||!dp)return undefined;
      let numerator=0,denominator=0,samples=0;
      const rows=q.filter((p)=>p.at>=Math.max(np[0]!.at,dp[0]!.at)&&p.at<=to);
      for(let i=1;i<rows.length;i++){const a=rows[i-1]!,b=rows[i]!;const an=a.snapshot.metrics[num],bn=b.snapshot.metrics[num],ad=a.snapshot.metrics[den],bd=b.snapshot.metrics[den];if(!an||!bn||!ad||!bd||b.at-a.at>QC_FRESH*2)return undefined;if(bn.value<an.value||bd.value<ad.value)return undefined;if(!sameMode(a.at,b.at))continue;numerator+=bn.value-an.value;denominator+=bd.value-ad.value;samples++;}
      return denominator>0&&samples>0?{value:numerator/denominator*scale,samples}:undefined;
    };
    const current=aggregate(latest.at-10*MINUTE,latest.at);if(!current)return undefined;
    const baseline=aggregate(latest.at-40*MINUTE,latest.at-10*MINUTE);
    return value({at:latest.at,value:current.value},unit,label,current.samples+1,"近10分钟内同模式增量；对照此前30分钟同模式区间。模式跨界与计数器重置不混算",baseline?.value);
  };
  assign("cvr",ratio("paidOrderCount","productClicks",100,"%（订单/点击次数）","千川订单口径CVR"));
  assign("aov",ratio("paidOrderGmv","paidOrderCount",1,"元/订单","千川支付订单均额"));
  const cpm=currentQ("cpmPlatform");if(cpm)result.cpm=value(cpm,"元","千川接口CPM",1,"平台原统计口径，不由累计CPM差分");
  // Generic platform CTR/CVR are not product-exposure or buyer-UV conversion rates.
  // Comments/follows alone do not prove the denominator of the business rate.
  if(input.observation){const age=now-Date.parse(input.observation.observedAt);if(age>=0&&age<10*MINUTE)result.observation=input.observation.values;}
  return result;
}

export function availableOperatorFields(events:readonly LiveEvent[],nowMs:number): {compass:string[];qianchuan:string[]} {
  const q=currentQSegment(events,nowMs).at(-1)?.snapshot;
  const compass=new Set<string>();
  for(const e of events){if(e.kind!=="live.compass.metric")continue;const p=liveCompassMetricSnapshotSchema.safeParse(e.payload);if(!p.success||nowMs-Date.parse(p.data.observedAt)>COMPASS_FRESH||Date.parse(p.data.observedAt)>nowMs||p.data.dataStatus!=="fresh")continue;for(const key of Object.keys(p.data))if(!fieldKeys.has(key))compass.add(key);}
  return {compass:[...compass],qianchuan:Object.keys(q?.metrics??{})};
}
