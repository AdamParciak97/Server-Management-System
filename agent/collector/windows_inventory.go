package collector

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strconv"
	"strings"

	"github.com/sms/server-mgmt/shared"
)

func CollectCriticalEventLogs() ([]shared.EventLogEntry, error) {
	if runtime.GOOS != "windows" {
		return nil, nil
	}

	out, err := runCmd("powershell", "-Command", `
		$events = Get-WinEvent -FilterHashtable @{LogName=@('System','Application'); Level=@(1,2); StartTime=(Get-Date).AddDays(-1)} -MaxEvents 50 |
			Select-Object @{N='log_name';E={$_.LogName}},
				@{N='provider';E={$_.ProviderName}},
				@{N='event_id';E={$_.Id}},
				@{N='level';E={$_.LevelDisplayName}},
				@{N='time_created';E={$_.TimeCreated.ToUniversalTime().ToString('o')}},
				@{N='message';E={($_.Message -replace '\r|\n',' ') -replace '\s+',' '}}
		$events | ConvertTo-Json -Compress`)
	if err != nil {
		return nil, err
	}

	return parseEventLogJSON(out), nil
}

func CollectWindowsLicenseInfo() *shared.WindowsLicenseInfo {
	if runtime.GOOS != "windows" {
		return nil
	}

	out, err := runCmd("powershell", "-Command", `
		$product = Get-CimInstance SoftwareLicensingProduct | Where-Object { $_.PartialProductKey -and $_.ApplicationID -eq '55c92734-d682-4d71-983e-d6ec3f16059f' } | Select-Object -First 1
		$service = Get-CimInstance SoftwareLicensingService | Select-Object KeyManagementServiceMachine,KeyManagementServicePort
		if ($product) {
			[pscustomobject]@{
				product_name = $product.Name
				description = $product.Description
				channel = if ($product.Description -match 'VOLUME_KMSCLIENT') { 'KMS' } elseif ($product.Description -match 'VOLUME_MAK') { 'MAK' } else { 'Other' }
				partial_product_key = $product.PartialProductKey
				license_status = switch ($product.LicenseStatus) { 1 {'Licensed'} 2 {'Out-Of-Box Grace'} 3 {'Out-Of-Tolerance Grace'} 4 {'Non-Genuine Grace'} 5 {'Notification'} 6 {'Extended Grace'} default {'Unknown'} }
				kms_machine = $service.KeyManagementServiceMachine
				kms_port = [string]$service.KeyManagementServicePort
			} | ConvertTo-Json -Compress
		}`)
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}

	var info shared.WindowsLicenseInfo
	if err := json.Unmarshal([]byte(out), &info); err != nil {
		return nil
	}
	return &info
}

func CollectWindowsDiskInfo() []shared.DiskInfo {
	if runtime.GOOS != "windows" {
		return nil
	}

	out, err := runCmd("powershell", "-Command", `
		$items = New-Object System.Collections.ArrayList

		if (Get-Command Get-Volume -ErrorAction SilentlyContinue) {
			try {
				Get-Volume -ErrorAction Stop |
					Where-Object { $_.Size -gt 0 } |
					ForEach-Object {
						$mount = if ($_.DriveLetter) { "$($_.DriveLetter):\" } elseif ($_.Path) { $_.Path } else { $_.UniqueId }
						$device = if ($_.DriveLetter) { "$($_.DriveLetter):" } elseif ($_.UniqueId) { $_.UniqueId } else { $mount }
						$total = [int64]$_.Size
						$free = [int64]$_.SizeRemaining
						$used = if ($total -ge $free) { $total - $free } else { 0 }
						$pct = if ($total -gt 0) { [math]::Round(($used / [double]$total) * 100, 2) } else { 0 }
						[void]$items.Add([pscustomobject]@{
							mount = $mount
							device = $device
							fs_type = $_.FileSystemType
							total_bytes = [string]$total
							used_bytes = [string]$used
							usage_percent = $pct
						})
					}
			} catch {}
		}

		if ($items.Count -eq 0) {
			try {
				Get-CimInstance Win32_LogicalDisk -ErrorAction Stop |
					Where-Object { $_.DriveType -in 2,3,4,5 -and $_.Size -gt 0 } |
					ForEach-Object {
						$total = [int64]$_.Size
						$free = [int64]$_.FreeSpace
						$used = if ($total -ge $free) { $total - $free } else { 0 }
						$pct = if ($total -gt 0) { [math]::Round(($used / [double]$total) * 100, 2) } else { 0 }
						[void]$items.Add([pscustomobject]@{
							mount = if ($_.DeviceID) { $_.DeviceID + '\' } else { '' }
							device = $_.DeviceID
							fs_type = $_.FileSystem
							total_bytes = [string]$total
							used_bytes = [string]$used
							usage_percent = $pct
						})
					}
			} catch {}
		}

		@($items | Sort-Object mount -Unique) | ConvertTo-Json -Compress -Depth 5`)
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}

	trimmed := strings.TrimSpace(out)
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	type rawDisk struct {
		Mount        string      `json:"mount"`
		Device       string      `json:"device"`
		FSType       string      `json:"fs_type"`
		TotalBytes   interface{} `json:"total_bytes"`
		UsedBytes    interface{} `json:"used_bytes"`
		UsagePercent interface{} `json:"usage_percent"`
	}

	var many []rawDisk
	if err := json.Unmarshal([]byte(trimmed), &many); err != nil {
		var one rawDisk
		if err := json.Unmarshal([]byte(trimmed), &one); err != nil {
			return nil
		}
		many = []rawDisk{one}
	}

	outDisks := make([]shared.DiskInfo, 0, len(many))
	for _, item := range many {
		total := parseUintValue(item.TotalBytes)
		used := parseUintValue(item.UsedBytes)
		pct := parseFloatValue(item.UsagePercent)
		mount := strings.TrimSpace(item.Mount)
		device := strings.TrimSpace(item.Device)
		if mount == "" && device == "" {
			continue
		}
		if mount == "" {
			mount = device
		}
		outDisks = append(outDisks, shared.DiskInfo{
			Mount:        mount,
			Device:       device,
			FSType:       strings.TrimSpace(item.FSType),
			Total:        total,
			Used:         used,
			UsagePercent: pct,
		})
	}
	return outDisks
}

func parseEventLogJSON(input string) []shared.EventLogEntry {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	var many []shared.EventLogEntry
	if err := json.Unmarshal([]byte(trimmed), &many); err == nil {
		return many
	}

	var one shared.EventLogEntry
	if err := json.Unmarshal([]byte(trimmed), &one); err == nil {
		return []shared.EventLogEntry{one}
	}
	return nil
}

func parseUintValue(v interface{}) uint64 {
	switch value := v.(type) {
	case float64:
		if value < 0 {
			return 0
		}
		return uint64(value)
	case string:
		parsed, _ := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
		return parsed
	case json.Number:
		parsed, _ := value.Int64()
		if parsed < 0 {
			return 0
		}
		return uint64(parsed)
	default:
		parsed, _ := strconv.ParseUint(fmt.Sprint(value), 10, 64)
		return parsed
	}
}

func parseFloatValue(v interface{}) float64 {
	switch value := v.(type) {
	case float64:
		return value
	case string:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(value), 64)
		return parsed
	case json.Number:
		parsed, _ := value.Float64()
		return parsed
	default:
		parsed, _ := strconv.ParseFloat(fmt.Sprint(value), 64)
		return parsed
	}
}
