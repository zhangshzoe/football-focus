"use client";

import {useSyncExternalStore} from "react";
import {getServerStorageWarning,getStorageWarning,subscribeStorageWarnings} from "../browser-storage";

export default function BrowserStorageNotice(){
 const warning=useSyncExternalStore(subscribeStorageWarnings,getStorageWarning,getServerStorageWarning);
 return warning?<aside className="browser-storage-notice" role="status"><b>本机保存提示</b><span>{warning} 请勿直接清除全部网站数据。</span></aside>:null;
}
