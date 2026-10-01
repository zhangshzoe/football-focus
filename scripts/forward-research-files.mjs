import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
export const forwardSourceFiles={prediction:"app/prediction-model.js",input:"app/prediction-input.js",asian:"app/asian-market.js",team:"app/team-strength-model.js",history:"app/team-history.js",forward:"app/forward-validation.js",evaluation:"app/probability-evaluation.js",decision:"app/snapshot-decision-policy.js",observation:"app/research-result-observation.js",marketMetadata:"app/purchase-plan-engine.js"};
// Git may materialize LF as CRLF on Windows; identical source must retain the
// same frozen implementation identity across the local and Site runtimes.
export const hashForwardSource=source=>createHash("sha256").update(String(source).replace(/\r\n/g,"\n")).digest("hex");
export async function forwardCodeHashes(root=process.cwd()){
  return Object.fromEntries(await Promise.all(Object.entries(forwardSourceFiles).map(async([key,path])=>[key,hashForwardSource(await readFile(join(root,path),"utf8"))])));
}
export async function readResearchFiles(directory){
  const records=[];
  for(const name of(await readdir(directory).catch(()=>[])).filter(name=>name.endsWith(".json")).sort())records.push(JSON.parse(await readFile(join(directory,name),"utf8")));
  return records;
}
