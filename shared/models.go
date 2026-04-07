package shared

import "time"

// ─── Agent registration ───────────────────────────────────────────────────────

type RegisterRequest struct {
	RegistrationToken string `json:"registration_token"`
	Hostname          string `json:"hostname"`
	AgentVersion      string `json:"agent_version"`
}

type RegisterResponse struct {
	AgentID    string `json:"agent_id"`
	ServerTime int64  `json:"server_time"`
}

// ─── Commands ─────────────────────────────────────────────────────────────────

type CommandPriority string

const (
	PriorityCritical CommandPriority = "critical"
	PriorityHigh     CommandPriority = "high"
	PriorityNormal   CommandPriority = "normal"
	PriorityLow      CommandPriority = "low"
)

type CommandType string

const (
	CmdSystemUpdate      CommandType = "system_update"
	CmdInstallPackage    CommandType = "install_package"
	CmdRunScript         CommandType = "run_script"
	CmdServiceControl    CommandType = "service_control"
	CmdInstallAgent      CommandType = "install_agent"
	CmdForceReport       CommandType = "force_report"
)

type Command struct {
	ID        string          `json:"id"`
	Type      CommandType     `json:"type"`
	Priority  CommandPriority `json:"priority"`
	DryRun    bool            `json:"dry_run"`
	Payload   CommandPayload  `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
	Timeout   int             `json:"timeout_seconds"`
}

type CommandPayload struct {
	PackageName    string   `json:"package_name,omitempty"`
	PackageVersion string   `json:"package_version,omitempty"`
	ScriptContent  string   `json:"script_content,omitempty"`
	ScriptType     string   `json:"script_type,omitempty"` // bash, powershell
	ServiceName    string   `json:"service_name,omitempty"`
	ServiceAction  string   `json:"service_action,omitempty"` // start, stop, restart
	PackageURL     string   `json:"package_url,omitempty"`
	Args           []string `json:"args,omitempty"`
}

type CommandResult struct {
	CommandID  string `json:"command_id"`
	AgentID    string `json:"agent_id"`
	Status     string `json:"status"` // success, error, timeout
	Output     string `json:"output"`
	Error      string `json:"error,omitempty"`
	ExitCode   int    `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
	CompletedAt time.Time `json:"completed_at"`
}

type CommandsResponse struct {
	Commands []Command `json:"commands"`
}

// ─── System info ──────────────────────────────────────────────────────────────

type SystemInfo struct {
	OS           string  `json:"os"`
	OSVersion    string  `json:"os_version"`
	Architecture string  `json:"architecture"`
	Hostname     string  `json:"hostname"`
	FQDN         string  `json:"fqdn"`
	IPs          []string `json:"ips"`
	UptimeSeconds int64  `json:"uptime_seconds"`
	CPUUsage     float64 `json:"cpu_usage_percent"`
	MemTotal     uint64  `json:"mem_total_bytes"`
	MemUsed      uint64  `json:"mem_used_bytes"`
	MemUsage     float64 `json:"mem_usage_percent"`
	Disks        []DiskInfo `json:"disks"`
	KernelVersion string `json:"kernel_version"`
	BootTime     time.Time `json:"boot_time"`
	WindowsLicense *WindowsLicenseInfo `json:"windows_license,omitempty"`
	WindowsSecurity *WindowsSecurityStatus `json:"windows_security,omitempty"`
	WindowsUpdate *WindowsUpdateSummary `json:"windows_update,omitempty"`
	SecurityPosture *SecurityPosture `json:"security_posture,omitempty"`
}

type DiskInfo struct {
	Mount     string  `json:"mount"`
	Device    string  `json:"device"`
	FSType    string  `json:"fs_type"`
	Total     uint64  `json:"total_bytes"`
	Used      uint64  `json:"used_bytes"`
	UsagePercent float64 `json:"usage_percent"`
}

// ─── Packages ─────────────────────────────────────────────────────────────────

type Package struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Architecture string `json:"architecture,omitempty"`
	Manager     string `json:"manager"` // dpkg, rpm, winget, choco
	Description string `json:"description,omitempty"`
}

