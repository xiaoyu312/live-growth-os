import { readFile, stat } from "node:fs/promises";
import { operatorHistoryBundleSchema, type OperatorHistoryBundle, type OperatorMode } from "@live-growth/contracts";
import { selectOperatorHistoryReference } from "@live-growth/source-adapters";
import { atomicWrite } from "./qianchuan-connect";

export class OperatorHistoryService {
  private bundle?:OperatorHistoryBundle;
  private loadFlight?:Promise<void>;
  private invalid=false;
  constructor(private readonly path:string){}
  private load():Promise<void>{
    this.loadFlight ??= this.readOnce();return this.loadFlight;
  }
  private async readOnce(){
    try{if((await stat(this.path)).size>4_000_000)throw new Error("too large");this.bundle=this.validate(JSON.parse(await readFile(this.path,"utf8")));}
    catch(e){this.invalid=(e as NodeJS.ErrnoException).code!=="ENOENT";}
  }
  private validate(input:unknown){
    const bundle=operatorHistoryBundleSchema.parse(input);
    if(bundle.records.length>20000)throw new Error("OPERATOR_HISTORY_TOO_LARGE");
    const keys=new Set<string>();
    for(const r of bundle.records){const k=`${r.localDate}:${r.hour}`;if(keys.has(k))throw new Error("OPERATOR_HISTORY_DUPLICATE_HOUR");keys.add(k);}
    return bundle;
  }
  async import(input:unknown){
    await this.load();const bundle=this.validate(input);await atomicWrite(this.path,JSON.stringify(bundle));this.bundle=bundle;this.invalid=false;return this.summary();
  }
  async summary(){await this.load();return this.bundle?{status:"available" as const,dateRange:this.bundle.dateRange,builtAt:this.bundle.builtAt,sourceRevision:this.bundle.sourceRevision,sourceSummary:this.bundle.sourceSummary,grain:"hour" as const}:{status:this.invalid?"invalid" as const:"not_imported" as const};}
  async reference(mode:OperatorMode,nowMs:number){
    await this.load();if(!this.bundle)return this.summary();
    // Use the last completed clock-hour, never compare a partial live window with a full historical hour.
    const shanghai=new Date(nowMs+8*60*60_000-60*60_000);const date=shanghai.toISOString().slice(0,10),hour=shanghai.getUTCHours();
    return {...await this.summary(),reference:selectOperatorHistoryReference(this.bundle,{date,hour,mode}),scopeNote:"历史登记小时口径，仅作参照；不与当前10分钟窗口直接比较，不驱动实时提醒。未标注时段不当作非脉冲场。"};
  }
}
