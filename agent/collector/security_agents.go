package collector

import (
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/sms/server-mgmt/shared"
)

// SecurityAgentDef describes how to detect a security agent.
type SecurityAgentDef struct {
	Name         string
	ServiceNames []string   // system service names to check
	ProcessNames []string   // process names to check
	InstallPaths []string   // file paths to check for existence
	VersionCmd   []string   // command to get version
}

var knownAgents = []SecurityAgentDef{
	{
		Name:         "Elastic Agent",
		ServiceNames: []string{"elastic-agent", "Elastic Agent"},
		ProcessNames: []string{"elastic-agent", "elastic-agent.exe"},
		InstallPaths: []string{"/opt/Elastic/Agent", "C:\\Program Files\\Elastic\\Agent"},
	},
	{
		Name:         "FireEye HX",
		ServiceNames: []string{"xagt", "FireEye Agent"},
		ProcessNames: []string{"xagt", "xagt.exe"},
		InstallPaths: []string{"/opt/isection/bin", "C:\\Program Files\\FireEye\\xagt"},
	},
	{
		Name:         "CrowdStrike Falcon",
		ServiceNames: []string{"falcon-sensor", "CrowdStrike Falcon Sensor Service", "CSFalconService"},
		ProcessNames: []string{"falcon-sensor", "CSFalconService.exe", "CSFalconContainer.exe"},
		InstallPaths: []string{"/opt/CrowdStrike", "C:\\Program Files\\CrowdStrike"},
	},
	{
		Name:         "Carbon Black",
		ServiceNames: []string{"cbdaemon", "CbDefense", "CarbonBlack"},
		ProcessNames: []string{"cbdaemon", "cb.exe"},
		InstallPaths: []string{"/var/lib/cbsensor", "C:\\Program Files\\CarbonBlack"},
	},
	{
		Name:         "Splunk Universal Forwarder",
		ServiceNames: []string{"SplunkForwarder", "splunkd"},
		ProcessNames: []string{"splunkd", "splunkd.exe"},
		InstallPaths: []string{"/opt/splunkforwarder", "C:\\Program Files\\SplunkUniversalForwarder"},
		VersionCmd:   []string{"/opt/splunkforwarder/bin/splunk", "version"},
	},
	{
		Name:         "Zabbix Agent",
		ServiceNames: []string{"zabbix-agent", "zabbix-agent2", "Zabbix Agent"},
		ProcessNames: []string{"zabbix_agentd", "zabbix_agent2", "zabbix_agentd.exe"},
		InstallPaths: []string{"/etc/zabbix", "C:\\Program Files\\Zabbix Agent"},
		VersionCmd:   []string{"zabbix_agentd", "--version"},
	},
	{
		Name:         "Wazuh Agent",
		ServiceNames: []string{"wazuh-agent", "WazuhSvc"},
		ProcessNames: []string{"wazuh-agentd", "wazuh-agentd.exe"},
		InstallPaths: []string{"/var/ossec", "C:\\Program Files (x86)\\ossec-agent"},
		VersionCmd:   []string{"/var/ossec/bin/wazuh-agentd", "--version"},
	},
	{
		Name:         "OSSEC Agent",
		ServiceNames: []string{"ossec", "OssecSvc"},
		ProcessNames: []string{"ossec-agentd", "ossec-agentd.exe"},
		InstallPaths: []string{"/var/ossec"},
	},
	{
		Name:         "Tenable Nessus Agent",
		ServiceNames: []string{"nessusagent", "Tenable Nessus Agent"},
		ProcessNames: []string{"nessusd", "nessus-agent.exe"},
		InstallPaths: []string{"/opt/nessus_agent", "C:\\Program Files\\Tenable\\Nessus Agent"},
	},
	{
		Name:         "SentinelOne",
		ServiceNames: []string{"SentinelAgent", "sentinelagent"},
		ProcessNames: []string{"SentinelAgent.exe", "SentinelServiceHost.exe"},
		InstallPaths: []string{"C:\\Program Files\\SentinelOne"},
	},
}

