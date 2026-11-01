param(
  [switch]$Apply,
  [string]$Workspace = 'D:\wechatagent\data\workspace',
  [string]$AppProject = 'D:\wechatagent\app\resources\project'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $here 'payload'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $here "backups\$stamp"

function Check($name, $ok, $detail = '') {
  if ($ok) { $mark = 'OK  ' } else { $mark = 'MISS' }
  Write-Host "[$mark] $name $detail"
}

Check 'workspace' (Test-Path $Workspace) $Workspace
Check 'app/resources/project' (Test-Path $AppProject) $AppProject
$tokenFile = Join-Path $Workspace 'state/social-dsh-token.txt'
$readerFile = Join-Path $Workspace 'state/wechat-io-config.json'
Check 'DSH token' (Test-Path $tokenFile)
Check 'reader config' (Test-Path $readerFile)

$health = $false
if (Test-Path $tokenFile) {
  try {
    $token = (Get-Content $tokenFile -Raw).Trim()
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11230/health' -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 5
    $health = $r.StatusCode -eq 200
  } catch {}
}
Check 'DSH health' $health 'http://127.0.0.1:11230'

$bridge = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'social-bridge' }
Check 'Bridge process' ([bool]$bridge) 'social-bridge.js'

$wechat = Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue
Check 'WeChat process' ([bool]$wechat)
Check 'WeChatAgent process' ([bool](Get-Process -Name WeChatAgent -ErrorAction SilentlyContinue))

$hookDirs = Get-ChildItem (Join-Path $Workspace 'state/hook') -Directory -ErrorAction SilentlyContinue
$hookVersion = $hookDirs | Where-Object { $_.Name -match 'wechat-' } | Select-Object -First 1
if ($hookVersion) { $hookName = $hookVersion.Name } else { $hookName = 'missing' }
Check 'Hook version' ([bool]$hookVersion) $hookName
if ($hookVersion -and $hookVersion.Name -notmatch '4\.1\.15') {
  Write-Host '[WARN] Hook is not 4.1.15.x; inbound voice record events are unavailable.'
}

$ollama = 'D:\ollama\cpu\ollama.exe'
if (Test-Path $ollama) {
  $models = & $ollama list 2>$null | Out-String
  Check 'Ollama qwen2.5vl:3b' ($models -match 'qwen2\.5vl:3b')
} else {
  Check 'Ollama' $false $ollama
}

$configFile = Join-Path $here 'config.json'
if (Test-Path $configFile) {
  try {
    $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($cfg.voiceConfig) { Check 'voice config' (Test-Path $cfg.voiceConfig) $cfg.voiceConfig }
    if ($cfg.voiceRef) { Check 'voice reference' (Test-Path $cfg.voiceRef) $cfg.voiceRef }
  } catch {
    Write-Host "[WARN] config.json is invalid: $($_.Exception.Message)"
  }
} else {
  Write-Host '[INFO] config.json not found; skipping voice path checks.'
}

$files = Get-ChildItem $payload -Recurse -File | Where-Object { $_.FullName -notmatch '\\backups\\' }
Write-Host "`nPayload files: $($files.Count)"
if (-not $Apply) {
  Write-Host 'DRY RUN: no files copied. Use -Apply to install.' -ForegroundColor Yellow
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($payload.Length + 1)
    Write-Host "  $rel"
  }
  exit 0
}

foreach ($root in @($Workspace, $AppProject)) {
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($payload.Length + 1)
    $target = Join-Path $root $rel
    if (Test-Path $target) {
      $rootLeaf = Split-Path $root -Leaf
      $backupTarget = Join-Path $backup "$rootLeaf/$rel"
      New-Item -ItemType Directory -Force -Path (Split-Path $backupTarget -Parent) | Out-Null
      Copy-Item $target $backupTarget -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item $file.FullName $target -Force
  }
  Write-Host "Applied to $root"
}

Write-Host "`nBackup: $backup" -ForegroundColor Cyan

# Install / enable the inbound speech plugin and local ASR service.
$speechSrc = Join-Path $Workspace 'optional-extensions/speech-recognition'
$speechDst = Join-Path $Workspace 'plugins/speech-recognition'
if (-not (Test-Path $speechSrc)) {
  Write-Host '[WARN] optional speech-recognition plugin not found; inbound voice stays disabled until it is installed from WeChatAgent.'
}
if (Test-Path $speechSrc) {
  if (Test-Path $speechDst) {
    $speechBackup = Join-Path $backup 'plugins/speech-recognition'
    New-Item -ItemType Directory -Force -Path (Split-Path $speechBackup -Parent) | Out-Null
    Copy-Item $speechDst $speechBackup -Recurse -Force
    Remove-Item $speechDst -Recurse -Force
  }
  Copy-Item $speechSrc $speechDst -Recurse -Force
  Write-Host 'Speech plugin installed: plugins/speech-recognition'
}

$nodePath = 'D:\nodejs\nodejs\node.exe'
if (-not (Test-Path $nodePath)) { $nodePath = 'node' }
$enableScript = Join-Path $Workspace 'scripts/enable-speech-plugin.mjs'
if (Test-Path $enableScript) {
  & $nodePath $enableScript $Workspace
}

$asrStart = Join-Path $Workspace 'scripts/start-local-asr.ps1'
if (Test-Path $asrStart) {
  powershell -NoProfile -ExecutionPolicy Bypass -File $asrStart -Workspace $Workspace
  Write-Host 'Local ASR start requested on 127.0.0.1:11231'
}

$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'WeChatAgentLocalASR.vbs'
if (-not (Test-Path $vbs)) {
  $startPath = Join-Path $Workspace 'scripts\start-local-asr.ps1'
  $vbsText = 'Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' + $startPath + '""", 0, False'
  Set-Content -Path $vbs -Value $vbsText -Encoding ASCII
  Write-Host "Startup entry created: $vbs"
}

Write-Host 'Next: restart WeChatAgent and DSH, then send a WeChat voice message.' -ForegroundColor Yellow
Write-Host 'Verify with: node verify.mjs' -ForegroundColor Yellow
