import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freezeForwardManifest } from "../app/forward-validation.js";
import { forwardCodeHashes } from "./forward-research-files.mjs";

const frozenAt=new Date().toISOString();
const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date(Date.now()+86400000));
const startAt=new Date(`${date}T00:00:00+08:00`).toISOString(),endAt=new Date(Date.parse(startAt)+60*86400000).toISOString();
const manifest=freezeForwardManifest({startAt,endAt,teamWeight:.25,codeHashes:await forwardCodeHashes()},frozenAt);
const directory=join(process.cwd(),"data","forward-validation-manifests");await mkdir(directory,{recursive:true});
const path=join(directory,manifest.manifestId+".json");
await writeFile(path,JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({status:"frozen",path,manifestId:manifest.manifestId,startAt,endAt,automaticPromotion:false}));
