import {NextResponse} from "next/server";
import {fetchOfficialSporttery} from "../../sporttery-official";

export async function GET(request:Request){
 try{
  const repair=new URL(request.url).searchParams.get("repairMissing")==="1";
 const data=await fetchOfficialSporttery({repair,serverHeaders:true});
  return NextResponse.json(data,{headers:{"Cache-Control":"no-store, max-age=0"}});
 }catch(error){
  const detail=error instanceof Error?error.message:"官方数据读取失败";
  const blocked=detail.includes("竞彩网五个玩法均读取失败")&&["HAD","HHAD","CRS","TTG","HAFU"].every(pool=>detail.includes(`${pool} 返回 567`));
  return NextResponse.json({
   error:blocked?"官方数据源拒绝本站访问（HTTP 567，五种玩法均受影响）。需获得数据源授权或放行后才能恢复实时赛程和赔率；反复刷新无法解除上游拦截。":detail,
   code:blocked?"OFFICIAL_ACCESS_BLOCKED":"OFFICIAL_FETCH_FAILED",
   source:"中国体育彩票·竞彩网",
  },{status:blocked?503:502,headers:{"Cache-Control":"no-store, max-age=0"}});
 }
}
