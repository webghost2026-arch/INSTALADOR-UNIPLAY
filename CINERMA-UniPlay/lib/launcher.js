'use strict';
const path=require('node:path');
function quote(value){return "'"+value.replace(/'/g,"''")+"'";}
function launchCommand(app){
 return 'Start-Process -FilePath '+quote(path.join(app,'runtime','node.exe'))+' -ArgumentList '+quote('"'+path.join(app,'supervisor.js')+'"')+' -WorkingDirectory '+quote(app)+' -WindowStyle Hidden';
}
function encodedLauncher(app){return '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+Buffer.from(launchCommand(app),'utf16le').toString('base64');}
module.exports={launchCommand,encodedLauncher};
