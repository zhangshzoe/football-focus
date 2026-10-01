type ReadyScenario = {
  status: "ready"; ticketCount: number; fixtureCount: number; totalStake: number;
  expectedReturn: number; expectedProfit: number; profitProbability: number;
  anyWinningTicketProbability: number; lossProbability: number; zeroReturnProbability: number;
  worstFivePercentMeanProfit: number; maximumLossBound: number;
  netProfitQuantiles: { p05: number; p50: number; p95: number };
  method: string; sampleCount: number | null;
};
export type PortfolioScenario = { status: string } & { [K in keyof Omit<ReadyScenario, "status">]?: ReadyScenario[K] | null };
export type PortfolioScenarios = { current: PortfolioScenario; day?: PortfolioScenario | null };
const isReady = (value: PortfolioScenario): value is ReadyScenario => value.status === "ready" &&
  [value.ticketCount,value.fixtureCount,value.totalStake,value.expectedReturn,value.expectedProfit,value.profitProbability,value.anyWinningTicketProbability,value.lossProbability,value.zeroReturnProbability,value.worstFivePercentMeanProfit,value.maximumLossBound,value.netProfitQuantiles?.p05,value.netProfitQuantiles?.p50,value.netProfitQuantiles?.p95].every(item=>typeof item === "number" && Number.isFinite(item)) &&
  [value.ticketCount,value.fixtureCount].every(item=>typeof item === "number"&&Number.isSafeInteger(item)&&item>0) &&
  [value.totalStake,value.expectedReturn,value.maximumLossBound].every(item=>typeof item === "number"&&item>=0) &&
  [value.profitProbability,value.anyWinningTicketProbability,value.lossProbability,value.zeroReturnProbability].every(item=>typeof item === "number"&&item>=0&&item<=1) &&
  Number(value.netProfitQuantiles?.p05)<=Number(value.netProfitQuantiles?.p50) && Number(value.netProfitQuantiles?.p50)<=Number(value.netProfitQuantiles?.p95) &&
  (value.method==="exact-shared-fixture-states" || value.method==="seeded-score-sampling"&&typeof value.sampleCount==="number"&&Number.isSafeInteger(value.sampleCount)&&value.sampleCount>0);
const cash = (value: number) => `¥${value.toFixed(2)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function ScenarioDetails({ scenario, title }: { scenario: PortfolioScenario; title: string }) {
  if (!isReady(scenario)) return <section><h5>{title}</h5><p>{scenario.status === "empty" ? "本范围未选择可购买票，不计算中奖概率。" : "暂不能计算：缺少统一、及时的完整比分概率，或冻结票据身份、金额、情景方法及概率边界无法核验。不会混用旧概率或假设各票独立。"}</p></section>;
  return <section>
    <h5>{title} · {scenario.ticketCount} 张票 / {scenario.fixtureCount} 场比赛</h5>
    <dl className="portfolio-scenario-metrics">
      <div><dt>模拟总投入</dt><dd>{cash(scenario.totalStake)}</dd></div>
      <div><dt>模型期望返奖</dt><dd>{cash(scenario.expectedReturn)}</dd></div>
      <div><dt>模型期望净收益</dt><dd>{cash(scenario.expectedProfit)}</dd></div>
      <div><dt>至少一张票中奖</dt><dd>{percent(scenario.anyWinningTicketProbability)}</dd></div>
      <div><dt>整体净盈利概率</dt><dd>{percent(scenario.profitProbability)}</dd></div>
      <div><dt>整体亏损概率</dt><dd>{percent(scenario.lossProbability)}</dd></div>
      <div><dt>返奖为零概率</dt><dd>{percent(scenario.zeroReturnProbability)}</dd></div>
      <div><dt>最差5%情景平均净收益</dt><dd>{cash(scenario.worstFivePercentMeanProfit)}</dd></div>
    </dl>
    <p>净收益情景分位：5% {cash(scenario.netProfitQuantiles.p05)} / 中位 {cash(scenario.netProfitQuantiles.p50)} / 95% {cash(scenario.netProfitQuantiles.p95)}。最坏损失上界 {cash(scenario.maximumLossBound)}。</p>
    <p>同一场比赛的所有票共享一个比分事件；跨比赛仍按独立假设计算，未估计真实跨场相关性。{scenario.method === "seeded-score-sampling" ? `使用固定种子的 ${scenario.sampleCount} 次模型采样，情景极值不是理论边界。` : "使用压缩比分事件的精确枚举。"}未来取消、延期不在该概率情景中；这不是置信区间或盈利保证。</p>
  </section>;
}

export default function PortfolioScenarioSummary({ scenarios }: { scenarios?: PortfolioScenarios }) {
  return <details className="purchase-risk portfolio-scenario-summary">
    <summary>整组票风险 · 中奖不等于整体盈利（研究估计）</summary>
    {scenarios ? <><ScenarioDetails title="本批次" scenario={scenarios.current} />{scenarios.day && <ScenarioDetails title="全天含已核验早批次" scenario={scenarios.day} />}</> : <p>此历史版本未保存共享场次情景评估。不用今天的概率补算为当时预测；原票的投入与实际结算仍正常统计。</p>}
  </details>;
}
