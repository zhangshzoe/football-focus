export function purchaseCaptureWindow(date,slot,now=Date.now(),preWindow=false){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!["1700","2100"].includes(slot)||!Number.isFinite(now))throw new Error("采集窗口身份无效");
 const time=slot==="2100"?"21:00":"17:00",target=Date.parse(`${date}T${time}:00+08:00`);
 if(!Number.isFinite(target)||new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date(target))!==date)throw new Error("采集日期无效");
 const start=target-(preWindow?15*60000:0),end=target+101*60000;
 return {scheduledAt:new Date(target).toISOString(),target,start,end,allowed:now>=start&&now<end,
  reason:now<start?`before-daily-${slot}`:now>=end?"window-closed":null,
  timing:now<=target?"pre-target-window":"delayed-batch"};
}
