'use strict';
const KINDS=new Set(['dash-reseller','users-iptv','users-p2p']);
const scrub=value=>Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:password|passwd|secret|token|authorization|cookie)/i.test(key)).map(([key,item])=>[key,scrub(item)])):value;
class PanelSnapshots{
 constructor(){this.entries=new Map();}
 async capture(response){
  try{
   const url=new URL(response.url());
   if(url.protocol!=='https:'||!['gesapioffice.com','searchdefense.top'].includes(url.hostname)||response.request().method()!=='GET'||!response.ok())return;
   const kind=url.pathname.replace(/^\/api\//,'');if(!KINDS.has(kind))return;
   const data=scrub(await response.json());if(Buffer.byteLength(JSON.stringify(data))>700000)return;
   this.entries.set(kind,{at:Date.now(),data});
  }catch{}
 }
 report(){const result={};for(const [key,value] of this.entries)if(Date.now()-value.at<15*60000)result[key]=value.data;return result;}
}
module.exports={PanelSnapshots,scrub};
