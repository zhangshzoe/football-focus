"use client";

import { useEffect, useState } from "react";
import { isTotalGoalsValidationReport } from "../total-goals-validation-contract.js";

type Interval = { delta: number | null; lower: number | null; upper: number | null; sampleSize: number; clusters: number };
type Metrics = { sampleSize: number; top2: number | null; brier: number | null; logLoss: number | null; rps: number | null };
type Window = { sampleSize: number; salesDays: number; startDate: string | null; endDate: string | null;
  model: Metrics; market: Metrics; differences: Record<"brier" | "logLoss" | "rps" | "topTwoMiss", Interval> };
type Cash = { tickets: number; won: number; hitRate: number | null; stake: number | null; returned: number | null; netProfit: number | null };
type Ticket = { snapshotId: string; savedTicketId: string; salesDate: string; capturedAt: string; passName: string;
  fixtures: Array<{ home: string; away: string; fullScore: string }>;
  model: { selections: string[][]; stake: number; returned: number; netProfit: number };
  market: { selections: string[][]; stake: number; returned: number; netProfit: number } };
type Report = { schemaVersion: number; validationVersion: string; pipelineVersion: string; promotionEligible: false;
  evaluatedAt: string; attemptedRecords: number; archivedFixtures: number; eligibleBeforeResults: number; comparableMatches: number;
  latestSourceStatus: string; latestSourceReason: string | null; invalidResultEvents: number; exclusions: Record<string, number>;
  cohorts: Array<{ id: string; windows: Record<"all" | "recent50" | "recent100", Window> }>;
  tickets: { sampleSize: number; overlappingTicketPairs: number; exclusions: Record<string, number>; rows: Ticket[];
    groups: Array<{ id: string; cohortId: string; passName: string; model: Cash; market: Cash }> } };

const number = (n: number | null) => n === null ? "—" : n.toFixed(3);
const percent = (n: number | null) => n === null ? "—" : `${(n * 100).toFixed(1)}%`;
const money = (n: number | null) => n === null ? "—" : `¥${n.toFixed(2)}`;
const when = (n: string) => new Date(n).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const reasons: Record<string, string> = {
  "incompatible-raw-version": "不是当前流水线原始输入", "missing-verified-completion": "缺少真实落盘完成凭据",
  "invalid-completion-proof": "完成凭据不一致", "delayed-or-recovered": "延迟或恢复记录", "unverified-fixture": "官方身份未核验",
  "raw-identity-mismatch": "原始输入身份不一致", "unverified-or-stale-official-pools": "官方玩法来源缺失或过期",
  "unverified-total-market": "总进球赔率或销售资格未核验", "missing-frozen-parameters": "缺少冻结参数或版本",
  "incomplete-stored-total-distribution": "缺少完整八项保存概率", "stored-replay-mismatch": "保存概率与重放不一致",
  "after-fixed-decision": "完成晚于固定决策时点", "missing-or-invalid-real-times": "实际时间缺失或无效",
  "superseded-before-target": "同场目标前旧记录去重", "pending-verified-result": "尚无已核验公布赛果",
  "conflicting-verified-results": "已核验赛果互相冲突", "result-fixture-mismatch": "赛果身份不一致",
  "saved-ticket-selection-or-cost-mismatch": "原票选号、赔率或投入不符", "duplicate-saved-ticket": "同批次重复票去重",
  "missing-or-conflicting-ticket-input": "原票输入缺失或冲突", "mixed-or-repeated-ticket-input": "整票版本混用或重复场次",
  "saved-ticket-provenance-mismatch": "方案未绑定到真实保存原票",
  "conflicting-raw-snapshot": "同一快照内容冲突", "non-immutable-source": "不是不可变原始快照",
};
const exclusionList = (counts: Record<string, number>) => Object.entries(counts).map(([reason, count]) => <li key={reason}>{reasons[reason] || reason}：{count}</li>);
function Difference({ value }: { value: Interval }) {
  return <span>{number(value.delta)}{value.delta !== null && (value.lower === null
    ? `（${value.sampleSize}场 / ${value.clusters}日，样本不足不报区间）`
    : ` [${number(value.lower)}, ${number(value.upper)}]（95%日期块配对区间）`)}</span>;
}

