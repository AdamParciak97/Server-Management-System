param(
    [Parameter(Mandatory = $false)]
    [string]$AgentId = [guid]::NewGuid().ToString(),
    [string]$CertsDir = "certs",
    [string]$AgentCN,
    [string[]]$AgentDns = @(),
    [string[]]$AgentIps = @()
)

$ErrorActionPreference = "Stop"

if (-not $AgentCN) {
    $AgentCN = "agent-$AgentId"
}

$agentsDir = Join-Path $CertsDir "agents"
New-Item -ItemType Directory -Force -Path $agentsDir | Out-Null

$caCrt = Join-Path $CertsDir "ca.crt"
$caKey = Join-Path $CertsDir "ca.key"
if (-not (Test-Path $caCrt) -or -not (Test-Path $caKey)) {
    throw "Missing $caCrt or $caKey. Run scripts\gen-certs.ps1 or scripts/gen-certs.sh first."
}

$agentExt = Join-Path $agentsDir "$AgentId.ext"
$extLines = New-Object System.Collections.Generic.List[string]
@(
    "basicConstraints = CA:FALSE"
    "keyUsage = digitalSignature, keyEncipherment"
    "extendedKeyUsage = clientAuth"
) | ForEach-Object { [void]$extLines.Add($_) }

if ($AgentDns.Count -gt 0 -or $AgentIps.Count -gt 0) {
    [void]$extLines.Add("subjectAltName = @alt_names")
    [void]$extLines.Add("")
    [void]$extLines.Add("[alt_names]")

    $dnsIndex = 1
    foreach ($dns in $AgentDns) {
        if ($dns) {
            [void]$extLines.Add("DNS.$dnsIndex = $dns")
            $dnsIndex++
        }
    }

    $ipIndex = 1
    foreach ($ip in $AgentIps) {
        if ($ip) {
            [void]$extLines.Add("IP.$ipIndex = $ip")
            $ipIndex++
        }
    }
}

$extLines | Set-Content $agentExt -Encoding ascii

Write-Host "[*] Generating client certificate for agent: $AgentId" -ForegroundColor Cyan
& openssl genrsa -out (Join-Path $agentsDir "$AgentId.key") 2048 | Out-Null
& openssl req -new `
    -key (Join-Path $agentsDir "$AgentId.key") `
    -out (Join-Path $agentsDir "$AgentId.csr") `
    -subj "/C=PL/O=SMS/CN=$AgentCN" | Out-Null
& openssl x509 -req -days 825 `
    -in (Join-Path $agentsDir "$AgentId.csr") `
    -CA $caCrt `
    -CAkey $caKey `
    -CAcreateserial `
    -extfile $agentExt `
    -out (Join-Path $agentsDir "$AgentId.crt") | Out-Null

Remove-Item (Join-Path $agentsDir "$AgentId.csr") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $CertsDir "ca.srl") -Force -ErrorAction SilentlyContinue
Remove-Item $agentExt -Force -ErrorAction SilentlyContinue

Write-Host "Generated files:" -ForegroundColor Green
Write-Host "  Certificate: $(Join-Path $agentsDir "$AgentId.crt")"
Write-Host "  Private key: $(Join-Path $agentsDir "$AgentId.key")"
if ($AgentDns.Count -gt 0) {
    Write-Host "  DNS SANs:    $($AgentDns -join ', ')"
}
if ($AgentIps.Count -gt 0) {
    Write-Host "  IP SANs:     $($AgentIps -join ', ')"
}
Write-Host ""
Write-Host "Copy them to the target host as:" -ForegroundColor Yellow
Write-Host "  agent.crt"
Write-Host "  agent.key"
