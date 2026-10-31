/** Read-only orchestration: no cached or synthetic fallback.
 * @param {typeof fetch} fetcher
 * @param {{signal?: AbortSignal, forceRefresh?: boolean}} options
 */
export async function loadValidationSources(fetcher, { signal, forceRefresh = false } = {}) {
  const errors = {};
  async function read(name, path, options = {}) {
    try {
      const response = await fetcher(path, { cache: 'no-store', signal, ...options });
      const data = await response.json();
      if (!response.ok || data?.error) throw new Error(data?.error || 'HTTP ' + response.status);
      if (name === 'official' && !Array.isArray(data.matches)) throw new Error('官方响应缺少赛事数组');
      if (name === 'predictions' && !Array.isArray(data.reports)) throw new Error('预测响应缺少报告数组');
      if (name === 'audit' && !data.audit) throw new Error('响应缺少历史审计');
      return data;
    } catch (error) {
      // Timeout retains independent successes; unmount is suppressed by the caller generation guard.
      errors[name] = error instanceof Error ? error.message : '读取失败';
      return null;
    }
  }
  const [official, audit] = await Promise.all([read('official', '/api/sporttery'), read('audit', '/api/model-audit')]);
  let predictions = null;
  if (official?.matches.length && !signal?.aborted) predictions = await read('predictions', '/api/predictions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceRefresh, matches: official.matches.slice(0, 120).map(match => ({
      ...match, officialMatchId: match.officialMatchId || match.matchId,
      sourceFetchedAt: official.fetchedAt, hhadOdds: match.marketOdds?.['让球胜平负'] || [], isMock: false,
    })) }),
  });
  return { official, predictions, audit, errors };
}
