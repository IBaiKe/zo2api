#Requires -Version 5.1
<#
.SYNOPSIS
  zo2api 一键部署脚本（Windows PowerShell / pwsh）

.DESCRIPTION
  与 scripts/install.sh 功能等价的 5 步幂等部署：
    1. 检查 docker + docker compose
    2. 复制 .env.example -> .env（若不存在）
    3. 生成 PROXY_API_KEY（若为空）
    4. docker compose up -d --build
    5. 轮询 /health 最多 30s，打印 base URL 与 key

.EXAMPLE
  # 在 PowerShell 中执行（首次需放行脚本签名策略）：
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\scripts\install.ps1

.NOTES
  设计与 install.sh 严格对齐，行为差异为零。
#>

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

# ----------------------------------------------------------------------------
#  辅助：彩色输出（遵守 NO_COLOR）
# ----------------------------------------------------------------------------
$UseColor = -not [Environment]::GetEnvironmentVariable('NO_COLOR') -and $Host.UI.SupportsVirtualTerminal

function Write-Log  ($Msg) {
  if ($UseColor) { Write-Host "[zo2api] " -ForegroundColor Cyan -NoNewline; Write-Host $Msg }
  else           { Write-Host "[zo2api] $Msg" }
}
function Write-Ok   ($Msg) { if ($UseColor) { Write-Host "✓ " -ForegroundColor Green -NoNewline; Write-Host $Msg } else { Write-Host "OK  $Msg" } }
function Write-Warn ($Msg) { if ($UseColor) { Write-Host "! " -ForegroundColor Yellow -NoNewline; Write-Host $Msg } else { Write-Host "!   $Msg" } }
function Die        ($Msg) { if ($UseColor) { Write-Host "✗ $Msg" -ForegroundColor Red } else { Write-Host "ERR $Msg" }; exit 1 }

# ----------------------------------------------------------------------------
#  切到仓库根
# ----------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir '..')
Set-Location $RepoRoot

# ============================================================================
#  Step 1: docker + compose
# ============================================================================
Write-Log "Step 1/5: 检查 docker 与 docker compose"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Die "未找到 docker。安装见 https://docs.docker.com/desktop/install/windows-install/"
}

try { docker info | Out-Null } catch {
  Die "docker daemon 未运行，请先启动 Docker Desktop"
}

$Compose = $null
try {
  docker compose version | Out-Null
  $Compose = @('docker', 'compose')
} catch {
  if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $Compose = @('docker-compose')
    Write-Warn "使用 legacy docker-compose v1，建议升级到 docker compose v2"
  } else {
    Die "未找到 docker compose"
  }
}
Write-Ok "docker + compose 可用"

# ============================================================================
#  Step 2: 准备 .env
# ============================================================================
Write-Log "Step 2/5: 准备 .env"

if (-not (Test-Path '.env')) {
  if (-not (Test-Path '.env.example')) { Die ".env.example 缺失，仓库不完整" }
  Copy-Item '.env.example' '.env'
  Write-Ok "已从 .env.example 复制到 .env"
} else {
  Write-Ok ".env 已存在，保留"
}

# ============================================================================
#  Step 3: 生成 PROXY_API_KEY（若为空）
# ============================================================================
Write-Log "Step 3/5: 检查 PROXY_API_KEY"

$EnvLines = Get-Content '.env'
$KeyLine = $EnvLines | Where-Object { $_ -match '^PROXY_API_KEY=' } | Select-Object -First 1
$CurrentKey = ''
if ($KeyLine) { $CurrentKey = ($KeyLine -replace '^PROXY_API_KEY=', '').Trim() }

$KeyCreated = $false
if ([string]::IsNullOrEmpty($CurrentKey)) {
  # 12 字节 -> 24 hex 字符
  $bytes = New-Object byte[] 12
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $NewKey = "sk-ant-proxy-$hex"

  $Updated = $EnvLines | ForEach-Object {
    if ($_ -match '^PROXY_API_KEY=') { "PROXY_API_KEY=$NewKey" } else { $_ }
  }
  # 保留 LF，避免 Windows CRLF 污染容器内 .env 读取
  [System.IO.File]::WriteAllText((Resolve-Path '.env'), ($Updated -join "`n") + "`n")
  $CurrentKey = $NewKey
  $KeyCreated = $true
  Write-Ok "生成新 PROXY_API_KEY"
} else {
  Write-Ok "PROXY_API_KEY 已存在，保留"
}

# ============================================================================
#  Step 4: docker compose up
# ============================================================================
Write-Log "Step 4/5: 构建并启动容器"
& $Compose[0] $Compose[1..($Compose.Length - 1)] up -d --build
if ($LASTEXITCODE -ne 0) { Die "docker compose up 失败" }
Write-Ok "容器已启动"

# ============================================================================
#  Step 5: 健康轮询
# ============================================================================
Write-Log "Step 5/5: 等待 /health 就绪"

$PortLine = $EnvLines | Where-Object { $_ -match '^HOST_PORT=' } | Select-Object -First 1
$HostPort = '3000'
if ($PortLine) {
  $val = ($PortLine -replace '^HOST_PORT=', '').Trim()
  if (-not [string]::IsNullOrEmpty($val)) { $HostPort = $val }
}
$HealthUrl = "http://localhost:$HostPort/health"

$Ready = $false
for ($i = 1; $i -le 30; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $Ready = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}

if (-not $Ready) {
  Write-Warn "30s 内未就绪，最近日志："
  & $Compose[0] $Compose[1..($Compose.Length - 1)] logs --tail 30 zo2api
  Die "服务未通过 /health，请排查"
}
Write-Ok "/health OK"

# ============================================================================
#  打印接入信息
# ============================================================================
Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  zo2api is up'                              -ForegroundColor Green
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ('  Base URL : http://localhost:{0}'           -f $HostPort) -ForegroundColor Cyan
Write-Host ('  Endpoint : http://localhost:{0}/v1/messages' -f $HostPort) -ForegroundColor Cyan
if ($KeyCreated) {
  Write-Host ('  API Key  : {0}   (刚生成，请妥善保管)' -f $CurrentKey) -ForegroundColor Yellow
} else {
  $fp = $CurrentKey.Substring(0,6) + '...' + $CurrentKey.Substring($CurrentKey.Length - 4)
  Write-Host ('  API Key  : {0}   (fingerprint；全值在 .env)' -f $fp) -ForegroundColor Yellow
}
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''
$ComposeStr = $Compose -join ' '
Write-Host "实时日志:  $ComposeStr logs -f zo2api"
Write-Host "停止服务:  $ComposeStr down"
Write-Host ''
