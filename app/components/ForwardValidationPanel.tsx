"use client";

import { useEffect, useState } from "react";

type ModelMetrics = {
  sampleSize: number | null;
  brier: number | null;
  logLoss: number | null;
  ece: number | null;
};
type PairedInterval = { delta: number | null; lower: number | null; upper: number | null };
type ValidationGate = { key: string; label: string; passed: boolean; value?: string | number };
type ValidationView = {
  manifest: null | {
    manifestId: string;
    frozenAt: string;
    startAt: string;
    endAt: string;
    teamWeight: number;
    minimumPaired: number;
  };
  evaluation: {
    status: string;
    eligible: boolean;
    sampleSize: number | null;
    coverage: Record<string, number | null>;
    models: Record<string, ModelMetrics>;
    market: ModelMetrics | null;
    oddsInterval: PairedInterval;
    marketInterval: PairedInterval;
    gates: ValidationGate[];
    limitations: string[];
  };
  resultEventCount: number | null;
  unsyncedResultEvents: number | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const metric = (value: number | null) => (value === null ? "—" : value.toFixed(3));
const metrics = (value: unknown): ModelMetrics | null => {
  const row = record(value);
  return row
    ? {
        sampleSize: count(row.sampleSize),
        brier: finite(row.brier),
        logLoss: finite(row.logLoss),
        ece: finite(row.ece),
      }
    : null;
};
const interval = (value: unknown): PairedInterval => {
  const row = record(value);
  return { delta: finite(row?.delta), lower: finite(row?.lower), upper: finite(row?.upper) };
};
const localTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

export function decodeForwardValidation(payload: unknown): ValidationView {
  const root = record(payload),
    evaluation = record(root?.evaluation);
  if (!root || !("manifest" in root) || !evaluation || typeof evaluation.status !== "string")
    throw new Error("验证记录格式不完整，不能确认研究状态");
  const rawManifest = record(root.manifest);
  let manifest: ValidationView["manifest"] = null;
  if (root.manifest !== null) {
    const gates = record(rawManifest?.gates),
      teamWeight = finite(rawManifest?.teamWeight),
      minimumPaired = count(gates?.minimumPairedFixtures);
    if (
      !rawManifest ||
      typeof rawManifest.manifestId !== "string" ||
      !rawManifest.manifestId ||
      [rawManifest.frozenAt, rawManifest.startAt, rawManifest.endAt].some(
        (value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)),
      ) ||
      !(
        Date.parse(String(rawManifest.frozenAt)) < Date.parse(String(rawManifest.startAt)) &&
        Date.parse(String(rawManifest.startAt)) < Date.parse(String(rawManifest.endAt))
      ) ||
      teamWeight === null ||
      teamWeight <= 0 ||
      teamWeight >= 1 ||
      minimumPaired === null ||
      minimumPaired === 0
    )
      throw new Error("冻结版本元数据无效，验证资格暂停");
    manifest = {
      manifestId: rawManifest.manifestId,
      frozenAt: rawManifest.frozenAt as string,
      startAt: rawManifest.startAt as string,
      endAt: rawManifest.endAt as string,
      teamWeight,
      minimumPaired,
    };
  }
  const rawModels = record(evaluation.models) || {},
    coverage = record(evaluation.coverage) || {};
  const gates = Array.isArray(evaluation.gates)
    ? evaluation.gates.map((value) => {
        const gate = record(value);
        if (
          !gate ||
          typeof gate.key !== "string" ||
          typeof gate.label !== "string" ||
          typeof gate.passed !== "boolean"
        )
          throw new Error("验证门槛记录无效，不能显示通过状态");
        return {
          key: gate.key,
          label: gate.label,
          passed: gate.passed,
          value:
            typeof gate.value === "string" || typeof gate.value === "number"
              ? gate.value
              : undefined,
        };
      })
    : [];
  return {
    manifest,
    evaluation: {
      status: evaluation.status,
      eligible:
        evaluation.eligible === true &&
        manifest !== null &&
        evaluation.status === "evaluated" &&
        gates.length > 0 &&
        gates.every((gate) => gate.passed),
      sampleSize: count(evaluation.sampleSize),
      coverage: Object.fromEntries(
        Object.entries(coverage).map(([key, value]) => [key, count(value)]),
      ),
      models: Object.fromEntries(
        Object.entries(rawModels).flatMap(([key, value]) => {
          const row = metrics(value);
          return row ? [[key, row]] : [];
        }),
      ),
      market: metrics(evaluation.market),
      oddsInterval: interval(evaluation.oddsInterval),
      marketInterval: interval(evaluation.marketInterval),
      gates,
      limitations: Array.isArray(evaluation.limitations)
        ? evaluation.limitations.filter((value): value is string => typeof value === "string")
        : [],
    },
    resultEventCount: count(root.resultEventCount),
    unsyncedResultEvents: count(root.unsyncedResultEvents),
  };
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "尚未开始",
  collecting: "采集中",
  evaluated: "验证期结束",
  "implementation-changed": "实现变化，待新建版本",
  "results-awaiting-replay": "新赛果待重放，验证资格暂停",
  "result-integrity-failed": "赛果证据校验失败",
  "result-store-unavailable": "赛果存储暂不可用",
};

