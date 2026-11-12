'use strict';
const {CreditSync}=require('./credit-sync');
const path=require('node:path');
const {Renewal}=require('../recovered/renewal-shared');
function connection(input){
  const url=new URL(String(input.hub||''));
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('Use a origem HTTPS do Hub, sem caminho ou senha.');
  if(!/^[a-f0-9]{64}$/.test(input.token||''))throw Error('A chave de pareamento precisa ter 64 caracteres.');
  return {hub:url.origin,token:input.token};
}
class Bridge{
  constructor({worker,store,fetcher=fetch,monitor=null,creditSyncOptions={},renewal=null}){this.creditSync=new CreditSync(worker,creditSyncOptions);this.monitor=monitor;this.worker=worker;this.store=store;this.fetcher=fetcher;this.config=null;this.running=false;this.lastContact=null;this.message='Aguardando configuracao pelo Hub.';this.login=null;this.ack=null;this.refreshResult=null;this.chain=Promise.resolve();this.renewal=renewal||new Renewal(worker,{journal:path.join(worker.root,'renewals')});this.renewalResult=null;this.renewing=false;}
  serial(action){const result=this.chain.then(action);this.chain=result.catch(()=>{});return result;}
  async restore(){const saved=await this.store.load();if(saved){this.config=connection(saved);const account=await this.store.loadAccount?.(this.config.hub);if(account)this.worker.setCredentials?.(account);}}
  async send(config,report,fresh=false){
    const response=await this.fetcher(config.hub+'/uniplay-local-api/poll',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify({...report,connectionPhase:this.monitor?.phase||'',connectionMessage:this.monitor?.message||'',automaticConnection:Boolean(this.monitor&&!this.monitor.paused),paused:this.monitor?.paused===true,busy:this.renewing,state:report.authenticated?'background':'idle',ack:fresh?null:this.ack,capabilities:['refresh-credits-v1','renew-iptv-v1'],...(!fresh&&this.refreshResult?{refreshResult:this.refreshResult}:{}),...(!fresh&&this.renewalResult?{renewalResult:this.renewalResult}:{})})});
    if(response.status===401)throw Error('Vinculo recusado pelo Hub. Baixe e instale uma nova copia pelo Hub.');
    if(!response.ok)throw Error('Hub respondeu HTTP '+response.status+'.');
    const data=await response.json();if(data.ok!==true)throw Error('Resposta do Hub nao reconhecida.');return data;
  }
  async accept(data){
    if(this.renewalResult&&data.renewalResultAccepted===this.renewalResult.id){await this.renewal.acknowledge(this.renewalResult.id);this.renewalResult=null;}
    if(data.refreshResultAccepted===this.refreshResult?.id)this.refreshResult=null;
    const cmd=data.command;if(!cmd)return;
    if(cmd.type==='prepare-login'&&cmd.id!==this.ack){
      if(typeof cmd.id!=='string'||cmd.id.length>160||typeof cmd.credentials?.username!=='string'||typeof cmd.credentials?.password!=='string'||cmd.credentials.username.length>256||cmd.credentials.password.length>1024)throw Error('Comando de login invalido.');
      if(this.config&&this.store.saveAccount)await this.store.saveAccount(this.config.hub,cmd.credentials);this.worker.setCredentials?.(cmd.credentials);this.monitor?.reset();this.login=cmd;this.message='Login recebido. Preparando a conexao.';
    }else if(cmd.type==='refresh-credits'){
      try{const value=await this.worker.refreshCredits();this.refreshResult={id:cmd.id,ok:typeof value==='number',message:typeof value==='number'?'Saldo lido.':'Saldo nao identificado.'};}
      catch{this.refreshResult={id:cmd.id,ok:false,message:'Abra o painel conectado antes de consultar o saldo.'};}
    }else if(cmd.type==='renew-iptv'){
      if(this.monitor?.paused||this.renewing||this.renewalResult)return;
      this.renewing=true;this.worker.mode='background';this.worker.paused=false;
      try{this.message='Renovando a conta solicitada pelo Hub.';this.renewalResult=await this.renewal.execute(cmd);this.worker.invalidateCredits?.();this.message=this.renewalResult.ok?'Renovado. Vencimento: '+this.renewalResult.after:this.renewalResult.message;}
      finally{this.renewing=false;}
    }else if(String(cmd.type).startsWith('renew-'))throw Error('Tipo de renovacao ainda sem executor validado. Pedido permanece pendente no Hub.');
  }
  async pair(input){return this.serial(async()=>{const next=connection(input);const response=await this.send(next,await this.worker.report(),true);await this.store.save(next);this.config=next;this.worker.setCredentials?.(await this.store.loadAccount?.(next.hub)||null);this.monitor?.reset();this.ack=null;this.login=null;this.lastContact=new Date().toISOString();this.message='Pareamento confirmado pelo Hub.';await this.accept(response);});}
 async tick(){
  if(this.running||!this.config)return;this.running=true;
  try{await this.serial(async()=>{
   let hubError=null;
   try{this.renewalResult=this.renewalResult||await this.renewal.pendingResult();if(!this.monitor?.paused&&!this.renewalResult)await this.creditSync.step();const report=await this.worker.report();const response=await this.send(this.config,report);this.lastContact=new Date().toISOString();await this.accept(response);}
   catch(e){hubError=e.message;}
   if(this.monitor){
    await this.monitor.step();
    if(this.login&&(this.worker.prepared||await this.worker.authenticated())){this.ack=this.login.id;this.login=null;}
    this.message=(hubError?'Hub sem contato: '+hubError+' ':'')+this.monitor.message;
   }else this.message=hubError||'Hub conectado. Abra o login assistido.';
  });}catch(e){this.message=e.message;}finally{this.running=false;}
 }
  async open(){return this.serial(async()=>{this.monitor?.resume();try{await this.worker.open(this.login?.credentials);}catch{throw Error("Nao foi possivel abrir/preparar o Chrome. Confira se o Chrome esta instalado e tente novamente.");}if(this.login){this.ack=this.login.id;this.login=null;}this.message='Chrome aberto. Conclua o login e qualquer verificacao na janela do UniPlay.';});}
  status(){return {version:require('../package.json').version,...this.monitor?.status(),paired:!!this.config,hub:this.config?.hub||'',lastContact:this.lastContact,message:this.message,loginPending:!!this.login,renewalsEnabled:!this.monitor?.paused,renewing:this.renewing,renewalResult:this.renewalResult,creditSyncState:this.creditSync.state};}
}
module.exports={Bridge,connection};



