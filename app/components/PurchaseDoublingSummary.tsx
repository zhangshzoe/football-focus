"use client";

import { useMemo } from "react";
import type { PurchaseItem } from "./TodayRecommendations";
import {
  PURCHASE_PLAN_DEFINITIONS,
  summarizePurchasePlanDefinitions,
} from "../purchase-plan-engine";
import { formatDoublingMoney, simulatePurchaseDoubling } from "../purchase-doubling.js";

function Money({ value, debit = false }: { value: bigint; debit?: boolean }) {
  const signed = debit ? -value : value;
  return (
    <b
      className={`purchase-money ${signed < BigInt(0) ? "purchase-money-negative" : signed > BigInt(0) ? "purchase-money-positive" : ""}`}
    >
      {formatDoublingMoney(signed, true)}
    </b>
  );
}

export default function PurchaseDoublingSummary({
  history,
  slot,
  loading,
}: {
  history: ReturnType<typeof summarizePurchasePlanDefinitions>;
  slot: "1700" | "2100";
  loading: boolean;
}) {
  const summaries = useMemo(
    () =>
      PURCHASE_PLAN_DEFINITIONS.map((definition) => ({
        definition,
        ...simulatePurchaseDoubling(history[definition.id]?.rows || []),
      })),
    [history],
  );
  return (
    <section className="purchase-doubling" aria-label="各投注方式倍投历史汇总" aria-busy={loading}>
      <h4>各投注方式历史汇总 · 倍投模拟</h4>
      <p>
        当前为 {slot === "1700" ? "17:00" : "21:00"}{" "}
        批次。每种方式独立从1倍开始：未中后翻倍，中奖后恢复1倍。1倍按每期原组合的全部投入计算，例如8元
        → 16元 → 32元；中奖后的下一期回到1倍。
      </p>
      <aside className="purchase-doubling-warning">
        倍投不提高中奖概率，也不保证收回此前亏损；连败会让所需资金快速增加。这里仅按最终赛果顺序模拟，不考虑资金上限和出票限额，不是当时可执行的实盘回测。
      </aside>
      <details className="purchase-doubling-rules">
        <summary>计算口径与待结算处理</summary>
        <ul>
          <li>
            仅使用原“各投注方式历史汇总”的正式记录，不增加模拟票，也不改动原快照；17点与21点互不混算。
          </li>
          <li>
            以真实快照批次为一期，按采集时间从早到晚。同一期同类多票共用倍数，全部结算后，任一中奖则归1倍，否则翻倍一次。
          </li>
          <li>
            缺赛果、金额不完整或无效待规则确认的期暂不计算、不推进倍数。补齐或订正后，后续模拟会重新计算；未留档日期不当作未中。
          </li>
          <li>
            中奖即重置，不要求本轮回本。全票无效按本金退款，不计中奖或连败；部分无效按该腿每个选项赔率1.00重算。
          </li>
          <li>
            1倍返还先四舍五入到分，再按倍数计算；金额汇总含已确认退款。未记录赛果当时的可知时间，同日多批可能有赛程重叠，不据此推断可实现收益。
          </li>
        </ul>
      </details>
      {loading ? (
        <p role="status">正在读取正式快照与赛果，稍后显示倍投汇总…</p>
      ) : (
        <div className="purchase-history purchase-doubling-history">
          {summaries.map((summary) => (
            <details key={summary.definition.id} className="purchase-history-group">
              <summary>
                <strong>
                  {summary.definition.title}
                  <small>{summary.definition.rule}</small>
                </strong>
                <span>
                  中奖 / 已结算
                  <b>
                    {summary.won} / {summary.settled} ·{" "}
                    {summary.settled ? `${summary.rate.toFixed(1)}%` : "待积累"}
                  </b>
                </span>
                <span>
                  模拟投入 / 返还
                  <span>
                    <Money value={summary.stake} debit /> / <Money value={summary.returned} />
                  </span>
                </span>
                <span>
                  模拟净收益
                  <Money value={summary.net} />
                </span>
                <span>
                  回放下一期倍数<b>{summary.nextMultiplier.toString()}倍</b>
                </span>
              </summary>
              <div className="purchase-doubling-metrics">
                <span>
                  历史最高倍数 <b>{summary.peakMultiplier.toString()}倍</b>
                </span>
                <span>
                  单期最高投入 <Money value={summary.peakStake} debit />
                </span>
                <span>
                  最长连续未中 <b>{summary.maxLosingStreak}期</b>
                </span>
                <span>
                  暂未计入 <b>{summary.pending}票</b> · 整票退款 <b>{summary.refunded}票</b>
                </span>
              </div>
              <div
                className="purchase-history-scroll"
                tabIndex={0}
                aria-label={`${summary.definition.title}倍投明细，可左右滑动`}
              >
                <table>
                  <thead>
                    <tr>
                      <th>日期 / 批次</th>
                      <th>投注内容</th>
                      <th>结果</th>
                      <th>倍数</th>
                      <th>模拟投入</th>
                      <th>模拟返还</th>
                      <th>本票净收益</th>
                      <th>累计净收益</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.length ? (
                      summary.rows.map((row, index) => (
                        <tr
                          key={`${row.snapshotId}-${row.plan.originPlanId || row.plan.id}-${index}`}
                        >
                          <td>
                            {row.date}
                            <small>
                              {Number.isFinite(Date.parse(row.generatedAt))
                                ? new Date(row.generatedAt).toLocaleTimeString("zh-CN", {
                                    timeZone: "Asia/Shanghai",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "时间待补"}
                            </small>
                          </td>
                          <td>
                            {row.plan.items.map((item: PurchaseItem, itemIndex: number) => (
                              <div className="purchase-history-item" key={itemIndex}>
                                <b>{item.matchId}</b> {item.home} vs {item.away} · {item.marketName}{" "}
                                {(item.picks?.length ? item.picks : [item])
                                  .map((pick) => pick.pick)
                                  .join(" / ")}
                                <span className="purchase-history-outcome">
                                  最终赛果 {item.finalScore || ""} {item.actual || "待公布"}
                                </span>
                              </div>
                            ))}
                            <small>
                              本组合1倍投入{" "}
                              {Number.isFinite(row.plan.stake)
                                ? `¥${row.plan.stake.toFixed(2)}`
                                : "金额待补"}
                            </small>
                          </td>
                          <td>
                            {row.outcome === "won"
                              ? "模拟中奖"
                              : row.outcome === "lost"
                                ? "模拟未中"
                                : row.outcome === "refund"
                                  ? "整票退款"
                                  : "本期待结算 / 核验"}
                          </td>
                          <td>{row.multiplier === null ? "—" : `${row.multiplier}倍`}</td>
                          <td>{row.stake === null ? "—" : <Money value={row.stake} debit />}</td>
                          <td>{row.returned === null ? "—" : <Money value={row.returned} />}</td>
                          <td>{row.net === null ? "—" : <Money value={row.net} />}</td>
                          <td>
                            <Money value={row.cumulativeNet} />
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={8}>该投注方式暂无正式历史记录</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