export default function ForwardValidationPanel() {
  const [state, setState] = useState<{ loading: boolean; data?: ValidationView; error?: string }>({
    loading: true,
  });
  useEffect(() => {
    let active = true;
    fetch("/api/research-validation", { cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok)
          throw new Error(
            typeof record(payload)?.resultStoreError === "string"
              ? String(record(payload)?.resultStoreError)
              : "未来验证读取失败",
          );
        const data = decodeForwardValidation(payload);
        if (active) setState({ loading: false, data });
      })
      .catch((error) => {
        if (active)
          setState({
            loading: false,
            error: error instanceof Error ? error.message : "未来验证记录暂不可用",
          });
      });
    return () => {
      active = false;
    };
  }, []);
  const data = state.data,
    evaluation = data?.evaluation,
    manifest = data?.manifest;
  const fusedLabel = manifest
    ? `赔率＋${(manifest.teamWeight * 100).toFixed(1)}%球队候选`
    : "赔率＋球队候选";
  const modelLabels: Record<string, string> = {
    "odds-baseline": "赔率比分模型基线",
    "team-only": "仅球队历史候选（无赔率输入）",
    "odds-plus-team": fusedLabel,
  };
  const modelRows = Object.entries(evaluation?.models || {}).map(([name, row]) => ({
    name,
    label: modelLabels[name] || name,
    row,
  }));
  if (evaluation?.market)
    modelRows.push({ name: "official", label: "冻结官方赔率去水基线", row: evaluation.market });

  return (
    <details className="experiment-detail-block">
      <summary>冻结版本未来验证 · 球队输入研究候选对照</summary>
      {state.loading ? (
        <p>正在读取验证记录…</p>
      ) : state.error ? (
        <p role="status">{state.error}</p>
      ) : !manifest ? (
        <p>尚未冻结未来验证版本，不用历史重放冒充赛前新预测。</p>
      ) : (
        <>
          <p>
            版本 {manifest.manifestId}；冻结于 {localTime(manifest.frozenAt)}。北京时间区间{" "}
            {localTime(manifest.startAt)} 至 {localTime(manifest.endAt)}；当前
            {STATUS_LABELS[evaluation?.status || ""] || "待验证"}
            。满足条件仍需人工审阅，不自动改变正式模型。
          </p>
          <p>
            当前只验证胜平负概率。同场配对去重 {evaluation?.sampleSize ?? "—"} 场；应采集{" "}
            {evaluation?.coverage.expected ?? "—"} / 有效取得 {evaluation?.coverage.captured ?? "—"}
            ；已到期赛果 {evaluation?.coverage.resolvedDueResults ?? "—"} /{" "}
            {evaluation?.coverage.dueResults ?? "—"}。
          </p>
          <p>
            去重场次数不等于统计独立样本数。
            {evaluation?.eligible ? "达到冻结检查门槛，待人工审阅" : "尚未达到全部冻结检查门槛"}
            ；冻结样本门槛 {manifest.minimumPaired} 场。研究评分不作为正式票或 AI
            数值权重的启用依据。
          </p>
          <div className="experiment-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>候选 / 基线</th>
                  <th>同场样本</th>
                  <th>Brier ↓</th>
                  <th>Log Loss ↓</th>
                  <th>ECE ↓</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map(({ name, label, row }) => (
                  <tr key={name}>
                    <td>{label}</td>
                    <td>{row.sampleSize ?? "—"}</td>
                    <td>{metric(row.brier)}</td>
                    <td>{metric(row.logLoss)}</td>
                    <td>{metric(row.ece)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {[
            { label: "融合−赔率比分模型", row: evaluation?.oddsInterval },
            { label: "融合−官方去水基线", row: evaluation?.marketInterval },
          ].map(({ label, row }) => (
            <p key={label}>
              {label} Brier差值 {metric(row?.delta ?? null)}；95%日期区块重采样区间{" "}
              {row?.lower != null && row.upper != null
                ? `[${metric(row.lower)}, ${metric(row.upper)}]`
                : "样本不足或区间不可用"}
              。负值表示融合损失更低。
            </p>
          ))}
          {(evaluation?.gates || []).map((gate) => (
            <p key={gate.key}>
              {gate.passed ? "本项通过" : evaluation?.status === "evaluated" ? "未通过" : "待验证"}{" "}
              {gate.label}
              {gate.value != null && ` · ${gate.value}`}
            </p>
          ))}
          {(evaluation?.limitations || []).map((text) => (
            <p key={text}>{text}</p>
          ))}
          <p>
            首次赛果观测 {data?.resultEventCount ?? "—"} 条；
            {data?.unsyncedResultEvents
              ? `${data.unsyncedResultEvents}条新赛果尚待离线冻结输入重放与索引同步。`
              : "仅展示已同步并核验的验证结果。"}
            半全场、伤停和xG均未作为此版本的概率增益。
          </p>
        </>
      )}
    </details>
  );
}
