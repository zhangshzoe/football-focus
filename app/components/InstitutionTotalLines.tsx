export type TotalCompany={companyId?:number;company?:string;total?:number;firstTotal?:number};

export default function InstitutionTotalLines({companies=[]}:{companies?:TotalCompany[]}){
 const groups=new Map<number,TotalCompany[]>();
 const seen=new Set<string|number>();
 for(const company of companies){
  const identity=company.companyId??company.company;
  if(identity===undefined||seen.has(identity)||typeof company.total!=="number"||!Number.isFinite(company.total)||company.total<=0)continue;
  seen.add(identity);
  groups.set(company.total,[...(groups.get(company.total)||[]),company]);
 }
 if(!groups.size)return <span className="total-unavailable">暂无机构数据</span>;
 return <div className="institution-total-groups">{Array.from(groups,([total,members])=>{
  const movements=new Map<string,string[]>();
  for(const member of members){
   const first=member.firstTotal;
   const status=typeof first!=="number"||!Number.isFinite(first)||first<=0?"初盘未知":Math.abs(total-first)<.005?"盘口维持":`${first} → ${total} ${total>first?"↑ 升盘":"↓ 降盘"}`;
   movements.set(status,[...(movements.get(status)||[]),member.company||`机构${member.companyId}`]);
  }
  const changed=[...movements.keys()].some(text=>text.includes("→"));
  const majority=members.length===2;
  return <div className={`institution-total-group${changed?" total-line-changed":""}${majority?" total-line-majority":""}`} key={total} title={members.map(member=>member.company||`机构${member.companyId}`).join("、")}>
   {majority?<strong>{total} 球 · {members.length}家</strong>:<span>{total} 球 · {members.length}家</span>}
   {[...movements].map(([status,names])=><small className={status.includes("→")?"total-movement":""} key={status} title={names.join("、")}>{status}{movements.size>1?`（${names.join("、")}）`:""}</small>)}
  </div>;
 })}</div>;
}
