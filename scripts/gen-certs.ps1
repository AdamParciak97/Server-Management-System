param(
    [string]$CertsDir = "certs",
    [string]$ServerCN = "new-test.test.pl",
    [string[]]$ServerDns = @("new-test.test.pl"),
    [string[]]$ServerIps = @("192.168.100.80")
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $CertsDir | Out-Null

$serverExtPath = Join-Path $CertsDir "server.ext"
$altNameLines = New-Object System.Collections.Generic.List[string]
$dnsIndex = 1
foreach ($dns in $ServerDns) {
    if ($dns) {
        $altNameLines.Add("DNS.$dnsIndex = $dns")
        $dnsIndex++
    }
}
$ipIndex = 1
foreach ($ip in $ServerIps) {
    if ($ip) {
        $altNameLines.Add("IP.$ipIndex = $ip")
        $ipIndex++
    }
}

@(
    "basicConstraints = CA:FALSE"
    "keyUsage = digitalSignature, keyEncipherment"
    "extendedKeyUsage = serverAuth"
    "subjectAltName = @alt_names"
    ""
    "[alt_names]"
    $altNameLines
) | Set-Content $serverExtPath -Encoding ascii

Write-Host "[*] Generating CA..." -ForegroundColor Cyan
& openssl genrsa -out (Join-Path $CertsDir "ca.key") 4096 | Out-Null
& openssl req -new -x509 -days 3650 `
    -key (Join-Path $CertsDir "ca.key") `
    -out (Join-Path $CertsDir "ca.crt") `
    -subj "/C=PL/O=SMS CA/CN=SMS Root CA" | Out-Null

Write-Host "[*] Generating server certificate..." -ForegroundColor Cyan
& openssl genrsa -out (Join-Path $CertsDir "server.key") 2048 | Out-Null
& openssl req -new `
    -key (Join-Path $CertsDir "server.key") `
    -out (Join-Path $CertsDir "server.csr") `
    -subj "/C=PL/O=SMS/CN=$ServerCN" | Out-Null
& openssl x509 -req -days 825 `
    -in (Join-Path $CertsDir "server.csr") `
    -CA (Join-Path $CertsDir "ca.crt") `
    -CAkey (Join-Path $CertsDir "ca.key") `
    -CAcreateserial `
    -extfile $serverExtPath `
    -out (Join-Path $CertsDir "server.crt") | Out-Null

Remove-Item (Join-Path $CertsDir "server.csr") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $CertsDir "ca.srl") -Force -ErrorAction SilentlyContinue
Remove-Item $serverExtPath -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Certificates created:" -ForegroundColor Green
Write-Host "  CA private key:      $(Join-Path $CertsDir 'ca.key')"
Write-Host "  CA certificate:      $(Join-Path $CertsDir 'ca.crt')"
Write-Host "  Server private key:  $(Join-Path $CertsDir 'server.key')"
Write-Host "  Server certificate:  $(Join-Path $CertsDir 'server.crt')"
Write-Host ""
Write-Host "Use the per-agent script for client certificates:" -ForegroundColor Yellow
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\gen-agent-cert.ps1 -AgentId <uuid>"
