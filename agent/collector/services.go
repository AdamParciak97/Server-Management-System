package collector

import (
	"runtime"
	"strconv"
	"strings"

	"github.com/sms/server-mgmt/shared"
)

// CollectServices gathers all system services and their status.
func CollectServices() ([]shared.Service, error) {
	switch runtime.GOOS {
	case "linux":
		return collectSystemdServices()
	case "windows":
		return collectWindowsServices()
	default:
		return nil, nil
	}
}

func collectSystemdServices() ([]shared.Service, error) {
	out, err := runCmd("systemctl", "list-units", "--type=service", "--all",
		"--no-pager", "--no-legend",
		"--output=json-pretty")
	if err != nil {
		// Fallback: text output
		return collectSystemdText()
	}
	_ = out
	return collectSystemdText()
}

func collectSystemdText() ([]shared.Service, error) {
	out, err := runCmd("systemctl", "list-units", "--type=service", "--all",
		"--no-pager", "--no-legend", "--plain")
	if err != nil {
		return nil, err
	}

	var services []shared.Service
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		name := strings.TrimSuffix(fields[0], ".service")
		loadState := fields[1]
		activeState := fields[2]
		subState := fields[3]
		_ = loadState

		status := "unknown"
		switch activeState {
		case "active":
			if subState == "running" {
				status = "running"
			} else {
				status = "active"
			}
		case "inactive", "failed":
			status = "stopped"
		}

		// Get start mode
		startMode := getSystemdStartMode(fields[0])

		svc := shared.Service{
			Name:      name,
			Status:    status,
			StartMode: startMode,
		}
		services = append(services, svc)
	}
	return services, nil
}

func getSystemdStartMode(unit string) string {
	out, err := runCmd("systemctl", "is-enabled", unit)
	if err != nil {
		return "unknown"
	}
	switch strings.TrimSpace(out) {
	case "enabled":
		return "auto"
	case "disabled":
		return "disabled"
	case "static":
		return "static"
	case "masked":
		return "masked"
	default:
		return "manual"
	}
}

func collectWindowsServices() ([]shared.Service, error) {
	// Use sc query for status and sc qc for start type
	out, err := runCmd("powershell", "-Command", `
		Get-Service | Select-Object Name,DisplayName,Status,StartType |
		ForEach-Object { "$($_.Name)|$($_.DisplayName)|$($_.Status)|$($_.StartType)" }`)
	if err != nil {
		return collectWindowsServicesWMIC()
	}

	var services []shared.Service
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}

		status := "unknown"
		switch strings.ToLower(parts[2]) {
		case "running":
			status = "running"
		case "stopped":
			status = "stopped"
		case "paused":
			status = "paused"
		}

		startMode := "manual"
		switch strings.ToLower(parts[3]) {
		case "automatic":
			startMode = "auto"
		case "disabled":
			startMode = "disabled"
		case "boot":
			startMode = "boot"
		case "system":
			startMode = "system"
		}

		services = append(services, shared.Service{
			Name:        parts[0],
			DisplayName: parts[1],
			Status:      status,
			StartMode:   startMode,
		})
	}
	return services, nil
}

func collectWindowsServicesWMIC() ([]shared.Service, error) {
	out, err := runCmd("wmic", "service", "get",
		"Name,DisplayName,State,StartMode", "/format:csv")
	if err != nil {
		return nil, err
	}

	var services []shared.Service
	for i, line := range strings.Split(out, "\n") {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(strings.TrimSpace(line), ",")
		if len(parts) < 5 {
			continue
		}
		// CSV: Node,DisplayName,Name,StartMode,State
		status := "unknown"
		if strings.EqualFold(parts[4], "running") {
			status = "running"
		} else if strings.EqualFold(parts[4], "stopped") {
			status = "stopped"
		}
		startMode := strings.ToLower(parts[3])
		if startMode == "auto" {
			startMode = "auto"
		}

		services = append(services, shared.Service{
			Name:        parts[2],
			DisplayName: parts[1],
			Status:      status,
			StartMode:   startMode,
		})
	}
	return services, nil
}

// CollectProcesses gathers running processes.
func CollectProcesses() ([]shared.Process, error) {
	switch runtime.GOOS {
	case "linux":
		return collectLinuxProcesses()
	case "windows":
		return collectWindowsProcesses()
	default:
		return nil, nil
	}
}

func collectLinuxProcesses() ([]shared.Process, error) {
	out, err := runCmd("ps", "aux", "--no-headers")
	if err != nil {
		return nil, err
	}

	var procs []shared.Process
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}
		pid, _ := strconv.Atoi(fields[1])
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		memKB, _ := strconv.ParseUint(fields[5], 10, 64)

		cmd := strings.Join(fields[10:], " ")
		name := fields[10]
		if strings.HasPrefix(name, "/") {
			parts := strings.Split(name, "/")
			name = parts[len(parts)-1]
		}

		procs = append(procs, shared.Process{
			PID:     pid,
			Name:    name,
			User:    fields[0],
			CPU:     cpu,
			Memory:  memKB * 1024,
			Status:  fields[7],
			Command: cmd,
		})
	}
	return procs, nil
}

func collectWindowsProcesses() ([]shared.Process, error) {
	out, err := runCmd("powershell", "-Command", `
		Get-Process | Select-Object Id,Name,CPU,WorkingSet64,@{N='User';E={try{$_.GetOwner().User}catch{''}}} |
		ForEach-Object { "$($_.Id)|$($_.Name)|$($_.CPU)|$($_.WorkingSet64)|$($_.User)" }`)
	if err != nil {
		return nil, err
	}

	var procs []shared.Process
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}
		pid, _ := strconv.Atoi(parts[0])
		cpu, _ := strconv.ParseFloat(parts[2], 64)
		mem, _ := strconv.ParseUint(parts[3], 10, 64)
		user := ""
		if len(parts) > 4 {
			user = parts[4]
		}

		procs = append(procs, shared.Process{
			PID:    pid,
			Name:   parts[1],
			User:   user,
			CPU:    cpu,
			Memory: mem,
			Status: "running",
		})
	}
	return procs, nil
}