// ─── Services ─────────────────────────────────────────────────────────────────

type Service struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name,omitempty"`
	Status      string `json:"status"`      // running, stopped, unknown
	StartMode   string `json:"start_mode"`  // auto, manual, disabled
	PID         int    `json:"pid,omitempty"`
	Description string `json:"description,omitempty"`
}

// ─── Service Configurations ───────────────────────────────────────────────────

type ServiceConfigs struct {
	AD         *ADConfig         `json:"active_directory,omitempty"`
	DNS        *DNSConfig        `json:"dns,omitempty"`
	IIS        *IISConfig        `json:"iis,omitempty"`
	Apache     *ApacheConfig     `json:"apache,omitempty"`
	Nginx      *NginxConfig      `json:"nginx,omitempty"`
	PostgreSQL *PostgreSQLConfig `json:"postgresql,omitempty"`
	MySQL      *MySQLConfig      `json:"mysql,omitempty"`
	MSSQL      *MSSQLConfig      `json:"mssql,omitempty"`
}

type ADConfig struct {
	DomainName    string   `json:"domain_name"`
	ForestName    string   `json:"forest_name"`
	DomainMode    string   `json:"domain_mode"`
	FSMORoles     []string `json:"fsmo_roles"`
	SiteName      string   `json:"site_name"`
	IsGlobalCatalog bool   `json:"is_global_catalog"`
	ReplicationSummary string `json:"replication_summary,omitempty"`
}

type DNSConfig struct {
	Type        string   `json:"type"` // bind, windows, unbound
	Forwarders  []string `json:"forwarders"`
	Zones       []string `json:"zones"`
	ListenAddr  []string `json:"listen_addresses"`
	RecursionEnabled bool `json:"recursion_enabled"`
}

type IISConfig struct {
	Version     string       `json:"version"`
	Sites       []IISSite    `json:"sites"`
	AppPools    []IISAppPool `json:"app_pools"`
}

type IISSite struct {
	Name     string `json:"name"`
	ID       int    `json:"id"`
	State    string `json:"state"`
	Bindings []string `json:"bindings"`
	PhysPath string `json:"physical_path"`
}

type IISAppPool struct {
	Name         string `json:"name"`
	State        string `json:"state"`
	RuntimeVersion string `json:"runtime_version"`
	ManagedPipelineMode string `json:"managed_pipeline_mode"`
}

type ApacheConfig struct {
	Version    string   `json:"version"`
	ConfigFile string   `json:"config_file"`
	VHosts     []string `json:"vhosts"`
	Modules    []string `json:"loaded_modules"`
}

type NginxConfig struct {
	Version    string       `json:"version"`
	ConfigFile string       `json:"config_file"`
	Sites      []NginxSite  `json:"sites"`
}

type NginxSite struct {
	Name       string   `json:"name"`
	ServerName []string `json:"server_name"`
	Ports      []string `json:"ports"`
}

type PostgreSQLConfig struct {
	Version    string `json:"version"`
	DataDir    string `json:"data_dir"`
	Port       int    `json:"port"`
	MaxConnections int `json:"max_connections"`
	Databases  []string `json:"databases"`
}

type MySQLConfig struct {
	Version   string `json:"version"`
	DataDir   string `json:"data_dir"`
	Port      int    `json:"port"`
	Databases []string `json:"databases"`
}

type MSSQLConfig struct {
	Version   string `json:"version"`
	Edition   string `json:"edition"`
	Port      int    `json:"port"`
	Databases []string `json:"databases"`
	Collation string `json:"collation"`
}

// ─── Security Agents ──────────────────────────────────────────────────────────

type SecurityAgent struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	Status     string `json:"status"`    // running, stopped, not_installed
	ServiceName string `json:"service_name,omitempty"`
	InstallPath string `json:"install_path,omitempty"`
	LastSeen   *time.Time `json:"last_seen,omitempty"`
}

// ─── Process ──────────────────────────────────────────────────────────────────

type Process struct {
	PID     int     `json:"pid"`
	Name    string  `json:"name"`
	User    string  `json:"user"`
	CPU     float64 `json:"cpu_percent"`
	Memory  uint64  `json:"memory_bytes"`
	Status  string  `json:"status"`
	Command string  `json:"command"`
}

