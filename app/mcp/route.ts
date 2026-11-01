import {handleHandoffMcp} from '../cloud-handoff/runtime.js';
// Owner-only connection approved 2026-11-01; test tools only.
// Production writes, collection and scheduling remain disabled.
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleHandoffMcp(request);}
