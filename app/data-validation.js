/** Read-only diagnostics. No model outputs, archives or browser stores are mutated. */
export const VALIDATION_READ_MAX_AGE_MS = 5 * 60 * 1000;
export const VALIDATION_EVIDENCE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const array = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? '').trim();
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const check = (id, label, status, detail) => ({ id, label, status, detail });
const identity = row => text(row?.officialMatchId || row?.matchId) && /^\d{4}-\d{2}-\d{2}$/.test(text(row?.salesDate)) ? `${row.salesDate}|${row.officialMatchId || row.matchId}` : '';

/** Explicit offsets are required, except documented official local timestamps (+08:00). */
export function parseValidationTime(value, officialLocal = false) {
  const raw = text(value);
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw);
  if (!zoned && !(officialLocal && local)) return null;
  const at = Date.parse(zoned ? raw : `${raw.replace(' ', 'T')}+08:00`);
  return Number.isFinite(at) ? at : null;
}
function freshness(value, now, officialLocal = false) {
  const at = parseValidationTime(value, officialLocal);
  if (at === null) return { status: 'unknown', detail: '缺少可解释时间（需时区；官方本地时间按北京时间）' };
  if (at > now + 60000) return { status: 'fail', detail: '时间晚于核验时刻超过 1 分钟，检查时钟/时区' };
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return { status: now - at <= VALIDATION_READ_MAX_AGE_MS ? 'pass' : 'warn', detail: `${minutes} 分钟前读取；5 分钟为本页读取新鲜度阈值，不代表报价更新` };
}
const oddsValid = (value, length) => Array.isArray(value) && value.length === length && value.every(odd => typeof odd === 'number' && Number.isFinite(odd) && odd > 1);
const markets = { '胜平负': 3, '让球胜平负': 3, '比分': 31, '总进球数': 8, '半全场': 9 };
const worst = checks => checks.some(row => row.status === 'fail') ? 'fail' : checks.some(row => row.status === 'warn') ? 'warn' : checks.some(row => row.status === 'unknown') ? 'unknown' : 'pass';
const counts = rows => { const map = new Map(); rows.forEach(row => { const key = identity(row); if (key) map.set(key, (map.get(key) || 0) + 1); }); return map; };

