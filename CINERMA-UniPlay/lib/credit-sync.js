'use strict';
const validBalance=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100000000;
class CreditSync {
 constructor(worker,{clock=Date.now,intervalMs=600000,retryMs=30000}={}){this.worker=worker;this.clock=clock;this.intervalMs=intervalMs;this.retryMs=retryMs;this.nextAttempt=0;this.state='waiting';}
 async step(){
  if(this.clock()<this.nextAttempt)return;
  const report=await this.worker.report();
  if(!report.authenticated){this.state='disconnected';return;}
  const age=this.clock()-Date.parse(report.creditsReadAt);
  if(validBalance(report.credits)&&Number.isFinite(age)&&age>=0&&age<this.intervalMs){this.state='current';return;}
  this.nextAttempt=this.clock()+this.retryMs;
  try{
   const value=await this.worker.refreshCredits();
   if(!validBalance(value))throw Error('Saldo nao identificado.');
   this.nextAttempt=this.clock()+this.intervalMs;this.state='current';
  }catch{this.worker.invalidateCredits?.();this.state='retrying';}
 }
}
module.exports={CreditSync,validBalance};