type ScheduledTask struct {
	Name        string    `json:"name"`
	Path        string    `json:"path,omitempty"`
	State       string    `json:"state,omitempty"`
	Schedule    string    `json:"schedule,omitempty"`
	Command     string    `json:"command,omitempty"`
	User        string    `json:"user,omitempty"`
	NextRunTime time.Time `json:"next_run_time,omitempty"`
	LastRunTime time.Time `json:"last_run_time,omitempty"`
}

type EventLogEntry struct {
	LogName     string    `json:"log_name"`
	Provider    string    `json:"provider"`
	EventID     int       `json:"event_id"`
	Level       string    `json:"level"`
	TimeCreated time.Time `json:"time_created"`
	Message     string    `json:"message"`
}

type WindowsLicenseInfo struct {
	ProductName       string `json:"product_name"`
	Description       string `json:"description,omitempty"`
	Channel           string `json:"channel,omitempty"`
	PartialProductKey string `json:"partial_product_key,omitempty"`
	LicenseStatus     string `json:"license_status"`
	KMSMachine        string `json:"kms_machine,omitempty"`
	KMSPort           string `json:"kms_port,omitempty"`
}

type FirewallProfile struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type WindowsSecurityStatus struct {
	FirewallProfiles []FirewallProfile `json:"firewall_profiles,omitempty"`
	DefenderEnabled  bool              `json:"defender_enabled"`
	RealTimeEnabled  bool              `json:"real_time_enabled"`
	SignatureVersion string            `json:"signature_version,omitempty"`
	LastQuickScan    time.Time         `json:"last_quick_scan,omitempty"`
}

type WindowsUpdateSummary struct {
	PendingUpdates  int       `json:"pending_updates"`
	PendingReboot   bool      `json:"pending_reboot"`
	LastInstalledKB string    `json:"last_installed_kb,omitempty"`
	LastInstalledAt time.Time `json:"last_installed_at,omitempty"`
}

type SecurityPosture struct {
	BitLockerVolumes []BitLockerVolume `json:"bitlocker_volumes,omitempty"`
	RDPEnabled       bool              `json:"rdp_enabled"`
	WinRMEnabled     bool              `json:"winrm_enabled"`
	SSHEnabled       bool              `json:"ssh_enabled"`
	LocalAdmins      []LocalAdminEntry `json:"local_admins,omitempty"`
	Certificates     []CertificateInfo `json:"certificates,omitempty"`
}

type BitLockerVolume struct {
	MountPoint       string `json:"mount_point"`
	ProtectionStatus string `json:"protection_status"`
	EncryptionMethod string `json:"encryption_method,omitempty"`
}

type LocalAdminEntry struct {
	Name        string `json:"name"`
	ObjectClass string `json:"object_class,omitempty"`
	Source      string `json:"source,omitempty"`
}

type CertificateInfo struct {
	Subject    string    `json:"subject"`
	Issuer     string    `json:"issuer,omitempty"`
	Thumbprint string    `json:"thumbprint,omitempty"`
	Store      string    `json:"store,omitempty"`
	NotAfter   time.Time `json:"not_after"`
	DaysLeft   int       `json:"days_left"`
}

// ─── Report ───────────────────────────────────────────────────────────────────

type AgentReport struct {
	AgentID        string         `json:"agent_id"`
	Timestamp      time.Time      `json:"timestamp"`
	AgentVersion   string         `json:"agent_version"`
	System         SystemInfo     `json:"system"`
	Packages       []Package      `json:"packages"`
	Services       []Service      `json:"services"`
	ServiceConfigs ServiceConfigs `json:"service_configs"`
	SecurityAgents []SecurityAgent `json:"security_agents"`
	Processes      []Process      `json:"processes"`
	EventLogs      []EventLogEntry `json:"event_logs,omitempty"`
	ScheduledTasks []ScheduledTask `json:"scheduled_tasks,omitempty"`
}

// ─── API response wrappers ────────────────────────────────────────────────────

type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
	Message string      `json:"message,omitempty"`
}
