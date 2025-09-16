
function pad2(n){ return n<10?'0'+n:''+n; }
function formatUtcYmdHms(date){
  const y=date.getUTCFullYear(),m=pad2(date.getUTCMonth()+1),d=pad2(date.getUTCDate());
  const hh=pad2(date.getUTCHours()),mm=pad2(date.getUTCMinutes()),ss=pad2(date.getUTCSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}
function normalizeToUtcString(input){
  if(!input)return'';let dt=null;
  if(input instanceof Date){ if(!isNaN(input.getTime())) dt=input; }
  else if(typeof input==='string'){ const s=input.replace(/^\[|\]$/g,'').trim(); const d=new Date(s); if(!isNaN(d.getTime())) dt=d; }
  return dt?formatUtcYmdHms(dt):'';
}
function nowUtcStamp(){ return formatUtcYmdHms(new Date()); }
module.exports={pad2,formatUtcYmdHms,normalizeToUtcString,nowUtcStamp};
