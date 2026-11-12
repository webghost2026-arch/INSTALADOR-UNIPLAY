$ErrorActionPreference='Stop'
$appRoot=Join-Path $env:LOCALAPPDATA 'CINERMA-UniPlay\App'
$appDirectories=@($appRoot)
$startupLink=Join-Path ([Environment]::GetFolderPath('Startup')) 'CINERMA UniPlay.lnk'
if(Test-Path -LiteralPath $startupLink){
 $shell=New-Object -ComObject WScript.Shell
 $previousDirectory=$shell.CreateShortcut($startupLink).WorkingDirectory
 if($previousDirectory -and (Test-Path -LiteralPath (Join-Path $previousDirectory 'package.json'))){
  $package=Get-Content -LiteralPath (Join-Path $previousDirectory 'package.json') -Raw | ConvertFrom-Json
  if($package.name -in @('cinerma-uniplay-local-recuperado','cinerma-uniplay-local')){$appDirectories+=$previousDirectory}
 }
}
$processes=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -match '(supervisor|server)\.js'}
$matched=@($processes | Where-Object {
 $command=$_.CommandLine
 @($appDirectories | Where-Object {$command.IndexOf($_.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count -gt 0
} | Sort-Object @{Expression={if($_.CommandLine -match 'supervisor\.js'){0}else{1}}})
foreach($executorProcess in $matched){
 $live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$executorProcess.ProcessId)
 if($live -and $live.CommandLine -eq $executorProcess.CommandLine){
  & taskkill.exe /PID $executorProcess.ProcessId /T /F | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Nao foi possivel encerrar o executor anterior. Reinicie o Windows e tente instalar novamente.'}
 }
}
