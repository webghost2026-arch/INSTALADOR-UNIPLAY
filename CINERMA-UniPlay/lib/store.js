'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process');
function crypt(text,decrypt=false){
  if(process.platform!=='win32')throw Error('Use o Windows para proteger a chave.');
  const expression=decrypt?'[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))':'[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  return new Promise((resolve,reject)=>{
    const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); '+expression],{windowsHide:true,timeout:15000},(err,out)=>err?reject(Error('Nao foi possivel ler/proteger a chave no Windows.')):resolve(out.trim()));
    child.stdin.on('error',()=>{});child.stdin.end(text);
  });
}
class Store{
  constructor(root){this.root=root;this.file=path.join(root,'connection.json');}
  async load(){let value;try{value=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}return {hub:value.hub,token:await crypt(value.encryptedToken,true)};}
  async save(value){await fs.mkdir(this.root,{recursive:true});const temp=this.file+'.tmp';await fs.writeFile(temp,JSON.stringify({hub:value.hub,encryptedToken:await crypt(value.token)}),{mode:0o600});await fs.rename(temp,this.file);}
}
Store.prototype.saveAccount=async function(hub,credentials){
 await fs.mkdir(this.root,{recursive:true});
 const record={hub,encryptedAccount:await crypt(JSON.stringify(credentials))};
 const file=path.join(this.root,'account.json');await fs.writeFile(file+'.tmp',JSON.stringify(record),{mode:0o600});await fs.rename(file+'.tmp',file);
};
Store.prototype.loadAccount=async function(hub){
 let record;try{record=JSON.parse(await fs.readFile(path.join(this.root,'account.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(record.hub!==hub)return null;return JSON.parse(await crypt(record.encryptedAccount,true));
};
module.exports={Store};

