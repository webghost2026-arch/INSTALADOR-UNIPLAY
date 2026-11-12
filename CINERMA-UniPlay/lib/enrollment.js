'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const HUB='https://harpiamanager.com',valid=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
async function getDevice(root){
 await fs.mkdir(root,{recursive:true});const file=path.join(root,'device-id.json');
 try{const value=JSON.parse(await fs.readFile(file,'utf8'));if(valid(value.id))return value.id;throw Error('Identidade local invalida.');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 const id=crypto.randomBytes(32).toString('hex');await fs.writeFile(file,JSON.stringify({id}),{mode:0o600,flag:'wx'});return id;
}
async function enroll({source,dataRoot,store,fetcher=fetch}){
 let config;try{config=JSON.parse(await fs.readFile(path.join(source,'install-config.json'),'utf8'));}
 catch(e){
  if(e.code!=='ENOENT')throw Error('Instalador invalido. Baixe novamente pelo Hub.');
  const existing=await store.load();if(existing?.hub===HUB&&valid(existing.token))return existing;
  throw Error('Baixe o instalador em Configuracoes do seu Hub e extraia o ZIP completo.');
 }
 if(config.version!==1||config.hub!==HUB||!valid(config.nonce)||!Number.isFinite(config.expiresAt))throw Error('Instalador invalido. Baixe novamente pelo Hub.');
 const deviceId=await getDevice(dataRoot);
 let response;try{response=await fetcher(HUB+'/uniplay-local-api/register',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:config.nonce,deviceId})});}
 catch{throw Error('Nao foi possivel acessar o Hub. Confira a internet e abra Instalar novamente.');}
 const result=await response.json().catch(()=>({}));
 if(!response.ok){
  if(response.status===410||response.status===409)throw Error('Este download expirou ou ja foi usado em outro computador. Baixe novamente no Hub.');
  throw Error('O Hub nao aceitou este instalador. Baixe novamente em Configuracoes.');
 }
 if(result.ok!==true||result.hub!==HUB||!valid(result.token))throw Error('Resposta de instalacao invalida.');
 const connection={hub:HUB,token:result.token};await store.save(connection);return connection;
}
module.exports={enroll,getDevice,HUB};
