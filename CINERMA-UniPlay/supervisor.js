'use strict';
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=process.env.CINERMA_LOCAL_DATA_DIR||path.join(process.env.LOCALAPPDATA||__dirname,'CINERMA-UniPlay');
fs.mkdirSync(root,{recursive:true});
const logfile=path.join(root,'executor.log');
try{if(fs.statSync(logfile).size>1048576)fs.renameSync(logfile,logfile+'.anterior');}catch(e){if(e.code!=='ENOENT'){}}
let stopping=false,child=null,timer=null;
function start(){
 if(stopping)return;
 const fd=fs.openSync(logfile,'a');
 child=spawn(process.execPath,[path.join(__dirname,'server.js')],{cwd:__dirname,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);
 child.once('error',()=>{});
 child.once('close',code=>{child=null;if(stopping||code===0)return;timer=setTimeout(start,10000);});
}
function stop(){stopping=true;clearTimeout(timer);child?.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);start();