// CollectSecurityAgents checks for the presence and status of known security agents.
func CollectSecurityAgents() ([]shared.SecurityAgent, error) {
	runningServices := getRunningServices()
	runningProcesses := getRunningProcesses()

	var result []shared.SecurityAgent
	for _, def := range knownAgents {
		sa := detectAgent(def, runningServices, runningProcesses)
		result = append(result, sa)
	}
	return result, nil
}

func detectAgent(def SecurityAgentDef, services, processes map[string]bool) shared.SecurityAgent {
	sa := shared.SecurityAgent{
		Name:   def.Name,
		Status: "not_installed",
	}

	// Check services
	for _, svcName := range def.ServiceNames {
		if services[strings.ToLower(svcName)] {
			sa.Status = "running"
			sa.ServiceName = svcName
			break
		}
		// Check if service exists but stopped
		if serviceExists(svcName) {
			sa.Status = "stopped"
			sa.ServiceName = svcName
		}
	}

	// Check processes
	if sa.Status != "running" {
		for _, procName := range def.ProcessNames {
			if processes[strings.ToLower(procName)] {
				sa.Status = "running"
				break
			}
		}
	}

	// Check install paths
	if sa.Status == "not_installed" {
		for _, path := range def.InstallPaths {
			if _, err := os.Stat(path); err == nil {
				sa.InstallPath = path
				sa.Status = "stopped"
				break
			}
		}
	}

	// Get version
	if sa.Status != "not_installed" && len(def.VersionCmd) > 0 {
		if out, err := runCmd(def.VersionCmd[0], def.VersionCmd[1:]...); err == nil {
			sa.Version = extractVersion(out)
		}
	}

	if sa.Status == "running" {
		now := time.Now()
		sa.LastSeen = &now
	}

	return sa
}

func getRunningServices() map[string]bool {
	running := make(map[string]bool)
	var out string
	var err error

	switch runtime.GOOS {
	case "linux":
		out, err = runCmd("systemctl", "list-units", "--type=service", "--state=running",
			"--no-pager", "--no-legend", "--plain")
		if err != nil {
			return running
		}
		for _, line := range strings.Split(out, "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				name := strings.TrimSuffix(fields[0], ".service")
				running[strings.ToLower(name)] = true
			}
		}
	case "windows":
		out, err = runCmd("powershell", "-Command",
			`Get-Service | Where-Object {$_.Status -eq 'Running'} | Select-Object -ExpandProperty Name`)
		if err != nil {
			return running
		}
		for _, line := range strings.Split(out, "\n") {
			name := strings.TrimSpace(line)
			if name != "" {
				running[strings.ToLower(name)] = true
			}
		}
	}
	return running
}

func getRunningProcesses() map[string]bool {
	running := make(map[string]bool)
	var out string
	var err error

	switch runtime.GOOS {
	case "linux":
		out, err = runCmd("ps", "-e", "-o", "comm=")
	case "windows":
		out, err = runCmd("tasklist", "/fo", "csv", "/nh")
	}
	if err != nil {
		return running
	}
	for _, line := range strings.Split(out, "\n") {
		name := strings.TrimSpace(line)
		// Handle Windows CSV: "name.exe","PID",...
		if strings.Contains(name, ",") {
			parts := strings.Split(name, ",")
			name = strings.Trim(parts[0], "\"")
		}
		if name != "" {
			running[strings.ToLower(name)] = true
		}
	}
	return running
}

func serviceExists(name string) bool {
	switch runtime.GOOS {
	case "linux":
		_, err := runCmd("systemctl", "status", name)
		// Exit code 4 = not found, anything else means it exists
		return err == nil || !strings.Contains(err.Error(), "exit status 4")
	case "windows":
		out, err := runCmd("sc", "query", name)
		return err == nil && strings.Contains(out, "SERVICE_NAME")
	}
	return false
}

func extractVersion(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Look for version patterns like "x.y.z"
		words := strings.Fields(line)
		for _, word := range words {
			if len(word) > 0 && word[0] >= '0' && word[0] <= '9' &&
				strings.ContainsAny(word, ".") {
				return word
			}
			if strings.HasPrefix(strings.ToLower(word), "v") && len(word) > 1 &&
				word[1] >= '0' && word[1] <= '9' {
				return word[1:]
			}
		}
	}
	return "unknown"
}