export default function TotalGoalsValidationPanel() {
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState("");
  const [window, setWindow] = useState<"all" | "recent50" | "recent100">("recent100"), [cohort, setCohort] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/total-goals-validation", { cache: "no-store", signal: abort.signal }).then(async (response) => {
      const data = await response.json(), value = data.report;
      if (!isTotalGoalsValidationReport(value)) throw new Error("专项验证索引尚未生成或格式不可核验");
      setReport(value); setCohort(value.cohorts.at(-1)?.id || "");
      if (!response.ok || data.indexReadStatus === "cloud-unavailable") setError(`云端最新读取未完成，以下仅显示已保存的${data.storageOrigin === "cloud-background-index" ? "云端" : "离线"}对照；不代表当前覆盖完整。`);
      else if (data.indexReadStatus === "cloud-report-missing") setError("尚未取得云端专项索引，以下为已保存的离线对照，不代表最新比赛已覆盖。");
      else if (data.currentSourceStatus === "failed") setError("最新官方采集失败，现有诊断不代表新增比赛已覆盖。");
    }).catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); });
    return () => abort.abort();
  }, []);
  const current = report?.cohorts.find((r) => r.id === cohort)?.windows[window];
  return <details className="experiment-detail-block total-goals-validation" open>
    <summary>总进球八类专项对照 · 单场双选 / 双选2串1、3串1</summary>
    {error && <p role="status" className="ttg-validation-warning">{error}</p>}
    {!report && !error && <p role="status">正在读取已计算的对照索引…</p>}
    {report && <>
      <p>固定决策时点 · 保存的原始输入重放 · 同场官方八项赔率去水基准。只使用已核验公布赛果（包括二级体彩发布源），不使用手动赛果或当前赔率替补。</p>
      <div className="ttg-validation-counts"><span>归档比赛 <strong>{report.archivedFixtures}</strong></span><span>原始记录 <strong>{report.attemptedRecords}</strong></span><span>同场可比 <strong>{report.comparableMatches}</strong></span></div>
      <p>范围仅为已归档比赛，不能推断全量覆盖。各参数 / 校准版本分别统计，不混作同一模型的样本。</p>
      {report.latestSourceStatus === "failed" && <p className="ttg-validation-warning">最新数据源读取失败：{report.latestSourceReason || "赛事覆盖范围未知"}</p>}
      {!report.cohorts.length ? <p className="ttg-validation-empty">暂无合格的当前版本对照样本。命中率与误差均不可评价，不是0%。旧复盘仍保持原样。</p> : <>
        <div className="ttg-validation-controls"><label>冻结版本<select value={cohort} onChange={(e) => setCohort(e.target.value)}>{report.cohorts.map((r, i) => <option key={r.id} value={r.id}>版本组 {i + 1} · 参数 {r.id.split("|").at(-1)?.slice(0, 10)}</option>)}</select></label>
          <div className="experiment-window-tabs">{(["recent50", "recent100", "all"] as const).map((w) => <button key={w} className={w === window ? "active" : ""} onClick={() => setWindow(w)} aria-pressed={w === window}>{w === "all" ? "全部" : w === "recent50" ? "最近50场" : "最近100场"}</button>)}</div></div>
        {current && <><p>{current.startDate} 至 {current.endDate} · 两方同为 {current.sampleSize} 场 / {current.salesDays} 个销售日。</p>
          <div className="ttg-validation-metrics">{(["model", "market"] as const).map((field) => <article key={field}><h4>{field === "model" ? "重放模型" : "官方赔率基准"}</h4><strong>{percent(current[field].top2)}</strong><p>单场Top2覆盖率</p><dl><div><dt>Brier ↓</dt><dd>{number(current[field].brier)}</dd></div><div><dt>Log Loss ↓</dt><dd>{number(current[field].logLoss)}</dd></div><div><dt>RPS ↓</dt><dd>{number(current[field].rps)}</dd></div></dl></article>)}</div>
          <p>模型−市场的配对差（负数较好；区间包含0不能声称领先）：</p><ul className="ttg-validation-list">{(["brier", "logLoss", "rps", "topTwoMiss"] as const).map((k) => <li key={k}>{{ brier: "Brier", logLoss: "Log Loss", rps: "RPS", topTwoMiss: "Top2未命中率" }[k]}：<Difference value={current.differences[k]}/></li>)}</ul>
        </>}
      </>}
      <details><summary>原始记录排除明细</summary><ul className="ttg-validation-list">{exclusionList(report.exclusions)}</ul><p>无效赛果事件 {report.invalidResultEvents} 条；排除数按原始记录，不等于独立比赛数。先固定时点选记录，后看赛果，不用中奖结果挑样本。</p></details>
      <details><summary>已保存整票的同场反事实收益 · {report.tickets.sampleSize} 票</summary>
        <p>只比较真实已保存且选号、SP、投入与重放一致的双选票。市场方不重新选场，只在原票场次上选择市场Top2。2串1为4注8元；3串1为8注16元。</p>
        {!report.tickets.sampleSize && <p className="ttg-validation-empty">暂无满足输入与赛果证明的整票，投入 / 返还 / 净利暂不可汇总。</p>}
        {report.tickets.groups.map((g) => <article className="ttg-validation-ticket" key={g.id}><h4>{g.passName} · 参数 {g.cohortId.split("|").at(-1)?.slice(0, 10)}</h4>{(["model", "market"] as const).map((field) => <p key={field}>{field === "model" ? "模型原票" : "同场市场票"}：中奖 {g[field].won}/{g[field].tickets} · {percent(g[field].hitRate)} · 投入 {money(g[field].stake)} / 返还 {money(g[field].returned)} / 净利 <span className={Number(g[field].netProfit) > 0 ? "ttg-cash-positive" : Number(g[field].netProfit) < 0 ? "ttg-cash-negative" : ""}>{money(g[field].netProfit)}</span></p>)}</article>)}
        <p>共享比赛的票对 {report.tickets.overlappingTicketPairs} 对；不能视作独立样本。预期返奖按整张票计算，依赖跨场独立假设，不是保证回报。</p>
        <ul className="ttg-validation-list">{exclusionList(report.tickets.exclusions)}</ul>
        {report.tickets.rows.map((ticket, i) => <details className="ttg-validation-ticket" key={`${ticket.snapshotId}|${ticket.savedTicketId}`}><summary>{i + 1}. {ticket.salesDate} · {ticket.passName} · {when(ticket.capturedAt)}</summary>{ticket.fixtures.map((fixture, n) => <p key={n}>{fixture.home} vs {fixture.away} · 赛果 {fixture.fullScore}<br/>模型：{ticket.model.selections[n].join(" / ")}；市场：{ticket.market.selections[n].join(" / ")}</p>)}<p>模型：{money(ticket.model.stake)} / {money(ticket.model.returned)} / {money(ticket.model.netProfit)}；市场：{money(ticket.market.stake)} / {money(ticket.market.returned)} / {money(ticket.market.netProfit)}</p></details>)}
      </details>
      <p className="ttg-validation-meta">报告流水线：{report.pipelineVersion}。索引计算于 {when(report.evaluatedAt)}。完整类别为0至6球、7+球；本面板仅作专项诊断，不继承胜平负实验的晋级资格，也不自动调整权重。</p>
    </>}
  </details>;
}
