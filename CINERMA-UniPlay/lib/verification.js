'use strict';
// Observation only: no CAPTCHA input, audio requests or response-token changes.
async function observeVerification(page){
 let expired=false;
 for(const frame of page.frames()){
  try{
   const url=new URL(frame.url());
   if(url.protocol!=='https:'||!['www.google.com','www.recaptcha.net'].includes(url.hostname)||!url.pathname.startsWith('/recaptcha/'))continue;
   const text=await frame.locator('body').innerText({timeout:1000});
   if(/automated queries|try again later|consultas automatizadas|tente novamente mais tarde/i.test(text))return 'blocked';
   if(/verification expired|challenge.*expired|verifica[çc][aã]o expirou|desafio.*expirou/i.test(text))expired=true;
  }catch{/* Unreadable verification still requires human input. */}
 }
 if(expired)return 'expired';
 const ready=await page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(els=>els.some(el=>Boolean(el.value&&el.value.trim())));
 return ready?'ready':'required';
}
module.exports={observeVerification};
