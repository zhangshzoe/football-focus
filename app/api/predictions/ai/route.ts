/* eslint-disable @typescript-eslint/no-explicit-any */
import {applyAiReviewVersion} from "../../../prediction-version";
import {getPublishedCalibration} from "../../../calibration-service";
export async function POST(request: Request):Promise<Response> {
  const providerName = "DeepSeek";
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return Response.json({error: "尚未配置 DEEPSEEK_API_KEY。"}, {status: 503});
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.reports) || body.reports.length>120 || !body?.version?.predictionId || body.reports.some((report:any)=>report.predictionId!==body.version.predictionId) || JSON.stringify(body).length > 3_000_000) return Response.json({error: "预测版本无效、赛事超过120场或已混入其他版本数据，请刷新后重试。"}, {status: 400});
  const calibration=await getPublishedCalibration(),intelligenceWeightMultiplier=calibration?.status==="validated"?Number(calibration.intelligenceWeightMultiplier)||0:0;
  const batchSize = 6;
  if(body.reports.length>batchSize){
    const reviews:any[]=[];const evidenceById:Record<string,any>={};let model="";
    for(let start=0;start<body.reports.length;start+=batchSize){
      const batch=body.reports.slice(start,start+batchSize),batchNumber=Math.floor(start/batchSize)+1;
      const response:Response=await POST(new Request(request.url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:body.version,reports:batch})}));
      const data:any=await response.json().catch(()=>({}));
      if(!response.ok)return Response.json({error:`${providerName} 第${batchNumber}批复核失败：${data.error||`HTTP ${response.status}`}`},{status:response.status});
      const batchReviews=Array.isArray(data.reviews)?data.reviews:[],reviewedIds=new Set(batchReviews.map((review:any)=>String(review.id||""))),missing=batch.filter((report:any)=>!reviewedIds.has(String(report.id)));
      if(missing.length)return Response.json({error:`${providerName} 第${batchNumber}批返回不完整，缺少：${missing.map((report:any)=>report.id).join("、")}`},{status:502});
      Object.assign(evidenceById,data.evidenceById||{});
      reviews.push(...batchReviews);model||=String(data.model||"");
    }
    const enrichedReports=body.reports.map((report:any)=>({...report,intelligenceEvidence:evidenceById[String(report.id)]||report.intelligenceEvidence||{records:[]}}));
    const generatedAt=new Date().toISOString(),built=applyAiReviewVersion(body.version,enrichedReports,reviews,providerName,model,generatedAt,intelligenceWeightMultiplier);
    return Response.json({...built,reviews,evidenceById,provider:providerName,model,generatedAt,batches:Math.ceil(body.reports.length/batchSize),intelligenceWeightMultiplier});
  }
  const enrichedReports=await enrichReportsWithOfficialContext(body.reports);
  const evidenceById=Object.fromEntries(enrichedReports.map((report:any)=>[String(report.id),report.intelligenceEvidence||{records:[]}])) as Record<string,any>;
  const compact = enrichedReports.slice(0, 40).map((report: any) => ({id: report.id, officialMatchId:report.officialMatchId, league: report.league, home: report.home, away: report.away, companies: report.companies, probabilities: report.probabilities, consensus: report.consensus, marketSignal: report.marketSignal, baselineScores: report.scores,intelligenceEvidence:report.intelligenceEvidence||{records:[]}}));
  const prompt = `你是审慎的足球赛事研究员和多盘口建模助手。根据以下当前竞彩足球数据，对每场比赛进行完整复核。输入含体彩胜平负、体彩固定让球胜平负、足彩网36*、ＳＢ/*、平*三家公司欧赔初盘/即盘、外围亚洲让球水位、大小球及多盘口泊松基线。

请对每场比赛按以下六层输出结论，并把关键内容压缩进summary（允许使用分号分段）：
1）对比两队可用的阵容、实力差距、固有球风与攻防特点；没有阵容资料时明确标注“阵容数据缺失”。
2）结合可用的近期表现（优先近6场）、竞技状态和赛程判断战意，说明是否可能轮换练兵；没有近6场数据时不得臆测。
3）若属于小组赛，按胜3平1负0规则分析胜/平/负对排名和出线形势的影响；若不是小组赛，标注“不适用”。
4）综合欧赔去水概率、盘口升降、水位变动、体彩让球、大小球和模型，给出常规预测比分及理由。
5）给出一个潜在爆冷比分（若无足够证据可标注“暂无可靠爆冷信号”），说明成因和触发条件，不得把爆冷当主预测。
6）报告四重一致性：泊松比分模型、蒙特卡洛模拟（如输入不足则说明限制）、近6场表现、庄家/盘口信号；明确哪些一致、哪些冲突。
7）明确最可能总进球数、胜平负方向、首选比分和次选比分。

概率要求：比分概率使用模型原始精确比分概率，不重新归一化；按概率从高到低返回4个比分。赔率只是市场预期，不是事实。不得编造伤停、天气、首发、裁判、排名或球员状态；未提供的一律视为数据缺失，并写入risk。若盘口冲突，必须明确指出，不能只按最低赔率倒推。

情报权重门控：verifiedIntelItems 只能列出输入 intelligenceEvidence.records 中已经存在的 type；每条输入证据必须带 sourceUrl 和 observedAt。不得自行补写、猜测或伪造证据。只有盘口、没有独立赛前情报时必须返回0并返回空证据数组；服务端会忽略你自报的 intelligenceCoverage，并按有效且未过期的证据重新计算覆盖率。

${JSON.stringify(compact)}

Return exactly one valid json object. 只返回严格JSON对象，不要Markdown，格式：{"reviews":[{"id":"场次","scores":[{"score":"1:0","probability":12.3},{"score":"1:1","probability":10.8},{"score":"2:0","probability":9.2},{"score":"0:0","probability":7.8}],"intelligenceCoverage":0,"verifiedIntelItems":[],"summary":"阵容/状态/战意/积分情景/四重一致性/总进球/胜平负/常规比分/爆冷比分及理由，使用分号分隔","risk":"伤停、首发、天气、裁判、近6场或小组积分等缺失项，以及盘口冲突"}]}。`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    const endpoint="https://api.deepseek.com/chat/completions";
    const fetchOptions:any={
      method: "POST", signal: controller.signal,
      headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
      body: JSON.stringify({model: process.env.DEEPSEEK_MODEL || "deepseek-chat", messages: [{role: "system", content: "只输出有效JSON对象，不要解释。"}, {role: "user", content: prompt}], thinking: {type: "disabled"}, stream: false, max_tokens: 6000, response_format: {type: "json_object"}}),
    };
    const response = await fetch(endpoint,fetchOptions);
    clearTimeout(timer);
    const data = await response.json().catch(() => null);
    if (!response.ok) return Response.json({error: data?.error?.message || `${providerName} 请求失败（HTTP ${response.status}）`}, {status: response.status});
    if(data?.status==="incomplete")throw new Error(`响应被截断${data?.incomplete_details?.reason?`（${data.incomplete_details.reason}）`:""}`);
    const text = data?.choices?.[0]?.message?.content;
    if(!String(text||"").trim())throw new Error(data?.output?.find((item:any)=>item.type==="refusal")?.content?.[0]?.refusal||"响应正文为空");
    const parsed = parseJsonPayload(text);
    const reviews = (Array.isArray(parsed) ? parsed : parsed.reviews || parsed.matches || []).map((review:any)=>({...review,intelligenceCoverage:Math.max(0,Math.min(100,numericCoverage(review.intelligenceCoverage)))}));
    if(!reviews.length)throw new Error("JSON 中没有 reviews");
    const invalid=reviews.find((review:any)=>!review?.id||!Array.isArray(review?.scores)||review.scores.length<1||review.scores.some((score:any)=>!/^\d+:\d+$/.test(String(score?.score||""))||!Number.isFinite(Number(score?.probability))));
    if(invalid)throw new Error(`场次 ${invalid?.id||"未知"} 的比分字段无效`);
    const generatedAt=new Date().toISOString(),built=applyAiReviewVersion(body.version,enrichedReports,reviews,providerName,String(data?.model||""),generatedAt,intelligenceWeightMultiplier);
    return Response.json({...built,reviews,evidenceById,provider: providerName,model:data?.model,generatedAt,intelligenceWeightMultiplier});
  } catch (error) {
    const detail=error instanceof Error?error.message:String(error||"未知错误");
    console.error(`[predictions/ai] ${providerName} parse failure: ${detail}`);
    return Response.json({error: error instanceof Error && error.name === "AbortError" ? `${providerName} 分析超时。` : `${providerName} 返回格式异常：${detail}`}, {status: 502});
  }
}

