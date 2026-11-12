'use strict';
const http=require('node:http'),path=require('node:path');
const {Store}=require('./lib/store'),{Bridge}=require('./lib/bridge');
function createServer({bridge,worker,port=3217}){
 return http.createServer(async(req,res)=>{
  const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  if(req.headers.host!=='127.0.0.1:'+port)return json(403,{ok:false});
  if(req.method!=='GET'||req.url!=='/api/status')return json(404,{ok:false,message:'Este executor e gerenciado pelo Hub.'});
  try{json(200,{ok:true,...bridge.status(),...await worker.report()});}catch{json(503,{ok:false});}
 });
}
async function main(){
 const {Worker}=require('./lib/worker'),{Monitor}=require('./lib/monitor');
 const root=process.env.CINERMA_LOCAL_DATA_DIR||path.join(process.env.LOCALAPPDATA||__dirname,'CINERMA-UniPlay');
 const worker=new Worker(root),bridge=new Bridge({worker,store:new Store(root),monitor:new Monitor(worker)});
 await bridge.restore();
 if(!bridge.config){console.error('Instalacao sem vinculo. Baixe o executor pelo Hub e instale novamente.');process.exitCode=1;return;}
 const server=createServer({bridge,worker});
 server.on('error',e=>{if(e.code==='EADDRINUSE')process.exit(0);else{console.error('Executor indisponivel.');process.exitCode=1;}});
 server.listen(3217,'127.0.0.1',()=>{console.log('CINERMA UniPlay ativo. Gerenciado pelo Hub.');const timer=setInterval(()=>void bridge.tick(),3000);timer.unref();void bridge.tick();});
 async function stop(){server.close();await worker.close();process.exit(0);}
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
if(require.main===module)main().catch(()=>{console.error('Nao foi possivel iniciar o executor.');process.exitCode=1;});
module.exports={createServer};
