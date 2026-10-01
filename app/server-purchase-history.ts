import {readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import snapshotIndex from "../data/generated-prediction-snapshot-index.json";
import {purchaseHistorySnapshot,loadPurchaseHistorySources} from "./purchase-history-source.js";
import {getCloudResearchStore} from "./cloud-research-binding";
import {cloudCaptureReadModel} from "./cloud-capture-read-model.js";

export async function readServerPurchaseHistory() {
  return loadPurchaseHistorySources({bundled:snapshotIndex.purchasePlanSnapshots||[],
    readDisk:async()=>{
      if(process.env.NODE_ENV==="production") return [];
      const directory=join(process.cwd(),"data","purchase-plan-snapshots");
      const names=await readdir(directory).catch(error=>{if(error.code==="ENOENT")return [];throw error;});
      return (await Promise.all(names.filter(name=>name.endsWith(".json")).map(async name=>
        purchaseHistorySnapshot(JSON.parse(await readFile(join(directory,name),"utf8")))))).filter((record):record is NonNullable<typeof record>=>record!==null);
    },
    readCloud:async()=>{
      if(process.env.NODE_ENV!=="production")return [];
      const view=await cloudCaptureReadModel(getCloudResearchStore(),{projectRaw:null,projectPurchase:purchaseHistorySnapshot});
      return view.purchases;
    },
  });
}
