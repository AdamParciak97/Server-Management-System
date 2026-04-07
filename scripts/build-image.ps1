param(
    [string]$ImageName = "sms-server",
    [string]$ImageTag = "latest",
    [string]$PostgresImage = "postgres:16-alpine"
)

$ErrorActionPreference = "Stop"

$ROOT = Split-Path $PSScriptRoot -Parent
Set-Location $ROOT

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found in PATH"
}

$Date = Get-Date -Format "yyyyMMdd_HHmm"
$DeployDir = "sms-deploy"
$ArchiveName = "sms-deploy-$Date.tar.gz"

Write-Host "== SMS release build ==" -ForegroundColor Cyan
Write-Host "Date: $Date"

Write-Host "`n[1/6] Building agent binaries with Docker..." -ForegroundColor Yellow
powershell -ExecutionPolicy Bypass -File "scripts\build-agents.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "agent build failed"
}

Write-Host "`n[2/6] Checking postgres image..." -ForegroundColor Yellow
$pgImageId = docker images -q $PostgresImage
if (-not $pgImageId) {
    docker pull $PostgresImage
    if ($LASTEXITCODE -ne 0) {
        throw "failed to pull postgres image"
    }
} else {
    Write-Host "  Found local image: $PostgresImage"
}

Write-Host "`n[3/6] Building server image ${ImageName}:${ImageTag}..." -ForegroundColor Yellow
docker build `
    --no-cache `
    --file Dockerfile.server `
    --tag "${ImageName}:${ImageTag}" `
    --label "build.date=$Date" `
    .
if ($LASTEXITCODE -ne 0) {
    throw "server image build failed"
}
docker images "${ImageName}:${ImageTag}" --format "  Size: {{.Size}}"

Write-Host "`n[4/6] Exporting Docker images..." -ForegroundColor Yellow
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sms-build-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TmpDir | Out-Null
docker save "${ImageName}:${ImageTag}" -o (Join-Path $TmpDir "sms-server.tar")
docker save $PostgresImage -o (Join-Path $TmpDir "postgres.tar")

Write-Host "`n[5/6] Creating deployment bundle..." -ForegroundColor Yellow
if (Test-Path $DeployDir) {
    Remove-Item $DeployDir -Recurse -Force
}
New-Item -ItemType Directory -Path "$DeployDir\images" | Out-Null
New-Item -ItemType Directory -Path "$DeployDir\certs" | Out-Null
New-Item -ItemType Directory -Path "$DeployDir\agents" | Out-Null

Move-Item (Join-Path $TmpDir "sms-server.tar") "$DeployDir\images\"
Move-Item (Join-Path $TmpDir "postgres.tar") "$DeployDir\images\"
Remove-Item $TmpDir -Recurse -Force

Copy-Item "docker-compose.prod.yml" "$DeployDir\docker-compose.yml"
Copy-Item ".env.example" "$DeployDir\.env.example"
Copy-Item "scripts\server-deploy.sh" "$DeployDir\deploy.sh"

Copy-Item "bin\sms-agent-linux-amd64" "$DeployDir\agents\"
Copy-Item "bin\sms-agent-linux-arm64" "$DeployDir\agents\"
Copy-Item "bin\sms-agent-windows-amd64.exe" "$DeployDir\agents\"
Copy-Item "scripts\install-agent.sh" "$DeployDir\agents\"
Copy-Item "scripts\install-agent.ps1" "$DeployDir\agents\"
Copy-Item "agent\config.example.yaml" "$DeployDir\agents\config.example.yaml"

if ((Test-Path "certs\server.crt") -and (Test-Path "certs\server.key")) {
    Copy-Item "certs\server.crt","certs\server.key" "$DeployDir\certs\"
    Write-Host "  Included server TLS certificate files."
} else {
    Write-Warning "Server TLS certificate files not found in certs\."
}

if (Test-Path "certs\ca.crt") {
    Copy-Item "certs\ca.crt" "$DeployDir\certs\"
    Copy-Item "certs\ca.crt" "$DeployDir\agents\ca.crt"
    Write-Host "  Included CA certificate for agent bootstrap."
} else {
    Write-Warning "CA certificate not found in certs\."
}

$hashLines = New-Object System.Collections.Generic.List[string]
$filesToHash = Get-ChildItem "$DeployDir\images\*" -File
$filesToHash += Get-ChildItem "$DeployDir\agents\*" -File
$filesToHash += Get-Item "$DeployDir\.env.example","$DeployDir\docker-compose.yml","$DeployDir\deploy.sh"
foreach ($file in $filesToHash) {
    $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
    $relative = $file.FullName.Substring((Resolve-Path $DeployDir).Path.Length + 1).Replace("\", "/")
    $hashLines.Add("$hash  $relative")
}
"# SHA256 checksums" | Set-Content "$DeployDir\SHA256SUMS"
$hashLines | Add-Content "$DeployDir\SHA256SUMS"

Write-Host "`n[6/6] Compressing deployment bundle..." -ForegroundColor Yellow
docker run --rm `
    -v "${ROOT}:/work" `
    -w /work `
    alpine:3.19 `
    tar -czf $ArchiveName "$DeployDir/"
if ($LASTEXITCODE -ne 0) {
    throw "failed to create archive with Docker tar"
}
Remove-Item $DeployDir -Recurse -Force

$Size = "{0:N1} MB" -f ((Get-Item $ArchiveName).Length / 1MB)

Write-Host ""
Write-Host "Bundle ready:" -ForegroundColor Green
Write-Host "  Archive: $ArchiveName"
Write-Host "  Size:    $Size"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Copy $ArchiveName to the target server."
Write-Host "  2. Extract it and run deploy.sh inside sms-deploy/."
Write-Host "  3. Use files from sms-deploy/agents/ to install Linux or Windows agents."