/** Inputs are raw API responses or null on failure; now is an ISO timestamp or epoch ms. */
export function buildValidationReport({ official = null, predictions = null, audit = null, now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' ? now : parseValidationTime(now);
  if (!Number.isFinite(nowMs)) throw new Error('核验时间必须为有效的带时区时间');
  const matches = array(official?.matches), reports = array(predictions?.reports);
  const officialOK = !!official && Array.isArray(official.matches) && !official.error;
  const requiredPools = ['HAD', 'HHAD', 'CRS', 'TTG', 'HAFU'];
  const poolsComplete = officialOK && Object.keys(official.poolStatus || {}).length === requiredPools.length && requiredPools.every(pool => official.poolStatus?.[pool]?.status === 'success');
  const officialCountKnown = officialOK && (matches.length > 0 || poolsComplete);
  const predictionsOK = !!predictions && Array.isArray(predictions.reports) && !predictions.error;
  const officialCounts = counts(matches), reportCounts = counts(reports);
  const seen = new Set();
  const checks = [
    check('official-source', '官方赛事读取', officialCountKnown ? matches.length ? 'pass' : 'warn' : 'unknown', officialOK ? matches.length ? `本次返回 ${matches.length} 场；全量范围仍需结合五玩法来源状态` : poolsComplete ? '五个指定玩法均成功，当前返回 0 场' : '返回空列表，但五个指定玩法未全部成功，无法确认当前是否真正无比赛' : '官方来源未成功读取，无法验证当前比赛'),
    check('prediction-source', '外围盘口模型读取', predictionsOK ? reports.length ? 'pass' : 'warn' : 'unknown', predictionsOK ? `返回 ${reports.length} 条；未覆盖比赛不会填入演示预测` : '未取得正式预测响应，不用历史或研究模式替代'),
  ];
  if (officialOK) {
    const age = freshness(official.fetchedAt, nowMs);
    checks.push(check('official-read-time', '官方读取时间', age.status, age.detail));
    const pools = Object.entries(official.poolStatus || {});
    checks.push(check('official-pools', '五玩法来源状态', poolsComplete ? 'pass' : pools.some(([, value]) => value?.status === 'failed') ? 'fail' : 'unknown', pools.length ? pools.map(([key, value]) => `${key}: ${value?.status || '未知'}`).join('；') : '未返回各玩法来源状态'));
    checks.push(check('official-upstream', '官方全局更新时间', 'unknown', official.upstreamUpdatedAt ? `${official.upstreamUpdatedAt}（各玩法最新值；不能代表每场、每玩法的报价更新时间）` : '上游未提供；读取成功不能证明报价刚刚更新'));
  }
  if (predictionsOK && predictions.mode === 'research-only') checks.push(check('research-only', '正式预测范围', 'fail', '收到外围研究模式，不视为官方比赛预测'));
  if (array(predictions?.sourceFailures).length) checks.push(check('external-failures', '外围来源部分失败', 'fail', predictions.sourceFailures.map(row => `${text(row.issue)}: ${text(row.reason)}`).join('；')));
  const fixtures = matches.map((match, index) => {
    const key = identity(match);
    const candidates = reports.filter(row => key && identity(row) === key);
    const row = candidates.length === 1 ? candidates[0] : null;
    const kickoff = parseValidationTime(match.kickoffAt);
    const identityConflict = row && (text(row.home) !== text(match.home) || text(row.away) !== text(match.away) || parseValidationTime(row.kickoffAt) !== kickoff || ['homeTeamId', 'awayTeamId'].some(field => text(row[field]) && text(match[field]) && text(row[field]) !== text(match[field])));
    const validIdentity = !!key && !!text(match.home) && !!text(match.away) && kickoff !== null && officialCounts.get(key) === 1;
    const joined = validIdentity && row && !identityConflict && row.officialMappingStatus === 'verified' && !row.researchOnly && !row.isMock && predictions?.mode !== 'research-only';
    if (joined) seen.add(key);
    const itemChecks = [
      check('identity', '官方赛事身份', validIdentity ? 'pass' : 'fail', validIdentity ? `${key}；主客队及开赛时间齐全` : '官方 ID、销售日、主客队、时区开赛时间缺失或身份重复'),
      check('kickoff', '赛前范围', kickoff === null ? 'unknown' : kickoff > nowMs ? 'pass' : 'warn', kickoff === null ? '开赛时间无法解释' : kickoff > nowMs ? '尚未开赛；不代表已确认首发' : '已到开赛时间，不作为当前赛前验证样本'),
      check('mapping', '官方 / 外围身份对应', !predictionsOK ? 'unknown' : joined ? 'pass' : candidates.length > 1 || identityConflict || row ? 'fail' : 'warn', !predictionsOK ? '预测来源未读取' : joined ? '销售日 + 官方 ID 唯一匹配，主客队、开赛时间与 verified 标记一致' : candidates.length > 1 ? '同一官方身份存在多条预测，拒绝自动选择' : identityConflict ? '主客队、球队 ID 或开赛时间冲突，拒绝关联' : row ? '映射未验证、研究模式或模拟记录，拒绝关联' : '无匹配预测；不以周几场次编号或名称模糊拼接'),
    ];
    const officialMarkets = Object.entries(markets).map(([label, size]) => ({ label, available: oddsValid(match.marketOdds?.[label] ?? (label === '胜平负' ? match.odds : null), size), state: text(match.marketStatus?.[label]) || 'unknown' }));
    itemChecks.push(check('official-odds', '官方五玩法赔率完整性', officialMarkets.every(item => item.available) ? 'pass' : 'warn', officialMarkets.map(item => `${item.label}：${item.available ? '完整有效' : item.state === 'failed' ? '来源失败' : '未开售/缺失/无效'}`).join('；')));
    const quote = parseValidationTime(match.updatedAt, true);
    itemChecks.push(check('official-quote', '本场官方更新标记', quote === null ? 'unknown' : quote > nowMs + 60000 ? 'fail' : 'warn', quote === null ? '未提供可解释更新标记' : `${match.updatedAt}；本场各玩法最新值，并非全部玩法逐笔更新时间`));
    const companies = joined ? array(row.modelInput?.companies || row.companies) : [];
    const validCompanies = companies.filter(company => oddsValid([company.win, company.draw, company.lose], 3));
    const uniqueCompanies = new Set(companies.map(company => text(company.companyId)).filter(Boolean));
    itemChecks.push(check('external-odds', '外围公司赔率', !joined ? 'unknown' : validCompanies.length >= 2 && uniqueCompanies.size === companies.length ? 'pass' : 'warn', joined ? `${validCompanies.length}/${companies.length} 家胜平负完整；与官方赔率分开，非体彩可购买赔率` : '没有通过身份校验的外围盘口'));
    if (joined) {
      const ages = companies.map(company => freshness(company.fetchedAt, nowMs));
      itemChecks.push(check('external-read-time', '外围逐公司读取新鲜度', !ages.length ? 'unknown' : worst(ages), ages.length ? ages.map((age, i) => `${companies[i].company || companies[i].companyId}: ${age.detail}`).join('；') : '无逐公司读取时间'));
      itemChecks.push(check('external-quote-time', '外围实际报价更新时间', companies.length && companies.every(company => parseValidationTime(company.upstreamUpdatedAt) !== null) ? 'warn' : 'unknown', 'fetchedAt 是读取时间；仅有它不能验证实际报价变化时间或同步盘口'));
    }
    const evidence = joined ? array(row.intelligenceEvidence?.records) : [];
    const usableEvidence = evidence.filter(record => { const at = parseValidationTime(record.observedAt); return at !== null && at <= nowMs && nowMs - at <= VALIDATION_EVIDENCE_MAX_AGE_MS && /^https?:\/\//.test(text(record.sourceUrl)) && text(record.type); });
    for (const [id, label, pattern] of [['lineup', '首发证据', /lineup|首发/i], ['injury', '伤停证据', /injur|suspension|伤停|伤病/i], ['weather', '比赛天气证据', /weather|天气/i]]) {
      const found = usableEvidence.filter(record => pattern.test(record.type));
      itemChecks.push(check(id, label, found.length ? 'warn' : 'unknown', found.length ? `${found.length} 条带来源及 48 小时内观察时间的记录；仅验证元数据，不保证内容准确/正式首发` : '未取得该类有效带来源证据；不从赔率、AI 文本或页面天气装饰推断'));
    }
    const weight = joined ? number(row.appliedIntelligenceWeight) : null;
    itemChecks.push(check('intelligence-weight', '实际情报数值权重', weight === null ? 'unknown' : weight === 0 ? 'pass' : 'warn', weight === null ? '当前响应未声明 appliedIntelligenceWeight，不将缺失字段当作已验证的 0' : `${weight}；非零权重也不构成独立增益证据`));
    const provenance = joined && ['predictionId', 'inputSnapshotId', 'baseModelVersion', 'calibrationVersion'].every(field => text(row[field])) && parseValidationTime(row.predictionGeneratedAt) !== null;
    itemChecks.push(check('provenance', '预测版本可追溯', !joined ? 'unknown' : provenance ? 'pass' : 'warn', provenance ? `${row.predictionId} / ${row.inputSnapshotId} / ${row.baseModelVersion} / ${row.calibrationVersion}；仅响应版本，不证明已持久化快照` : '缺少已关联预测或完整版本 / 输入 / 生成时间'));
    if (joined) {
      const generatedAt = parseValidationTime(row.predictionGeneratedAt);
      const readAt = parseValidationTime(row.sourceFetchedAt);
      const timingInvalid = generatedAt !== null && (generatedAt > nowMs + 60000 || generatedAt >= kickoff || (readAt !== null && readAt > generatedAt + 60000));
      itemChecks.push(check('prediction-timing', '预测时间顺序', generatedAt === null || readAt === null ? 'unknown' : timingInvalid ? 'fail' : 'pass', generatedAt === null || readAt === null ? '缺少预测生成或来源读取时间，无法验证时间顺序' : timingInvalid ? '生成时间在未来 / 开赛后，或来源读取晚于生成，不能算作合格赛前证据' : '来源读取不晚于生成，生成早于开赛；不等于已纳入严格历史评估'));
      const p = [row.probabilities?.home, row.probabilities?.draw, row.probabilities?.away];
      const valid = p.every(value => number(value) !== null && value >= 0 && value <= 100) && Math.abs(p.reduce((sum, value) => sum + value, 0) - 100) <= 0.2;
      itemChecks.push(check('probabilities', '胜平负概率格式', valid ? 'pass' : 'fail', valid ? '三项有效且合计约 100%；格式通过不代表预测准确' : '概率缺失、越界或合计不为 100%'));
    }
    return { key: `${key || 'missing'}:${index}`, id: text(match.id), home: text(match.home), away: text(match.away), kickoffAt: text(match.kickoffAt), checks: itemChecks, status: worst(itemChecks), officialMarkets, externalCompanies: joined ? validCompanies.length : null, predictionId: joined ? text(row.predictionId) : '', baseModelVersion: joined ? text(row.baseModelVersion) : '' };
  });
  const unmatchedPredictions = predictionsOK && officialCountKnown ? reports.filter(row => !seen.has(identity(row)) || reportCounts.get(identity(row)) !== 1).length : null;
  if (unmatchedPredictions) checks.push(check('unmatched-predictions', '未关联预测', 'fail', `${unmatchedPredictions} 条没有唯一且一致的官方身份，不进入本页有效覆盖数`));
  const historyData = audit?.audit;
  const history = historyData ? {
    generatedAt: text(historyData.generatedAt),
    strictDecisionRows: number(historyData.inventory?.strictDecisionRows), fallbackDecisionRows: number(historyData.inventory?.fallbackDecisionRows), uniqueSettledMatches: number(historyData.inventory?.uniqueSettledMatches),
    metrics: [['hadTop1', '胜平负首选'], ['scoreTop1', '比分首选'], ['totalTop1', '总进球首选'], ['halfFullTop1', '半全场首选']].map(([id, label]) => ({ label, eligible: number(historyData.overall?.[id]?.eligible), rate: number(historyData.overall?.[id]?.rate) })),
    modelBrier: number(historyData.overall?.modelBrier), marketBrier: number(historyData.overall?.marketBrier), marketComparable: number(historyData.overall?.marketComparable),
    calibration: { profileId: text(audit.calibration?.profileId), forecastSampleSize: number(audit.calibration?.forecastSampleSize), trainingSampleSize: number(audit.calibration?.trainingSampleSize), calibrationSampleSize: number(audit.calibration?.calibrationSampleSize) },
  } : null;
  checks.push(check('historical-audit', '打包历史审计', history ? 'warn' : 'unknown', history ? `文件生成于 ${history.generatedAt || '未知'}；不是今天重算，也不是新页面的前向验证结果。不同指标分母可能不同，不据此宣称模型胜过市场。` : '未取得历史审计；不展示虚构命中率'));
  const all = [...checks, ...fixtures.flatMap(row => row.checks)];
  return { checkedAt: new Date(nowMs).toISOString(), checks, fixtures, summary: { officialMatches: officialCountKnown ? matches.length : null, matchedPredictions: officialCountKnown && predictionsOK ? seen.size : null, unmatchedPredictions, failedChecks: all.filter(row => row.status === 'fail').length, warnings: all.filter(row => row.status === 'warn').length }, history };
}
