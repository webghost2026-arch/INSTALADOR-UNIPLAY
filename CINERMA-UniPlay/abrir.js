'use strict';
const {execFileSync}=require('node:child_process'),{launchCommand}=require('./lib/launcher');
try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',launchCommand(__dirname)],{windowsHide:true,stdio:'ignore'});}
catch{console.error('Nao foi possivel iniciar o executor.');process.exitCode=1;}
