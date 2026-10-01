import { NextResponse } from "next/server";
import index from "../../../data/generated-forward-validation-index.json";
import { readResearchResults } from "../../research-result-store";
import { researchValidationView } from "../../research-validation-view.js";
import {getCloudResearchStore} from "../../cloud-research-binding";
const headers={"Cache-Control":"no-store, max-age=0"};
export async function GET(request:Request){
 let data=index as {manifest?:unknown;evaluation?:Record<string,unknown>;resultEvents?:Array<{eventId:string;contentHash:string}>;evaluatedAt?:string;invalidResultEvents?:unknown[]};
 try{
  let latestAttempt:any=null;
  if(process.env.NODE_ENV==="production"){
   const store=getCloudResearchStore(),latest=await store.latest("replay-index");
   if(latest)data=latest.payload;
   latestAttempt=(await store.latest("source-attempt"))?.payload;
  }
  const liveEvents=await readResearchResults();
  const view=researchValidationView(data,liveEvents,Date.now());
  if(latestAttempt?.status==="failed"||latestAttempt?.result?.index?.status==="failed")view.evaluation={...view.evaluation,status:"cloud-update-unavailable",eligible:false,reason:"最新采集或冻结重放失败，未确认完整覆盖"};
  if(new URL(request.url).searchParams.get("view")==="events")return NextResponse.json({resultEvents:view.resultEvents,invalidResultEvents:view.invalidResultEvents},{headers});
  const {resultEvents,...summary}=view;
  return NextResponse.json(summary,{headers});
 }catch(error){return NextResponse.json({manifest:data.manifest,evaluation:{...(data.evaluation||{}),status:"result-store-unavailable",eligible:false},resultStoreError:error instanceof Error?error.message:"首次观测记录不可用"},{headers,status:503});}
}
