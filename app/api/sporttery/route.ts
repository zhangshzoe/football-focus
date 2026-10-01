import { NextResponse } from "next/server";
import { fetchOfficialSporttery, OfficialSportteryError } from "../../sporttery-official";

export async function GET(request: Request) {
  try {
    const repair = new URL(request.url).searchParams.get("repairMissing") === "1";
    const data = await fetchOfficialSporttery({ repair, serverHeaders: true });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "官方数据读取失败";
    const code = error instanceof OfficialSportteryError ? error.code : "OFFICIAL_FETCH_FAILED";
    const blocked = code === "OFFICIAL_ACCESS_BLOCKED";
    return NextResponse.json(
      {
        error: blocked
          ? "官方数据源拒绝本站访问（HTTP 567，五种玩法均受影响）。需获得数据源授权或放行后才能恢复实时赛程和赔率；反复刷新无法解除上游拦截。"
          : code === "OFFICIAL_MANIFEST_UNAVAILABLE"
            ? "官方接口仅返回销售控制配置，未提供赛事清单。当前比赛数量未知，不能据此认定停售或今日无比赛；新赔率选择与正式预测保持暂停。"
            : detail,
        detail,
        code,
        sourceState:
          error instanceof OfficialSportteryError
            ? error.sourceState
            : { manifestState: "unknown" },
        source: "中国体育彩票·竞彩网",
      },
      { status: blocked ? 503 : 502, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
