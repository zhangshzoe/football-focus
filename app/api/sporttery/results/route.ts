import {NextRequest,NextResponse} from "next/server";

const SOURCE_URL="https://cp.zgzcw.com/dc/getKaijiangFootBall.action";
const DATE_PATTERN=/^\d{4}-\d{2}-\d{2}$/;
const MAX_RESULT_PAGES=10;

function shanghaiDate(offsetDays=0){
 const date=new Date(Date.now()+offsetDays*86400000);
 return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
}

function plainText(value:string){
 return value.replace(/<br\s*\/?>/gi," ").replace(/<[^>]*>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
}

function parseResults(html:string,date:string){
 const body=html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1]||"";
 const results=[] as Array<{id:string;matchId:string;officialMatchId:string;date:string;league:string;home:string;away:string;halfScore:string;fullScore:string;handicap:string;hadResult:string;hhadResult:string;scoreResult:string;totalGoalsResult:string;status:string}>;
 for(const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[] as Array<{attrs:string;text:string}>;
  for(const cell of row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi))cells.push({attrs:cell[1],text:plainText(cell[2])});
  // 数据行共 12 列；空比分代表比赛未结束或彩果尚未更新，不写入回溯。
  if(cells.length<12)continue;
  const scoreCell=cells[4].text;
  const fullScore=scoreCell.match(/\d+\s*:\s*\d+/)?.[0]?.replace(/\s/g,"")||"";
  if(!fullScore)continue;
  const halfScore=scoreCell.match(/\(\s*(\d+\s*:\s*\d+)\s*\)/)?.[1]?.replace(/\s/g,"")||"—";
  const matchId=cells[2].attrs.match(/\btid\s*=\s*["']?([^\s"'>]+)/i)?.[1]||"";
  results.push({id:cells[0].text,matchId,officialMatchId:matchId,date,league:cells[1].text,home:cells[3].text,away:cells[5].text,halfScore,fullScore,handicap:cells[7].text,hadResult:cells[6].text,hhadResult:cells[8].text,scoreResult:cells[9].text,totalGoalsResult:cells[10].text,status:"settled"});
 }
 return results;
}

function resultPageCount(html:string){
 const pages=Array.from(html.matchAll(/javascript:page\((\d+)\)/gi),match=>Number(match[1])).filter(Number.isFinite);
 return Math.min(MAX_RESULT_PAGES,Math.max(1,...pages));
}

async function fetchResultPage(url:string,page:number,signal:AbortSignal){
 const headers={Referer:"https://cp.zgzcw.com/",Accept:"text/html,application/xhtml+xml","User-Agent":"Mozilla/5.0 (compatible; Personal-Football-Lab/1.0)"};
 const response=await fetch(url,page===1?{cache:"no-store",signal,headers}:{method:"POST",cache:"no-store",signal,headers:{...headers,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({jumpPage:String(page)})});
 if(!response.ok)throw new Error(`足彩网赛果第 ${page} 页返回 ${response.status}`);
 return response.text();
}

export async function GET(request:NextRequest){
 const date=request.nextUrl.searchParams.get("date")||shanghaiDate(-1);
 const today=shanghaiDate(),earliest=shanghaiDate(-29);
 if(!DATE_PATTERN.test(date)||date<earliest||date>today)return NextResponse.json({error:`仅支持 ${earliest} 至 ${today} 的赛果查询`},{status:400});
 try{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  const query=new URLSearchParams({startTime:date,endTime:date});
  const url=`${SOURCE_URL}?${query}`,firstHtml=await fetchResultPage(url,1,controller.signal),pageCount=resultPageCount(firstHtml);
  const remaining=pageCount>1?await Promise.all(Array.from({length:pageCount-1},(_,index)=>fetchResultPage(url,index+2,controller.signal))):[];
  clearTimeout(timer);
  const parsed=[firstHtml,...remaining].flatMap(html=>parseResults(html,date));
  const results=Array.from(new Map(parsed.map(result=>[`${result.date}|${result.id}|${result.home}|${result.away}`,result])).values());
  return NextResponse.json({source:"足彩网·竞彩足球开奖结果",sourcePage:SOURCE_URL,date,fetchedAt:new Date().toISOString(),pages:pageCount,results},{headers:{"Cache-Control":"no-store, max-age=0"}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error?error.message:"赛果读取失败"},{status:502,headers:{"Cache-Control":"no-store, max-age=0"}});
 }
}
