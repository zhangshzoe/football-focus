import type { useOfficialMatches } from "../hooks/useOfficialMatches";
export default function OfficialSourceNotice({
  official,
  predictionPage = false,
}: {
  official: ReturnType<typeof useOfficialMatches>;
  predictionPage?: boolean;
}) {
  const {
    dataState,
    dataError,
    dataErrorCode,
    dataMeta,
    dataLoading,
    repairNotice,
    repairMissingMatches,
  } = official;
  const view = "matches";
  return (
    <>
      {predictionPage && (
        <div className="prediction-source-toolbar">
          <span>
            {dataLoading
              ? "正在读取官方比赛与赔率…"
              : dataState === "success"
                ? "官方比赛已同步"
                : dataState === "empty"
                  ? "官方清单暂无比赛"
                  : "官方数据暂不可用；研究与正式预测分开显示"}
          </span>
          <button
            type="button"
            disabled={dataLoading}
            onClick={() => void official.refreshSporttery()}
          >
            {dataLoading ? "正在刷新…" : "刷新比赛与赔率"}
          </button>
        </div>
      )}{" "}
      {view === "matches" &&
        dataState === "success" &&
        dataMeta.deliveryMode?.includes("mobile-calculator") && (
          <div className="data-fallback" role="status">
            逐玩法接口未完整返回，已改用
            <a href="https://m.sporttery.cn/mjc/jsq/zqspf/" target="_blank" rel="noreferrer">
              竞彩网手机计算器
            </a>
            使用的官方汇总接口。仅显示已校验玩法；赔率及开售状态仍须以投注时官方信息为准。
          </div>
        )}
      {dataState === "stale" && dataError && (
        <div className="data-fallback source-failure" role="alert">
          <p>
            {dataErrorCode === "OFFICIAL_ACCESS_BLOCKED" ? (
              <>
                官方数据源拒绝本站访问（HTTP 567）。刷新不能解除限制；请在
                <a href="https://www.sporttery.cn/" target="_blank" rel="noreferrer">
                  竞彩网核对实时信息
                </a>
                ，取得授权或放行后再试。
              </>
            ) : (
              <>
                官方实时数据暂不可用，当前展示过期缓存。
                {dataErrorCode === "OFFICIAL_MANIFEST_UNAVAILABLE" &&
                  "本次只收到销售控制配置，未提供赛事清单；当前比赛数量未知，不能据此认定停售或今日无比赛。"}
                取得并核验新数据前，赔率选择与新预测保持暂停。
              </>
            )}
          </p>
          <details>
            <summary>查看读取失败详情</summary>
            <p>{dataError.replace(/[。；]+$/u, "")}</p>
          </details>
        </div>
      )}
      <div className="match-repair-toolbar">
        <div>
          <b>比赛缺失或玩法未补全？</b>
          <span>补抓会重试官方五种玩法，并与当前列表合并，不会删除已经获取成功的比赛。</span>
        </div>
        <button type="button" onClick={() => void repairMissingMatches()} disabled={dataLoading}>
          {dataLoading ? "正在补抓…" : "补抓缺失场次"}
        </button>
        {repairNotice && (
          <em className={repairNotice.startsWith("补抓失败") ? "failed" : "success"}>
            {repairNotice}
          </em>
        )}
      </div>
    </>
  );
}
