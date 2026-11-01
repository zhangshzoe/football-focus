import {fetchOfficialSporttery} from '../sporttery-official';
import {env} from 'cloudflare:workers';
import {handoffMcp} from './mcp.js';
import {readProductionProjectionForDisplay} from './store.js';
export const handleHandoffMcp=request=>handoffMcp(request,env,{readOfficialSource:()=>fetchOfficialSporttery({repair:false,serverHeaders:true,allowMobileFallback:false})});
export const readHandoffProjection=baseline=>readProductionProjectionForDisplay(env.DB,env.RESEARCH_OBJECTS,baseline);
