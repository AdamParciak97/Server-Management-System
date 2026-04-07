param(
    [string]$Image = "golang:1.23-alpine"
)

$ErrorActionPreference = "Stop"

$ROOT = Split-Path $PSScriptRoot -Parent
Set-Location $ROOT

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found in PATH"
}

New-Item -ItemType Directory -Force -Path "bin" | Out-Null

$buildScript = @'
set -e
apk add --no-cache git >/dev/null
go mod download
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/sms-agent-linux-amd64 ./agent/
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o bin/sms-agent-linux-arm64 ./agent/
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -o bin/sms-agent-windows-amd64.exe ./agent/
'@

docker run --rm `
    -v "${ROOT}:/src" `
    -w /src `
    $Image `
    sh -c $buildScript

if ($LASTEXITCODE -ne 0) {
    throw "agent build failed"
}

Write-Host "Built agent artifacts:" -ForegroundColor Green
Write-Host "  bin/sms-agent-linux-amd64"
Write-Host "  bin/sms-agent-linux-arm64"
Write-Host "  bin/sms-agent-windows-amd64.exe"
