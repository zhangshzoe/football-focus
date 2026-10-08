/* eslint-disable @typescript-eslint/no-explicit-any */

const ALLOWED_TAGS=new Set(["赛前情报缺口","盘口分歧","大小球偏差","半全场走势偏差","阵容信息缺失","事件数据缺失","模型校准建议","低概率赛果","比分覆盖"]);
const unsupportedEventClaim=/(发生|出现|因为|由于|导致).{0,12}(红牌|点球|伤退|VAR|乌龙|门将失误)/;

export async function POST(request:Request){
 const providerName="DeepSeek";
 const apiKey=process.env.DEEPSEEK_API_KEY;
 if(!apiKey)return Response.json({error:"尚未配置 DEEPSEEK_API_KEY。"},{status:503});
 const body=await request.json().catch(()=>null),items=Array.isArray(body?.items)?body.items.slice(0,40):[];
 if(!items.length||JSON.stringify(body).length>100_000)return Response.json({error:"盘后复盘数据无效或过大。"},{status:400});
 const compact=items.map((item:any)=>({key:item.key,match:item.match,prediction:item.prediction,result:item.result,quantitativeReview:item.quantitativeReview,preMatchAi:item.preMatchAi}));
 const prompt=`你是严格基于证据的足球盘后复盘助手。下面的数据只包含不可修改的赛前预测快照、官方半场/全场赛果、量化复盘和赛前AI披露的缺失项。请为每场输出简洁复盘，重点说明：预测与实际差异、哪些赛前信号本可补充、模型应如何改进。

硬性规则：
1. quantitativeReview.primary 是按赛前概率计算的主标签，必须原样保留，不得自行修改。
2. 输入没有赛中事件时间线。不得声称发生红牌、点球、伤退、VAR、乌龙、门将失误、具体射门或xG；只能说“需要事件数据核验”。
3. 不得搜索或补写球员、阵容、天气、裁判等事实；未提供即为缺失。
4. 不得因为看到赛果就倒推不存在的原因。区分已证实赛果与待核验原因。
5. 建议必须针对未来赛前可获取的信息或模型校准，不能承诺命中。

${JSON.stringify(compact)}

只返回严格JSON对象：{"reviews":[{"key":"快照比赛键","primary":"原主标签","summary":"一段不超过300字的复盘","causeTags":["仅从允许标签中选择"],"improvements":["最多3条"],"evidenceLevel":"基础赛果已证实 · 赛中原因待核验","predictability":"高/中/低"}]}。允许标签：赛前情报缺口、盘口分歧、大小球偏差、半全场走势偏差、阵容信息缺失、事件数据缺失、模型校准建议、低概率赛果、比分覆盖。`;
 try{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55_000);
  const response=await fetch("https://api.deepseek.com/chat/completions",{method:"POST",signal:controller.signal,headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model:process.env.DEEPSEEK_MODEL||"deepseek-chat",messages:[{role:"system",content:"只输出有效JSON，不得编造未提供的比赛事实。"},{role:"user",content:prompt}],thinking:{type:"disabled"},stream:false,max_tokens:6500,response_format:{type:"json_object"}})});
  clearTimeout(timer);const data=await response.json().catch(()=>null);
  if(!response.ok)return Response.json({error:data?.error?.message||`${providerName} 请求失败（HTTP ${response.status}）`},{status:response.status});
  const text=data?.choices?.[0]?.message?.content;
  const cleaned=String(text||"").replace(/<think>[\s\S]*?<\/think>/gi,"").replace(/^```(?:json)?\s*|\s*```$/g,"").trim(),start=cleaned.indexOf("{"),end=cleaned.lastIndexOf("}");
  const parsed=JSON.parse(start>=0&&end>start?cleaned.slice(start,end+1):cleaned),rawReviews=Array.isArray(parsed)?parsed:parsed.reviews||[];
  const inputByKey=new Map(items.map((item:any)=>[String(item.key),item]));
  const reviews=rawReviews.map((review:any)=>{const key=String(review.key||""),input=inputByKey.get(key) as any;if(!input)return null;const candidate=String(review.summary||"").slice(0,800),safeSummary=unsupportedEventClaim.test(candidate)?String(input.quantitativeReview?.summary||""):candidate;return{key,primary:String(input.quantitativeReview?.primary||"数据不足"),summary:safeSummary||String(input.quantitativeReview?.summary||""),causeTags:Array.isArray(review.causeTags)?review.causeTags.map(String).filter((tag:string)=>ALLOWED_TAGS.has(tag)).slice(0,5):[],improvements:Array.isArray(review.improvements)?review.improvements.map(String).filter(Boolean).slice(0,3):[],evidenceLevel:"基础赛果已证实 · 赛中原因待核验",predictability:["高","中","低"].includes(String(review.predictability))?String(review.predictability):String(input.quantitativeReview?.predictability||"低")};}).filter(Boolean);
  return Response.json({reviews,provider:providerName,model:data?.model,generatedAt:new Date().toISOString()});
 }catch(error){return Response.json({error:error instanceof Error&&error.name==="AbortError"?`${providerName} 复盘超时。`:`${providerName} 未返回可解析的复盘结果。`},{status:502});}
}
