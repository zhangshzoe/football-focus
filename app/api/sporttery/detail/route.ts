import {NextRequest,NextResponse} from "next/server";

const BASE="https://webapi.sporttery.cn/gateway/uniform/football";

export async function GET(request:NextRequest){
 const matchId=request.nextUrl.searchParams.get("matchId")?.trim();
 if(!matchId||!/^[0-9]+$/.test(matchId))return NextResponse.json({error:"缺少有效的竞彩网场次 ID"},{status:400});
 try{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  const headers={Referer:`https://www.sporttery.cn/jc/zqdz/index.html?showType=3&mid=${matchId}`,"User-Agent":"Mozilla/5.0 (compatible; Personal-Football-Lab/1.0)",Accept:"application/json"};
  const [headResponse,bonusResponse]=await Promise.all([
   fetch(`${BASE}/getMatchHeadV1.qry?source=web&sportteryMatchId=${matchId}`,{headers,cache:"no-store",signal:controller.signal}),
   fetch(`${BASE}/getFixedBonusV1.qry?clientCode=3001&matchId=${matchId}`,{headers,cache:"no-store",signal:controller.signal})
  ]);
  clearTimeout(timer);
  if(!headResponse.ok||!bonusResponse.ok)throw new Error("竞彩网单场数据暂不可用");
  const [head,bonus]=await Promise.all([headResponse.json(),bonusResponse.json()]);
  if(String(head.errorCode)!=="0"||String(bonus.errorCode)!=="0")throw new Error(head.errorMessage||bonus.errorMessage||"竞彩网单场数据读取失败");
  return NextResponse.json({source:"中国体育彩票·竞彩网",sourceUrl:`https://www.sporttery.cn/jc/zqdz/index.html?showType=3&mid=${matchId}`,fetchedAt:new Date().toISOString(),match:head.value,oddsHistory:bonus.value?.oddsHistory||[],matchResultList:bonus.value?.matchResultList||[],isCancel:bonus.value?.isCancel||0},{headers:{"Cache-Control":"no-store, max-age=0"}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error?error.message:"单场详情读取失败"},{status:502,headers:{"Cache-Control":"no-store, max-age=0"}});
 }
}
