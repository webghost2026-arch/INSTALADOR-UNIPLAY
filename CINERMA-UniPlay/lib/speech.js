'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process');
class Speech {
 constructor({directory=path.join(__dirname,'..','speech'),dataRoot,runner=execFile}={}){this.directory=directory;this.dataRoot=dataRoot;this.runner=runner;}
 async ready(){try{await fs.access(path.join(this.directory,'whisper-cli.exe'));await fs.access(path.join(this.directory,'ggml-tiny-q5_1.bin'));return true;}catch{return false;}}
 async transcribe(bytes,{signal}={}){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>4*1024*1024)throw Error('Audio invalido.');
  if(!await this.ready())throw Error('Reconhecimento local nao instalado.');
  const tempRoot=path.join(this.dataRoot,'speech-temp');await fs.mkdir(tempRoot,{recursive:true});
  const dir=await fs.mkdtemp(path.join(tempRoot,'audio-')),audio=path.join(dir,'input.mp3'),out=path.join(dir,'result');
  try{
   signal?.throwIfAborted();
   await fs.writeFile(audio,bytes,{mode:0o600});
   await new Promise((resolve,reject)=>{this.runner(path.join(this.directory,'whisper-cli.exe'),['-m',path.join(this.directory,'ggml-tiny-q5_1.bin'),'-f',audio,'-l','auto','-t','2','-ng','-otxt','-of',out,'-d','30000'],{windowsHide:true,cwd:this.directory,timeout:45000,maxBuffer:1048576,signal},err=>err?reject(Error('Reconhecimento local indisponivel.')):resolve());});
   signal?.throwIfAborted();
   const raw=(await fs.readFile(out+'.txt','utf8')).trim();
   if(!raw||raw.length>256||/\[[^\]]+\]|\([^)]*(?:music|silence|inaudible)[^)]*\)/i.test(raw))throw Error('Audio inconclusivo.');
   const text=raw.normalize('NFKC').replace(/[^\p{L}\p{N}\s'-]/gu,' ').replace(/\s+/g,' ').trim();
   if(!text)throw Error('Audio inconclusivo.');return text;
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 }
}
module.exports={Speech};
