export default function PageLoadStatus({loadedAt, loading = false}: {loadedAt: string; loading?: boolean}) {
  const validTime = loadedAt && Number.isFinite(Date.parse(loadedAt));
  return (
    <div className="page-load-status" role="status" style={{display:"flex", flexWrap:"wrap", gap:"6px 16px", margin:"12px 0", fontSize:13, lineHeight:1.7, color:"var(--ui-muted, #526574)"}}>
      <span>
        {loading && "正在加载数据… "}
        {validTime ? <>本次加载：<time dateTime={loadedAt}>{new Date(loadedAt).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false})}</time>（北京时间）</> : !loading && "尚未成功加载"}
      </span>
      <span>页面停留期间不自动更新，刷新页面获取最新数据。</span>
    </div>
  );
}
