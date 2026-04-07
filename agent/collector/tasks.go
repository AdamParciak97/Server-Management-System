package collector

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/sms/server-mgmt/shared"
)

func CollectScheduledTasks() ([]shared.ScheduledTask, error) {
	switch runtime.GOOS {
	case "windows":
		return collectWindowsScheduledTasks()
	case "linux":
		return collectLinuxScheduledTasks(), nil
	default:
		return nil, nil
	}
}

func collectWindowsScheduledTasks() ([]shared.ScheduledTask, error) {
	out, err := runCmd("powershell", "-Command", `
		$tasks = Get-ScheduledTask | ForEach-Object {
			$info = $_ | Get-ScheduledTaskInfo
			[pscustomobject]@{
				name = $_.TaskName
				path = $_.TaskPath
				state = [string]$_.State
				schedule = (($_.Triggers | ForEach-Object { $_.CimClass.CimClassName + ':' + ($_.StartBoundary) }) -join '; ')
				command = (($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join '; ')
				user = $_.Principal.UserId
				next_run_time = if ($info.NextRunTime) { $info.NextRunTime.ToUniversalTime().ToString('o') } else { $null }
				last_run_time = if ($info.LastRunTime) { $info.LastRunTime.ToUniversalTime().ToString('o') } else { $null }
			}
		}
		$tasks | ConvertTo-Json -Compress`)
	if err != nil {
		return nil, err
	}

	return parseScheduledTaskJSON(out), nil
}

func collectLinuxScheduledTasks() []shared.ScheduledTask {
	paths := []struct {
		glob string
		user string
	}{
		{glob: "/etc/crontab", user: "root"},
		{glob: "/etc/cron.d/*", user: "root"},
		{glob: "/var/spool/cron/*", user: ""},
		{glob: "/var/spool/cron/crontabs/*", user: ""},
	}

	var tasks []shared.ScheduledTask
	for _, item := range paths {
		matches, _ := filepath.Glob(item.glob)
		if len(matches) == 0 && !strings.Contains(item.glob, "*") {
			matches = []string{item.glob}
		}
		for _, match := range matches {
			fileTasks := parseCronFile(match, item.user)
			tasks = append(tasks, fileTasks...)
		}
	}
	return tasks
}

func parseCronFile(path, defaultUser string) []shared.ScheduledTask {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var tasks []shared.ScheduledTask
	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		schedule := strings.Join(fields[:5], " ")
		user := defaultUser
		commandStart := 5
		if strings.Contains(path, "/etc/cron") {
			if len(fields) < 7 {
				continue
			}
			user = fields[5]
			commandStart = 6
		}
		if user == "" {
			user = filepath.Base(path)
		}
		tasks = append(tasks, shared.ScheduledTask{
			Name:     filepath.Base(path) + ":" + strconv.Itoa(lineNo),
			Path:     path,
			State:    "enabled",
			Schedule: schedule,
			Command:  strings.Join(fields[commandStart:], " "),
			User:     user,
		})
	}
	return tasks
}

func parseScheduledTaskJSON(input string) []shared.ScheduledTask {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	var many []shared.ScheduledTask
	if err := json.Unmarshal([]byte(trimmed), &many); err == nil {
		return many
	}

	var one shared.ScheduledTask
	if err := json.Unmarshal([]byte(trimmed), &one); err == nil {
		return []shared.ScheduledTask{one}
	}
	return nil
}
