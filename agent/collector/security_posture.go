package collector

import (
	"encoding/json"
	"runtime"
	"strings"

	"github.com/sms/server-mgmt/shared"
)

func CollectSecurityPosture() *shared.SecurityPosture {
	switch runtime.GOOS {
	case "windows":
		return collectWindowsSecurityPosture()
	case "linux":
		return collectLinuxSecurityPosture()
	default:
		return nil
	}
}

func collectWindowsSecurityPosture() *shared.SecurityPosture {
	out, err := runCmd("powershell", "-Command", `
		$bitlocker = @()
		if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) {
			try {
				$bitlocker = Get-BitLockerVolume -ErrorAction Stop | ForEach-Object {
					[pscustomobject]@{
						mount_point = $_.MountPoint
						protection_status = [string]$_.ProtectionStatus
						encryption_method = [string]$_.EncryptionMethod
					}
				}
			} catch {}
		}

		$rdpEnabled = $false
		try {
			$rdpEnabled = ((Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -ErrorAction Stop).fDenyTSConnections -eq 0)
		} catch {}

		$winrmEnabled = $false
		try {
			$winrm = Get-Service -Name WinRM -ErrorAction Stop
			$winrmEnabled = ($winrm.Status -eq 'Running')
		} catch {}

		$localAdmins = @()
		if (Get-Command Get-LocalGroupMember -ErrorAction SilentlyContinue) {
			try {
				$localAdmins = Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | ForEach-Object {
					[pscustomobject]@{
						name = $_.Name
						object_class = [string]$_.ObjectClass
						source = [string]$_.PrincipalSource
					}
				}
			} catch {}
		}

		$certs = @()
		try {
			$now = Get-Date
			$certs = Get-ChildItem Cert:\LocalMachine\My -ErrorAction Stop | ForEach-Object {
				[pscustomobject]@{
					subject = $_.Subject
					issuer = $_.Issuer
					thumbprint = $_.Thumbprint
					store = 'LocalMachine\\My'
					not_after = $_.NotAfter.ToUniversalTime().ToString('o')
					days_left = [int][math]::Floor(($_.NotAfter - $now).TotalDays)
				}
			}
		} catch {}

		[pscustomobject]@{
			bitlocker_volumes = $bitlocker
			rdp_enabled = [bool]$rdpEnabled
			winrm_enabled = [bool]$winrmEnabled
			ssh_enabled = [bool](Get-Service -Name 'sshd' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' })
			local_admins = $localAdmins
			certificates = $certs
		} | ConvertTo-Json -Compress -Depth 6`)
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}

	var posture shared.SecurityPosture
	if err := json.Unmarshal([]byte(out), &posture); err != nil {
		return nil
	}
	if len(posture.BitLockerVolumes) == 0 && len(posture.LocalAdmins) == 0 && len(posture.Certificates) == 0 && !posture.RDPEnabled && !posture.WinRMEnabled && !posture.SSHEnabled {
		return nil
	}
	return &posture
}

func collectLinuxSecurityPosture() *shared.SecurityPosture {
	posture := &shared.SecurityPosture{}

	if out, err := runCmd("sh", "-c", "systemctl is-active sshd 2>/dev/null || systemctl is-active ssh 2>/dev/null"); err == nil {
		posture.SSHEnabled = strings.TrimSpace(out) == "active"
	}

	certs := collectLinuxCertificates()
	if len(certs) > 0 {
		posture.Certificates = certs
	}

	if len(posture.Certificates) == 0 && !posture.SSHEnabled {
		return nil
	}
	return posture
}
