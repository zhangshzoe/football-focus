type Company = {
  companyId:number; company:string;
  win:number; draw:number; lose:number; handicap:number; homePrice:number; awayPrice:number; total:number; overPrice:number; underPrice:number;
  firstWin:number; firstDraw:number; firstLose:number; firstHandicap:number; firstHomePrice:number; firstAwayPrice:number; firstTotal:number; firstOverPrice:number; firstUnderPrice:number;
};

type Signal = {
  direction:string; strength:number; probabilityShifts:number[]; fairOdds:number[];
  hadEv?:number[]; hhadEv?:number[]; evThreshold?:number; institutionAction?:string; handicapExpectation?:string;
  firstHandicap:number; handicapChange:number; narrative:string;
  officialOdds:number[]; officialHandicap:string; officialHhadOdds:number[];
  officialHhadFair:number[];modeledHhad:number[];hhadAvailable?:boolean;asianHomeProbability:number;asianAwayProbability:number;asianMovement:number;overProbability:number;fitAgreement:string;handicapMeaning:string;
  calibrationSampleSize?:number;probabilityTemperature?:number;historicalMeanTotalGoals?:number;goalDispersion?:number;firstHalfGoalShare?:number;lowScoreRho?:number;
};

type Props={row:{companies:Company[];marketSignal?:Signal}};

const number=(value:number,digits=2)=>Number.isFinite(value)?value.toFixed(digits):"—";
const line=(value:number)=>Number.isFinite(value)?`${value>0?"+":""}${value}`:"—";
const evText=(value:number|undefined)=>Number.isFinite(value)?`${value!>=0?"+":""}${(value!*100).toFixed(1)}%`:"—";
const handicapText=(value:string)=>{const numeric=Number(value);return value.trim()&&Number.isFinite(numeric)?`${numeric>0?"+":""}${numeric}`:"—"};

function Movement({first,current}:{first:number;current:number}){
  if(!Number.isFinite(first)||!Number.isFinite(current))return <span>—</span>;
  const delta=current-first;
  const kind=Math.abs(delta)<0.005?"flat":delta<0?"down":"up";
  return <span className={`odds-movement ${kind}`}><small>{number(first)}</small><i>{kind==="down"?"↓":kind==="up"?"↑":"→"}</i><b>{number(current)}</b></span>;
}

