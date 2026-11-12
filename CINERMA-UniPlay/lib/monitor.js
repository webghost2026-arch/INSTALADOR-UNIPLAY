'use strict';
class Monitor {
 constructor(worker,{clock=Date.now}={}){this.worker=worker;this.clock=clock;this.paused=false;this.phase='waiting';this.message='Aguardando pareamento.';this.attempts=0;this.failures=0;this.recoveries=0;this.nextAttempt=0;this.loadingSince=null;}
 reset(){this.failures=0;this.recoveries=0;this.attempts=0;this.nextAttempt=0;this.loadingSince=null;this.worker.resetVerification?.();}
 pause(){this.paused=true;this.worker.cancelVerification?.();this.phase='paused';this.message='Reconexao pausada por voce.';}
 resume(){this.paused=false;this.reset();}
 status(){return {autoConnect:!this.paused,connectionPhase:this.phase,connectionMessage:this.message,loginAttempts:this.attempts};}
 manual(phase){
  this.phase='verification_required';
  this.message=phase==='captcha_expired'?'A verificacao expirou. Marque novamente a caixa e conclua o desafio no Chrome.':phase==='captcha_blocked'?'O provedor bloqueou a verificacao. Aguarde e siga as instrucoes no Chrome.':phase==='two_factor'?'Conclua a verificacao de dois fatores no Chrome.':'Conclua a verificacao humana no Chrome. O executor aguarda sem repetir o login.';
 }
 async step(){
  if(this.paused)return;

  try{
   let phase=await this.worker.inspect();
   if(phase==='no_browser'&&!this.worker.hasCredentials()){this.phase='credentials_required';this.message='Informe a conta no Hub e clique em Salvar Painel.';return;}
   if(phase==='connected'){this.reset();this.phase='connected';this.message='Sessao UniPlay confirmada. Monitorando a conexao.';return;}
   if(['captcha','captcha_expired','captcha_blocked','two_factor'].includes(phase)){
    if(this.worker.hasCredentials())await this.worker.prepareLogin();
    this.loadingSince=null;this.manual(phase);return;
   }
   if(this.clock()<this.nextAttempt)return;
   if(this.failures>=3){this.phase='connection_failed';this.message='Tres falhas de conexao. Confira a rede e use Retomar reconexao.';return;}
   if(phase==='no_browser'){this.phase='opening';this.message='Abrindo o Chrome com o perfil salvo.';await this.worker.launch();return;}
   if(phase==='loading'){if(this.loadingSince===null)this.loadingSince=this.clock();this.phase='loading';this.message='Aguardando o painel carregar.';if(this.clock()-this.loadingSince>=60000&&this.worker.recover){if(this.recoveries>=3){this.phase='connection_failed';this.message='Painel indisponivel apos tres recuperacoes. Use Retomar reconexao.';return;}this.recoveries++;this.nextAttempt=this.clock()+30000*2**(this.recoveries-1);await this.worker.recover();this.loadingSince=this.clock();}return;}this.loadingSince=null;
   if(phase==='two_factor'){this.phase='verification_required';this.message='Conclua a verificacao de dois fatores no Chrome.';return;}
   if(!this.worker.hasCredentials()){this.phase='credentials_required';this.message='Salve a conta no Hub e use Conectar para enviar o login ao PC.';return;}
   if(this.attempts>=3){this.phase='login_failed';this.message='Tres tentativas sem confirmar login. Confira a conta e use Retomar reconexao.';return;}
   await this.worker.prepareLogin();phase=await this.worker.inspect();
   if(['captcha','captcha_expired','captcha_blocked'].includes(phase)){this.manual(phase);return;}
   if(phase==='two_factor'){this.phase='verification_required';this.message='Conclua a verificacao de dois fatores no Chrome.';return;}
   if(phase!=='login')return;
   this.attempts++;this.phase='reconnecting';this.message='Tentando reconectar ao UniPlay.';
   this.nextAttempt=this.clock()+Math.min(120000,30000*2**(this.attempts-1));
   await this.worker.submitLogin();
  }catch{this.failures++;this.phase=this.failures>=3?'connection_failed':'retrying';this.message=this.failures>=3?'Tres falhas de conexao. Confira a rede e use Retomar reconexao.':'Painel ou rede indisponivel. Nova tentativa com espera progressiva.';this.nextAttempt=this.clock()+Math.min(120000,30000*2**(this.failures-1));}
 }
}
module.exports={Monitor};
