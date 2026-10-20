import { randomUUID } from "node:crypto";
import { liveEventSchema, operatorSettingsSchema, operatorObservationSchema, operatorObservationRecordSchema, operatorStateSchema, operatorRulesViewSchema, type LiveEvent, type OperatorRulesView, type OperatorTiming, type OperatorSettings } from "@live-growth/contracts";
import { evaluateOperatorRules } from "@live-growth/rules";
import type { EventStore } from "./storage";
import type { SessionService } from "./session-service";
import { buildOperatorFacts, availableOperatorFields } from "./operator-facts";

export const DEFAULT_OPERATOR_SETTINGS: OperatorSettings = {mode:"regular",retargetMaterials:[],activityPlan:""};
const REVIEW_MS=10*60_000;
function operatorSequence(event:LiveEvent):number|undefined{
  const raw=event.metadata?.operatorSequence;
  const sequence=typeof raw==="number"?raw:Number(raw);
  return Number.isSafeInteger(sequence)&&sequence>0?sequence:undefined;
}
export class OperatorRulesService {
  private closing=false;
  async close(){this.closing=true;await Promise.allSettled([...this.flights.values()]);}
  private flights=new Map<string,Promise<unknown>>();
  constructor(private readonly sessions:SessionService,private readonly store:EventStore,private readonly clock:()=>number=Date.now){}
  private lock<T>(id:string,fn:()=>Promise<T>):Promise<T>{
    if(this.closing)return Promise.reject(new Error("OPERATOR_RULES_CLOSED"));
    const previous=this.flights.get(id)??Promise.resolve();const next=previous.catch(()=>undefined).then(fn);
    this.flights.set(id,next);void next.finally(()=>{if(this.flights.get(id)===next)this.flights.delete(id);}).catch(()=>undefined);return next;
  }
  private latest(events:LiveEvent[],kind:LiveEvent["kind"]){
    const now=this.clock();
    return events.filter(e=>e.kind===kind && Date.parse(e.eventAt)<=now && Date.parse(e.capturedAt)<=now).sort((a,b)=>{
      const aSequence=operatorSequence(a),bSequence=operatorSequence(b);
      // Operator writes carry a monotonic sequence. Legacy events without it
      // keep wall-clock ordering as their only reliable ordering signal. A
      // valid sequence always outranks legacy data to keep the comparator
      // transitive when the two kinds are mixed.
      if(aSequence!==undefined&&bSequence===undefined)return 1;
      if(aSequence===undefined&&bSequence!==undefined)return -1;
      if(aSequence!==undefined&&bSequence!==undefined&&aSequence!==bSequence)return aSequence-bSequence;
      return Date.parse(a.eventAt)-Date.parse(b.eventAt)||Date.parse(a.capturedAt)-Date.parse(b.capturedAt);
    }).at(-1);
  }
  async currentSettings(id:string):Promise<OperatorSettings>{const events=await this.store.listEvents(id);const last=this.latest(events,"live.operator.settings");return last?operatorSettingsSchema.parse(last.payload):DEFAULT_OPERATOR_SETTINGS;}
  private async append(id:string,kind:LiveEvent["kind"],payload:unknown){
    const session=await this.sessions.get(id);if(session.scenario!=="live_compass"||session.status!=="running")throw new Error("OPERATOR_SESSION_NOT_RUNNING");
    const all=await this.store.listEvents(id);const sequence=all.reduce((n,e)=>Math.max(n,operatorSequence(e)??0),0)+1;
    const at=new Date(this.clock()).toISOString();await this.sessions.ingest(liveEventSchema.parse({schemaVersion:1,eventId:randomUUID(),tenantId:session.tenantId,sessionId:id,eventAt:at,capturedAt:at,ingestedAt:at,source:"operator",kind,provisional:false,payload,metadata:{operatorSequence:sequence}}));
  }
  saveSettings(id:string,input:unknown):Promise<OperatorRulesView>{return this.lock(id,async()=>{await this.append(id,"live.operator.settings",operatorSettingsSchema.parse(input));return this.project(id);});}
  saveObservation(id:string,input:unknown):Promise<OperatorRulesView>{return this.lock(id,async()=>{const values=operatorObservationSchema.parse(input);await this.append(id,"live.operator.observation",{observedAt:new Date(this.clock()).toISOString(),values});return this.project(id);});}
  view(id:string):Promise<OperatorRulesView>{return this.lock(id,()=>this.project(id));}
  private async project(id:string):Promise<OperatorRulesView>{
    const session=await this.sessions.get(id);if(session.scenario!=="live_compass")throw new Error("OPERATOR_LIVE_SESSION_REQUIRED");
    const events=await this.store.listEvents(id);const now=this.clock(),at=new Date(now).toISOString();
    const settingsEvent=this.latest(events,"live.operator.settings");const settings=settingsEvent?operatorSettingsSchema.parse(settingsEvent.payload):DEFAULT_OPERATOR_SETTINGS;
    const observationEvent=this.latest(events,"live.operator.observation");const observation=observationEvent?operatorObservationRecordSchema.parse(observationEvent.payload):undefined;
    const facts=buildOperatorFacts({events,sessionStartedAt:session.startedAt??session.createdAt,nowMs:now,settings,...(observation?{observation}:{})});
    const coverage=evaluateOperatorRules(facts,settings);
    const oldEvent=this.latest(events,"live.operator.state");const old=oldEvent?operatorStateSchema.parse(oldEvent.payload).timings:[];
    const timings:OperatorTiming[]=[];
    const active:OperatorRulesView["active"]=[];
    if(session.status==="running")for(const row of coverage){
      if(row.state==="clear")continue;
      let timing=old.find(t=>t.ruleId===row.ruleId);
      if(row.state==="insufficient_data"&&!timing)continue;
      if(!timing)timing={ruleId:row.ruleId,firstDetectedAt:at,lastReviewedAt:at,nextReviewAt:new Date(now+REVIEW_MS).toISOString(),recheckCount:0};
      else if(row.state==="triggered"&&now>=Date.parse(timing.nextReviewAt))timing={...timing,lastReviewedAt:at,nextReviewAt:new Date(now+REVIEW_MS).toISOString(),recheckCount:timing.recheckCount+1};
      timings.push(timing);
      active.push({...row,...timing,...(row.state==="insufficient_data"?{actions:["先复查数据或现场状态，暂缓沿用旧建议。"],fallback:[],hypotheses:[],reason:`先前问题尚未确认解除。${row.reason}`}:{})});
    }
    if(session.status==="running"&&JSON.stringify(timings)!==JSON.stringify(old))await this.append(id,"live.operator.state",{version:"operator-live-v1",timings});
    // The engine determines priority; preserve its stable ordering for one main card.
    return operatorRulesViewSchema.parse({enabled:true,version:"operator-live-v1",updatedAt:at,settings,...(observation?{observation}:{}),active,coverage,dataAvailability:availableOperatorFields(events,now)});
  }
}
