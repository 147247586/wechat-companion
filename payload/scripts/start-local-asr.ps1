param(
  [string]$Workspace = 'D:\wechatagent\data\workspace',
  [string]$Python = 'D:\Python\pythonw.exe'
)
$server = Join-Path $Workspace 'scripts\local-asr-server.py'
$log = Join-Path $Workspace 'state\logs\local-asr.log'
if (Get-NetTCPConnection -State Listen -LocalPort 11231 -ErrorAction SilentlyContinue) { exit 0 }
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Start-Process -FilePath $Python -ArgumentList @($server) -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
