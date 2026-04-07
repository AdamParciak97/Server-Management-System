package collector

import (
	"encoding/json"
	"runtime"
	"strings"

	"github.com/sms/server-mgmt/shared"
)

func CollectWindowsSecurityStatus() *shared.WindowsSecurityStatus {
	if runtime.GOOS != "windows" {
		return nil
	}

	out, err := runCmd("powershell", "-Command", `
		$profiles = @()
		if (Get-Command Get-NetFirewallProfile -ErrorAction SilentlyContinue) {
			try {
				$profiles = Get-NetFirewallProfile -ErrorAction Stop | Select-Object @{N='name';E={$_.Name}}, @{N='enabled';E={[bool]$_.Enabled}}
			} catch {}
		}

		$defenderEnabled = $false
		$realTimeEnabled = $false
		$signatureVersion = $null
		$lastQuickScan = $null

		if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) {
			try {
				$defender = Get-MpComputerStatus -ErrorAction Stop
				$defenderEnabled = [bool]$defender.AntivirusEnabled
				$realTimeEnabled = [bool]$defender.RealTimeProtectionEnabled
				$signatureVersion = $defender.AntivirusSignatureVersion
				if ($defender.QuickScanEndTime) {
					$lastQuickScan = $defender.QuickScanEndTime.ToUniversalTime().ToString('o')
				}
			} catch {}
		}

		if (-not $defenderEnabled) {
			try {
				$service = Get-Service -Name 'WinDefend' -ErrorAction Stop
				$defenderEnabled = $service.Status -eq 'Running'
			} catch {}
		}

		[pscustomobject]@{
			firewall_profiles = $profiles
			defender_enabled = [bool]$defenderEnabled
			real_time_enabled = [bool]$realTimeEnabled
			signature_version = $signatureVersion
			last_quick_scan = $lastQuickScan
		} | ConvertTo-Json -Compress -Depth 5`)
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}

	var status shared.WindowsSecurityStatus
	if err := json.Unmarshal([]byte(out), &status); err != nil {
		return nil
	}
	if len(status.FirewallProfiles) == 0 && !status.DefenderEnabled && !status.RealTimeEnabled && strings.TrimSpace(status.SignatureVersion) == "" && status.LastQuickScan.IsZero() {
		return nil
	}
	return &status
}

func CollectWindowsUpdateSummary() *shared.WindowsUpdateSummary {
	if runtime.GOOS != "windows" {
		return nil
	}

	out, err := runCmd("powershell", "-Command", `
		$pendingReboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
			(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
			(Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager') -and ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager').PendingFileRenameOperations -ne $null)
		$pendingCount = 0
		try {
			$session = New-Object -ComObject Microsoft.Update.Session
			$searcher = $session.CreateUpdateSearcher()
			$result = $searcher.Search('IsInstalled=0 and Type=''Software''')
			$pendingCount = $result.Updates.Count
		} catch {}
		$lastHotFix = Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 1
		[pscustomobject]@{
			pending_updates = $pendingCount
			pending_reboot = [bool]$pendingReboot
			last_installed_kb = if ($lastHotFix) { $lastHotFix.HotFixID } else { $null }
			last_installed_at = if ($lastHotFix -and $lastHotFix.InstalledOn) { ([datetime]$lastHotFix.InstalledOn).ToUniversalTime().ToString('o') } else { $null }
		} | ConvertTo-Json -Compress`)
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}

	var summary shared.WindowsUpdateSummary
	if err := json.Unmarshal([]byte(out), &summary); err != nil {
		return nil
	}
	return &summary
}
