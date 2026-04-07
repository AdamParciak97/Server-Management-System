# SMS Agent installer for Windows
# Usage: .\install-agent.ps1 -ServerURL https://server:8443 -Token <token>
# Requires: Run as Administrator

param(
    [Parameter(Mandatory=$true)]
    [string]$ServerURL,

    [Parameter(Mandatory=$true)]
    [string]$Token,

    [string]$InstallDir = "C:\Program Files\SMS-Agent",
    [string]$ConfigDir  = "C:\ProgramData\SMS-Agent",
    [string]$DataDir    = "C:\ProgramData\SMS-Agent\data",
    [string]$AgentBinary = "sms-agent-windows-amd64.exe",
    [string]$ServiceName = "SMSAgent"
)

$ErrorActionPreference = "Stop"

Write-Host "[*] Installing SMS Agent..." -ForegroundColor Cyan

# Check admin
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

# Create directories
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# Copy binary
$binaryDest = Join-Path $InstallDir "sms-agent.exe"
if (Test-Path ".\$AgentBinary") {
    Copy-Item ".\$AgentBinary" $binaryDest -Force
    Write-Host "    Binary installed: $binaryDest"
} else {
    try {
        Invoke-WebRequest -Uri "$ServerURL/api/packages/latest/agent-windows" -OutFile $binaryDest -SkipCertificateCheck
        Write-Host "    Binary downloaded: $binaryDest"
    } catch {
        Write-Warning "Agent binary not found locally and download failed: $AgentBinary"
    }
}

# Write config
$configPath = Join-Path $ConfigDir "config.yaml"
$configDirYaml = $ConfigDir -replace '\\','/'
$dataDirYaml = $DataDir -replace '\\','/'
@"
server:
  url: '$ServerURL'
  ca_cert: '$configDirYaml/ca.crt'
  client_cert: '$configDirYaml/agent.crt'
  client_key: '$configDirYaml/agent.key'

agent:
  registration_token: '$Token'
  poll_interval_seconds: 60
  command_timeout_seconds: 1800
  buffer_db: '$dataDirYaml/buffer.db'
  service_name: '$ServiceName'
  log_file: '$configDirYaml/agent.log'
  log_level: 'info'
  health_port: 9100
  version: '1.0.0'
"@ | Set-Content $configPath -Encoding UTF8
Write-Host "    Config written: $configPath"

# Secure config file
$acl = Get-Acl $configPath
$acl.SetAccessRuleProtection($true, $false)
$adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM","FullControl","Allow")
$acl.SetAccessRule($adminRule)
Set-Acl $configPath $acl

# Download CA cert (optional - skip TLS verification for bootstrap)
$caPath = Join-Path $ConfigDir "ca.crt"
if (Test-Path ".\ca.crt") {
    Copy-Item ".\ca.crt" $caPath -Force
    Write-Host "    CA certificate copied from local bundle"
} else {
    try {
        Invoke-WebRequest -Uri "$ServerURL/api/ca.crt" -OutFile $caPath -SkipCertificateCheck -ErrorAction SilentlyContinue
        Write-Host "    CA certificate downloaded"
    } catch {
        Write-Warning "Could not download CA certificate. Copy certs/ca.crt to $ConfigDir\ca.crt manually."
    }
}

# Check for agent certificates
if (Test-Path ".\agent.crt") {
    Copy-Item ".\agent.crt" (Join-Path $ConfigDir "agent.crt") -Force
    Copy-Item ".\agent.key" (Join-Path $ConfigDir "agent.key") -Force
    Write-Host "    Agent certificates installed"
} else {
    Write-Warning "No agent certificates found. Generate them on the server and copy to $ConfigDir"
}

# Install Windows Service
if (Test-Path $binaryDest) {
    # Remove existing service if present
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Seconds 2
    }

    $binPath = "`"$binaryDest`" -config `"$configPath`""
    New-Service -Name $ServiceName -BinaryPathName $binPath -DisplayName "SMS Server Management Agent" -StartupType Automatic -Description "Monitors system state and executes management commands from SMS server"
    sc.exe description $ServiceName "Monitors system state and executes management commands from SMS server" | Out-Null

    # Configure failure recovery: restart on failure
    sc.exe failure $ServiceName reset= 60 actions= restart/10000/restart/30000/restart/60000 | Out-Null

    Start-Service -Name $ServiceName
    Write-Host "    Service '$ServiceName' installed and started" -ForegroundColor Green
} else {
    Write-Warning "Skipping service installation: binary not found at $binaryDest"
}

Write-Host ""
Write-Host "[*] SMS Agent installation complete!" -ForegroundColor Green
Write-Host "    Service status: Get-Service $ServiceName"
Write-Host "    Event Log:      Get-EventLog -LogName Application -Source $ServiceName"
Write-Host "    Health:         Invoke-WebRequest http://localhost:9100/health"
Write-Host "    Config:         $configPath"
