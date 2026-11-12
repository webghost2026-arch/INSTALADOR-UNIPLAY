'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
async function findChrome({env=process.env,access=fs.access}={}){
 for(const base of [env.ProgramFiles,env['ProgramFiles(x86)'],env.LOCALAPPDATA].filter(Boolean)){
  const file=path.join(base,'Google','Chrome','Application','chrome.exe');
  try{await access(file);return file;}catch{}
 }
 return null;
}
async function ensureChrome(source,{env=process.env,access=fs.access,run=execFileSync}={}){
 const options={env,access};if(await findChrome(options))return;
 console.log('Google Chrome ausente. Baixando e instalando o navegador oficial. Aguarde.');
 try{run(path.join(source,'runtime','node.exe'),[path.join(source,'node_modules','playwright','cli.js'),'install','chrome'],{windowsHide:true,stdio:'inherit',timeout:300000,env});}
 catch{throw Error('Nao foi possivel instalar o Chrome. Confira a internet e aceite a permissao do Windows, se solicitada. Depois abra Instalar novamente.');}
 if(!await findChrome(options))throw Error('A instalacao do Chrome ainda nao foi concluida. Reinicie o Windows se solicitado e abra Instalar novamente.');
}
function stopExisting(source,{run=execFileSync,env=process.env}={}){
 run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(source,'preparar-atualizacao.ps1')],{windowsHide:true,stdio:'inherit',timeout:30000,env});
}
module.exports={findChrome,ensureChrome,stopExisting};
