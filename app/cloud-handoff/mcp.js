import {probeOfficialSource} from './source-probe.js';
import {authorizeOwner,HandoffStore} from './store.js';
const tools=[
  {name:'football_source_probe',description:'Owner-only read-only official source check through the existing Site adapter. No repair, alternate fallback, persistence or prediction. Reports partial/stale/denied honestly.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'football_handoff_status',description:'Read staged cloud handoff readiness. Does not capture, enable schedules, or change production.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'football_test_persistence',description:'Owner-only isolated D1/R2 persistence probe. No sports source fetch or production records. Reuse requestId for readback; terminal failures never retry.',inputSchema:{type:'object',properties:{requestId:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,80}$'}},required:['requestId'],additionalProperties:false}},
  {name:'football_test_readback',description:'Read and hash-verify an existing isolated persistence probe; no writes.',inputSchema:{type:'object',properties:{requestId:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,80}$'}},required:['requestId'],additionalProperties:false}},
];
const namespace='test-owner-handoff';
export async function handoffMcp(request,env,dependencies={}) {
  try {authorizeOwner(request.headers,env.PREDICTION_OPERATOR_EMAIL);}catch{return Response.json({error:'OWNER_IDENTITY_REQUIRED'},{status:403});}
  let rpc;
  try {const text=await request.text();if(text.length>4096)throw new Error();rpc=JSON.parse(text);if(!rpc||typeof rpc!=='object'||Array.isArray(rpc)||typeof rpc.method!=='string')throw new Error();}catch{return Response.json({error:'INVALID_REQUEST'},{status:400});}
  const response=result=>Response.json({jsonrpc:'2.0',id:rpc.id??null,result});
  if(rpc.method==='server/discover')return response({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if(rpc.method==='tools/list')return response({tools});
  if(rpc.method!=='tools/call')return Response.json({jsonrpc:'2.0',id:rpc.id??null,error:{code:-32601,message:'Method not found'}});
  try {
    const name=rpc.params?.name,args=rpc.params?.arguments??{};
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('INVALID_TOOL_ARGUMENTS');
    if(['football_handoff_status','football_source_probe'].includes(name)&&Object.keys(args).length)throw new Error('INVALID_TOOL_ARGUMENTS');
    if(name==='football_source_probe')return response({content:[{type:'text',text:JSON.stringify(await probeOfficialSource(dependencies.readOfficialSource))}]});
    if(name==='football_handoff_status')return response({content:[{type:'text',text:JSON.stringify({productionEnabled:false,stage:'test-only-foundation',bindingsDeclared:Boolean(env.DB&&env.RESEARCH_OBJECTS),sourceAccessVerified:false,historyImportVerified:false,scheduleEnabled:false})}]});
    if(!['football_test_persistence','football_test_readback'].includes(name)||typeof args.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(args.requestId)||Object.keys(args).some(k=>k!=='requestId'))throw new Error('INVALID_TOOL_ARGUMENTS');
    const store=new HandoffStore(env.DB,env.RESEARCH_OBJECTS),id=args.requestId,key=`${namespace}|probe|${id}`;
    if(name==='football_test_persistence') {
      const claim=await store.claim({namespace,key});
      if(claim.claimed) {
        try {
          const observedAt=new Date().toISOString();
          const raw=JSON.stringify({recordType:'isolated-storage-probe',requestId:id,observedAt,synthetic:true,notPrediction:true});
          await store.write({namespace,key,token:claim.token,kind:'probe',id,raw,observedAt});
          await store.finish({namespace,key,token:claim.token,status:'complete'});
        } catch(error) {
          await store.finish({namespace,key,token:claim.token,status:'failed',failureCode:'PERSISTENCE_PROBE_FAILED'});
          throw error;
        }
      } else if(claim.status!=='complete')throw new Error(`PROBE_${claim.status.toUpperCase().replaceAll('-','_')}_NO_RETRY`);
    }
    const row=await store.get(namespace,'probe',id),batch=await store.batch(key);
    if(!row||batch?.status!=='complete')throw new Error('PROBE_NOT_COMPLETE');
    return response({content:[{type:'text',text:JSON.stringify({namespace,requestId:id,status:batch.status,contentHash:row.content_hash,observedAt:row.observed_at,raw:JSON.parse(row.raw),productionEnabled:false})}]});
  } catch(error) {return response({content:[{type:'text',text:error instanceof Error?error.message:'HANDOFF_FAILED'}],isError:true});}
}
