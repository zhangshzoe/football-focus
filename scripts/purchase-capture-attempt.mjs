import {randomUUID} from "node:crypto";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";

// Operational evidence only: never a prediction, purchase ticket or success snapshot.
export async function writePurchaseAttempt({date,slot,scheduledAt,startedAt,status,code,reason,snapshotId,officialMatchId},root=process.cwd()){
 const attemptId=randomUUID(),completedAt=new Date().toISOString();
 const record={schemaVersion:1,recordType:"purchase-capture-attempt",immutable:true,attemptId,date,slot,scheduledAt,startedAt,completedAt,status,code:code||null,reason:reason||null,snapshotId:snapshotId||null,officialMatchId:officialMatchId||null};
 const directory=join(root,"data","capture-attempts");
 await mkdir(directory,{recursive:true});
 const path=join(directory,`${date}_purchase_${slot}_${attemptId}.json`);
 const content=JSON.stringify(record,null,2)+"\n";
 await writeFile(path,content,{encoding:"utf8",flag:"wx"});
 if(await readFile(path,"utf8")!==content)throw new Error("采集尝试记录读回失败");
 return {attemptId,path,completedAt};
}