export default function PredictionMarketSignals({row}:Props){
  const signal=row.marketSignal;
  if(!signal)return null;
  const strength=Math.abs(signal.strength)<1?"偏弱":Math.abs(signal.strength)<2.5?"中等":"较强";
  return <section className="market-signal-panel">
    <div className="market-signal-summary">
      <div><small>机构市场倾向（推断）</small><strong>{signal.direction}</strong><span className={`signal-strength ${strength==="较强"?"strong":""}`}>{strength}</span></div>
      <p>{signal.narrative}</p>
    </div>
    <div className="market-price-grid">
      <div><small>中国体彩 胜平负</small><b>{signal.officialOdds.length===3?`胜 ${number(signal.officialOdds[0])} · 平 ${number(signal.officialOdds[1])} · 负 ${number(signal.officialOdds[2])}`:"暂缺"}</b></div>
      <div><small>中国体彩 让球胜平负</small><b>{signal.hhadAvailable&&signal.officialHhadOdds.length===3?<><span className={`handicap-value ${Number(signal.officialHandicap)>0?"positive":Number(signal.officialHandicap)<0?"negative":"neutral"}`}>{handicapText(signal.officialHandicap)}</span>{` · 让胜 ${number(signal.officialHhadOdds[0])} · 让平 ${number(signal.officialHhadOdds[1])} · 让负 ${number(signal.officialHhadOdds[2])}`}</>:"不可用（缺少官方让球或玩法资格）"}</b></div>
      <div className="fair-price"><small>三公司 + 体彩中和公平赔率</small><b>主 {number(signal.fairOdds[0])} · 平 {number(signal.fairOdds[1])} · 客 {number(signal.fairOdds[2])}</b><em>已去除返还率，仅供模型比较，非可投注赔率</em></div>
    </div>
    <div className="market-ev-grid">
      <div><small>胜平负 EV（模型概率×体彩赔率−1）</small><b><span className={(signal.hadEv?.[0]||0)>=(signal.evThreshold||.05)?"ev-positive":""}>胜 {evText(signal.hadEv?.[0])}</span><span className={(signal.hadEv?.[1]||0)>=(signal.evThreshold||.05)?"ev-positive":""}>平 {evText(signal.hadEv?.[1])}</span><span className={(signal.hadEv?.[2]||0)>=(signal.evThreshold||.05)?"ev-positive":""}>负 {evText(signal.hadEv?.[2])}</span></b><em>正EV且超过 {(signal.evThreshold||.05)*100}% 才进入价值筛选</em></div>
      <div><small>让球胜平负 EV</small>{signal.hhadAvailable?<><b><span className={(signal.hhadEv?.[0]||0)>=(signal.evThreshold||.05)?"ev-positive":""}>让胜 {evText(signal.hhadEv?.[0])}</span><span className={(signal.hhadEv?.[1]||0)>=(signal.evThreshold||.05)?"ev-positive":""}>让平 {evText(signal.hhadEv?.[1])}</span><span className={(signal.hhadEv?.[2]||0)>=(signal.evThreshold||.05)?"ev-positive":""}>让负 {evText(signal.hhadEv?.[2])}</span></b><em>EV为模型估算值，不代表命中保证</em></>:<b>不可计算</b>}</div>
    </div>
    <div className="market-cross-grid">
      <div><small>外围亚盘去水概率</small><b>主队侧 {number(signal.asianHomeProbability,1)}% · 客队侧 {number(signal.asianAwayProbability,1)}%</b><em>较初盘主队侧 {signal.asianMovement>=0?"+":""}{number(signal.asianMovement,1)}%</em></div>
      <div><small>多盘口校准后的体彩让球概率</small>{signal.hhadAvailable?<><b>让胜 {number(signal.modeledHhad?.[0],1)}% · 让平 {number(signal.modeledHhad?.[1],1)}% · 让负 {number(signal.modeledHhad?.[2],1)}%</b><em>同时约束欧赔、亚盘、大小球和体彩固定让球</em></>:<><b>不可用</b><em>未使用 0 球让步替代缺失的官方让球</em></>}</div>
      <div><small>大小球市场</small><b>大球侧 {number(signal.overProbability,1)}% · 小球侧 {number(100-signal.overProbability,1)}%</b><em>{signal.fitAgreement}</em></div>
      <div><small>历史赛果校准</small><b>{signal.calibrationSampleSize?`${signal.calibrationSampleSize} 场 · 概率温度 ${number(signal.probabilityTemperature||1,2)}`:"有效样本不足，使用盘口基线"}</b><em>{signal.calibrationSampleSize?`总球均值 ${number(signal.historicalMeanTotalGoals||0,2)} · 离散度 ${number(signal.goalDispersion||1,2)} · 低比分ρ ${number(signal.lowScoreRho||0,2)} · 半场占比 ${number((signal.firstHalfGoalShare||.45)*100,1)}%`:"Dixon–Coles 低比分修正先影子验证，不用短样本直接上线"}</em></div>
    </div>
    <div className="handicap-meaning"><b>盘口含义</b><span>{signal.handicapMeaning}</span>{signal.handicapExpectation&&<strong>{signal.handicapExpectation}</strong>}{signal.institutionAction&&<em>{signal.institutionAction}</em>}</div>
    <div className="odds-movement-wrap">
      <div className="movement-title"><b>三家公司变盘（初盘 → 即盘）</b><span><i className="legend down"/>降赔 · <i className="legend up"/>升赔 · 盘口同时显示当前水位</span></div>
      <div className="odds-movement-table">
        <div className="movement-row heading"><span>公司</span><span>主胜</span><span>平</span><span>客胜</span><span>亚洲让球</span><span>大小球</span></div>
        {row.companies.map(company=><div className="movement-row" key={company.companyId}>
          <b>{company.company}</b>
          <Movement first={company.firstWin} current={company.win}/><Movement first={company.firstDraw} current={company.draw}/><Movement first={company.firstLose} current={company.lose}/>
          <span className="line-movement"><b>{line(company.firstHandicap)} → {line(company.handicap)}</b><small>主 {number(company.homePrice)} / 客 {number(company.awayPrice)}</small></span>
          <span className="line-movement"><b>{number(company.firstTotal)} → {number(company.total)}</b><small>大 {number(company.overPrice)} / 小 {number(company.underPrice)}</small></span>
        </div>)}
      </div>
    </div>
    <p className="market-signal-note">概率来自多盘口交叉校准，不是把单一赔率直接倒数。它仍属于市场模型推断，不包含未取得的真实伤停或首发信息，也不是赛果或命中保证。</p>
  </section>;
}
