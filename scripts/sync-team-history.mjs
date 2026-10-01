import {execFileSync} from "node:child_process";
import {readFile,readdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {buildTeamHistoryIndex} from "../app/team-history.js";
const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const directory=join(process.cwd(),"data/prediction-snapshots");
const tracked=execFileSync("git",["ls-files","data/prediction-snapshots/*.raw.json"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(Boolean);
const fresh=(await readdir(directory)).filter(name=>name.startsWith(today+"_")&&/^\d{4}-\d{2}-\d{2}_\d{4}\.raw\.json$/.test(name)).map(name=>join("data/prediction-snapshots",name).replaceAll("\\","/"));
const files=[...new Set([...tracked,...fresh])].sort();
const snapshots=[];
for(const file of files){try{snapshots.push(JSON.parse(await readFile(file,"utf8")));}catch{throw new Error(`历史原始记录无法读取：${file}`);}}
const result=buildTeamHistoryIndex(snapshots),path=join(process.cwd(),"data/generated-team-history-index.json"),text=JSON.stringify(result)+"\n";
if(await readFile(path,"utf8").catch(()=>"")!==text)await writeFile(path,text);
console.log(JSON.stringify({status:"indexed",historyVersion:result.historyVersion,rows:result.rows.length,excluded:result.excluded}));
