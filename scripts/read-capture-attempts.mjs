import {readdir,readFile} from "node:fs/promises";
import {join} from "node:path";
import {compactCaptureAttempts} from "../app/capture-health.js";
export async function readCaptureAttempts(root=process.cwd()) {
  const directory=join(root,"data/capture-attempts"),records=[];
  for(const name of await readdir(directory).catch(error=>{if(error.code==="ENOENT")return [];throw error;})){
    if(!/^\d{4}-\d{2}-\d{2}_[a-z-]+_(?:\d{4}|poll)_[0-9a-f-]+\.json$/.test(name))continue;
    records.push(JSON.parse(await readFile(join(directory,name),"utf8")));
  }
  return compactCaptureAttempts(records);
}
