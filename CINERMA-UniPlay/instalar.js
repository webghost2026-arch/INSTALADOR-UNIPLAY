'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process');
const {enroll}=require('./lib/enrollment'),{Store}=require('./lib/store'),{encodedLauncher,launchCommand}=require('./lib/launcher');
const {ensureChrome,stopExisting}=require('./lib/prerequisites');
const FILES=['preparar-atualizacao.ps1','package.json','package-lock.json','server.js','supervisor.js','Iniciar.cmd','abrir.js','LEIA-ME.txt'];
const DIRS=['lib','recovered','runtime','node_modules','speech'];
async function validate(source){
 for(const file of [...FILES,'runtime/node.exe','runtime/VC_redist.x64.exe','speech/ggml.dll','speech/ggml-base.dll','speech/ggml-cpu-x64.dll','speech/whisper.dll','speech/whisper-cli.exe','speech/ggml-tiny-q5_1.bin','node_modules/playwright/package.json','node_modules/playwright-core/package.json'])await fs.access(path.join(source,file));
 for(const dir of DIRS)if(!(await fs.stat(path.join(source,dir))).isDirectory())throw Error('Pacote incompleto: '+dir);
}
function checkStopped(){return new Promise((resolve,reject)=>{
 const server=net.createServer();server.once('error',()=>reject(Error('Feche o executor antigo com Ctrl+C antes de instalar. A porta 3217 esta ocupada ou indisponivel.')));
 server.listen(3217,'127.0.0.1',()=>server.close(resolve));
});}
async function copyApplication(source,target){
 await validate(source);await fs.mkdir(target,{recursive:true});
 for(const file of FILES)await fs.copyFile(path.join(source,file),path.join(target,file));
 for(const dir of DIRS)await fs.cp(path.join(source,dir),path.join(target,dir),{recursive:true,errorOnExist:true,force:false});
}
function ensureSpeechRuntime(source){
 const system=path.join(process.env.SystemRoot||'C:\\Windows','System32');
 const missing=['MSVCP140.dll','VCRUNTIME140.dll','VCRUNTIME140_1.dll'].some(name=>!require('node:fs').existsSync(path.join(system,name)));
 if(missing){
  console.log('Instalando componente oficial Microsoft Visual C++. O Windows pode pedir sua permissao.');
  const script="$p=Start-Process -FilePath $env:CINERMA_VC_INSTALL -ArgumentList '/install','/passive','/norestart' -Wait -PassThru; exit $p.ExitCode";
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'pipe',env:{...process.env,CINERMA_VC_INSTALL:path.join(source,'runtime/VC_redist.x64.exe')}});}
  catch(e){if(e.status!==3010)throw Error('Instalacao do componente Microsoft nao foi concluida. Abra runtime/VC_redist.x64.exe e tente novamente.');}
 }
 try{execFileSync(path.join(source,'speech/whisper-cli.exe'),['-h'],{windowsHide:true,stdio:'pipe',timeout:15000});}
 catch{throw Error('O reconhecimento local nao abriu. Instale runtime/VC_redist.x64.exe e tente novamente. Se o Windows solicitar reinicio, reinicie o computador.');}
}

async function main(){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('Use Windows de 64 bits neste pacote.');
 if(!process.env.LOCALAPPDATA)throw Error('Pasta do usuario Windows nao encontrada.');
 const root=path.join(process.env.LOCALAPPDATA,'CINERMA-UniPlay'),app=path.join(root,'App');
 if(path.resolve(__dirname).toLowerCase()===path.resolve(app).toLowerCase())throw Error('Instale a partir da pasta extraida do download.');
 await validate(__dirname);await ensureChrome(__dirname);await fs.mkdir(root,{recursive:true});
 const stamp=Date.now(),staging=path.join(root,'App-install-'+stamp),backup=path.join(root,'App-anterior-'+stamp);
 await copyApplication(__dirname,staging);
 await enroll({source:__dirname,dataRoot:root,store:new Store(root)});
 stopExisting(__dirname);await checkStopped();
 let previous=false;
 try{await fs.rename(app,backup);previous=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 try{await fs.rename(staging,app);}catch(e){if(previous)await fs.rename(backup,app);throw e;}
 const script="$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $ps=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; foreach($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Startup'))){ $link=$shell.CreateShortcut((Join-Path $folder 'CINERMA UniPlay.lnk')); $link.TargetPath=$ps; $link.Arguments=$env:CINERMA_LAUNCH_ARGS; $link.WorkingDirectory=$env:CINERMA_APP_DIR; $link.WindowStyle=7; $link.Save() }";
 try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'pipe',env:{...process.env,CINERMA_LAUNCH_ARGS:encodedLauncher(app),CINERMA_APP_DIR:app}});}
 catch{throw Error('Arquivos instalados, mas nao foi possivel criar os atalhos. Abra '+path.join(app,'Iniciar.cmd'));}
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',launchCommand(app)],{windowsHide:true,stdio:'ignore'});
 console.log('INSTALACAO CONCLUIDA\nExecutor vinculado ao Hub e iniciado em segundo plano.\nA conexao sera retomada automaticamente usando a conta salva.\nSe for o primeiro uso, cadastre a conta em Paineis > UniPlay e franquias.\nNenhuma chave precisa ser copiada.\nPedidos IPTV liberados pelo Hub sao processados automaticamente. P2P permanece pendente.');
 if(previous)console.log('Aplicativo anterior preservado em: '+backup);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={validate,copyApplication,FILES,DIRS};
