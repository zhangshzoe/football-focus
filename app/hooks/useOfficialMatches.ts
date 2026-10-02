"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { readBrowserData, writeBrowserData } from "../browser-storage";
import { fetchOfficialSporttery, OfficialSportteryError } from "../sporttery-official";
import {
  SPORTTERY_CACHE_KEY,
  OfficialAccessBlockedError,
  OfficialManifestUnavailableError,
  mergeOfficialMatches,
  compareMatchesByDateAndSequence,
  type Match,
  type DataState,
  type PoolStatus,
} from "../football-workspace";

type OfficialBatch = {
  matches: Match[];
  upstreamUpdatedAt?: string;
  fetchedAt?: string;
  poolStatus?: PoolStatus;
  deliveryMode?: string;
};
const metadata = (batch: OfficialBatch) => ({
  upstreamUpdatedAt: batch.upstreamUpdatedAt || "",
  fetchedAt: batch.fetchedAt || "",
  poolStatus: batch.poolStatus,
  deliveryMode: batch.deliveryMode,
});
const errorCode = (error: unknown) =>
  error instanceof OfficialAccessBlockedError
    ? "OFFICIAL_ACCESS_BLOCKED"
    : error instanceof OfficialManifestUnavailableError
      ? "OFFICIAL_MANIFEST_UNAVAILABLE"
      : "OFFICIAL_FETCH_FAILED";

async function loadOfficialBatch(repair: boolean, signal: AbortSignal): Promise<OfficialBatch> {
  try {
    const response = await fetch(`/api/sporttery${repair ? "?repairMissing=1" : ""}`, {
      cache: "no-store",
      signal,
    });
    const raw = await response.text();
    let data: Partial<OfficialBatch> & { code?: string; error?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`站点数据接口返回异常（HTTP ${response.status}）`);
    }
    signal.throwIfAborted();
    if (!response.ok) {
      if (data.code === "OFFICIAL_ACCESS_BLOCKED")
        throw new OfficialAccessBlockedError(data.error || "官方数据源拒绝本站访问");
      if (data.code === "OFFICIAL_MANIFEST_UNAVAILABLE")
        throw new OfficialManifestUnavailableError(
          data.error || "官方未提供赛事清单，当前比赛数量未知",
        );
      throw new Error(data.error || "官方数据读取失败");
    }
    if (!Array.isArray(data.matches))
      throw new OfficialManifestUnavailableError("站点没有返回有效赛事清单，当前比赛数量未知");
    return data as OfficialBatch;
  } catch (internalError) {
    signal.throwIfAborted();
    try {
      const result = await fetchOfficialSporttery({
        repair,
        serverHeaders: false,
        timeoutMs: 12000,
      });
      signal.throwIfAborted();
      return result as unknown as OfficialBatch;
    } catch (directError) {
      signal.throwIfAborted();
      const message = `站点接口：${internalError instanceof Error ? internalError.message : "读取失败"}；手机计算器浏览器直连：${directError instanceof Error ? directError.message : "读取失败"}`;
      if (
        internalError instanceof OfficialAccessBlockedError ||
        (directError instanceof OfficialSportteryError &&
          directError.code === "OFFICIAL_ACCESS_BLOCKED")
      )
        throw new OfficialAccessBlockedError(message);
      if (
        internalError instanceof OfficialManifestUnavailableError ||
        (directError instanceof OfficialSportteryError &&
          directError.code === "OFFICIAL_MANIFEST_UNAVAILABLE")
      )
        throw new OfficialManifestUnavailableError(message);
      throw new Error(message);
    }
  }
}

export function useOfficialMatches() {
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataState, setDataState] = useState<DataState>("loading");
  const [dataError, setDataError] = useState("");
  const [dataErrorCode, setDataErrorCode] = useState("");
  const [dataMeta, setDataMeta] = useState(metadata({ matches: [] }));
  const [repairNotice, setRepairNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const allMatches = useMemo(
    () => liveMatches.slice().sort(compareMatchesByDateAndSequence),
    [liveMatches],
  );
  function beginRequest() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setDataLoading(true);
    setDataErrorCode("");
    setDataError("");
    return {
      controller,
      isCurrent: () =>
        mountedRef.current && !controller.signal.aborted && requestRef.current === controller,
    };
  }
  function accept(batch: OfficialBatch) {
    setLiveMatches(batch.matches);
    setDataMeta(metadata(batch));
    setDataState(batch.matches.length ? "success" : "empty");
    void writeBrowserData(SPORTTERY_CACHE_KEY, batch);
  }
  function reject(error: unknown, cached: OfficialBatch) {
    setDataError(error instanceof Error ? error.message : "官方数据读取失败");
    setDataErrorCode(errorCode(error));
    setLiveMatches(cached.matches);
    setDataMeta(metadata(cached));
    setDataState(cached.matches.length ? "stale" : "error");
  }
  async function refreshSporttery(fallback?: OfficialBatch) {
    const cached = fallback || { matches: liveMatches, ...dataMeta },
      request = beginRequest();
    setDataState("loading");
    try {
      const data = await loadOfficialBatch(false, request.controller.signal);
      if (request.isCurrent()) accept(data);
    } catch (error) {
      if (request.isCurrent()) reject(error, cached);
    } finally {
      if (request.isCurrent()) setDataLoading(false);
    }
  }
  async function repairMissingMatches(reportResult = true) {
    const before = liveMatches,
      request = beginRequest();
    if (reportResult) setRepairNotice("");
    try {
      const data = await loadOfficialBatch(true, request.controller.signal);
      if (!request.isCurrent()) return { ok: false as const, matches: before, error: "请求已取消" };
      const nextMatches = mergeOfficialMatches(before, data.matches);
      const count = (rows: Match[]) =>
        rows.reduce(
          (sum, match) => sum + Object.values(match.marketOdds || {}).filter(Boolean).length,
          0,
        );
      const added = nextMatches.length - before.length,
        completed = Math.max(0, count(nextMatches) - count(before));
      accept({ ...data, matches: nextMatches });
      if (reportResult)
        setRepairNotice(
          added || completed
            ? `补抓完成：新增 ${added} 场，补全 ${completed} 个玩法。`
            : "补抓完成，官方本次未返回新的场次或玩法；已有数据保持不变。",
        );
      return { ok: true as const, matches: nextMatches, added, completed };
    } catch (error) {
      const message = error instanceof Error ? error.message : "请稍后重试";
      if (request.isCurrent()) {
        reject(error, { matches: before, ...dataMeta });
        if (reportResult) setRepairNotice(`补抓失败：${message}；已有比赛未受影响。`);
      }
      return { ok: false as const, matches: before, error: message };
    } finally {
      if (request.isCurrent()) setDataLoading(false);
    }
  }
  useEffect(() => {
    mountedRef.current = true;
    void readBrowserData<OfficialBatch | null>(SPORTTERY_CACHE_KEY, null).then((parsed) => {
      if (!mountedRef.current) return;
      const cached = Array.isArray(parsed?.matches) ? parsed : undefined;
      if (cached?.matches.length) {
        setLiveMatches(cached.matches);
        setDataMeta(metadata(cached));
        setDataState("stale");
      }
      void refreshSporttery(cached);
    });
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);
  return {
    liveMatches,
    allMatches,
    dataLoading,
    dataState,
    dataError,
    dataErrorCode,
    dataMeta,
    repairNotice,
    setRepairNotice,
    refreshSporttery,
    repairMissingMatches,
  };
}