async function enrichReportsWithOfficialContext(reports:any[]){
  return Promise.all(reports.map(async(report:any)=>{
    const existing=Array.isArray(report?.intelligenceEvidence?.records)?report.intelligenceEvidence.records:[];
    const officialMatchId=String(report?.officialMatchId||"").trim();
    if(report?.officialMappingStatus!=="verified"||!/^[0-9]+$/.test(officialMatchId))return{...report,intelligenceEvidence:{records:existing}};
    try{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000),sourceUrl=`https://www.sporttery.cn/jc/zqdz/index.html?showType=3&mid=${officialMatchId}`;
      const response=await fetch(`https://webapi.sporttery.cn/gateway/uniform/football/getMatchHeadV1.qry?source=web&sportteryMatchId=${officialMatchId}`,{headers:{Referer:sourceUrl,"User-Agent":"Mozilla/5.0 (compatible; Personal-Football-Lab/1.0)",Accept:"application/json"},cache:"no-store",signal:controller.signal});
      clearTimeout(timer);
      if(!response.ok)return{...report,intelligenceEvidence:{records:existing}};
      const payload=await response.json().catch(()=>null),match=payload?.value;
      if(String(payload?.errorCode)!=="0"||!match)return{...report,intelligenceEvidence:{records:existing}};
      const observedAt=new Date().toISOString(),records=[...existing];
      const homeStats=match?.wbsjStats?.home,awayStats=match?.wbsjStats?.away;
      if(homeStats||awayStats)records.push({type:"official-team-form-and-ranking",sourceUrl,observedAt,summary:JSON.stringify({home:compactOfficialStats(homeStats),away:compactOfficialStats(awayStats)})});
      if(match?.phaseName||match?.groupName||match?.seasonName)records.push({type:"official-competition-context",sourceUrl,observedAt,summary:JSON.stringify({season:match.seasonName||"",phase:match.phaseName||"",group:match.groupName||"",gameweek:match.gameweek||""})});
      const deduped=[...new Map(records.map((item:any)=>[`${item.type}|${item.sourceUrl}`,item])).values()];
      return{...report,intelligenceEvidence:{records:deduped}};
    }catch{return{...report,intelligenceEvidence:{records:existing}}}
  }));
}

function compactOfficialStats(value:any){
  if(!value||typeof value!=="object")return null;
  return Object.fromEntries(Object.entries(value).filter(([key,item])=>/ranking|phaseName|groupName|seasonName|MatchCnt$/i.test(key)&&String(item??"").trim()!==""));
}

function numericCoverage(value:unknown){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0;}

function parseJsonPayload(value:unknown){
  const cleaned=String(value||"").replace(/<think>[\s\S]*?<\/think>/gi,"").replace(/^```(?:json)?\s*|\s*```$/gi,"").trim();
  const objectStart=cleaned.indexOf("{"),objectEnd=cleaned.lastIndexOf("}");
  const arrayStart=cleaned.indexOf("["),arrayEnd=cleaned.lastIndexOf("]");
  const candidate=objectStart>=0&&objectEnd>objectStart?cleaned.slice(objectStart,objectEnd+1):arrayStart>=0&&arrayEnd>arrayStart?cleaned.slice(arrayStart,arrayEnd+1):cleaned;
  const parsed=JSON.parse(candidate);
  return typeof parsed==="string"?JSON.parse(parsed):parsed;
}

