package collector

import (
	"os"
	"runtime"
	"strings"

	"github.com/sms/server-mgmt/shared"
)

// CollectServiceConfigs gathers configuration from known services.
func CollectServiceConfigs() (shared.ServiceConfigs, error) {
	var cfg shared.ServiceConfigs

	// Linux-specific
	if runtime.GOOS == "linux" {
		cfg.DNS = collectDNSLinux()
		cfg.Apache = collectApache()
		cfg.Nginx = collectNginx()
		cfg.PostgreSQL = collectPostgreSQL()
		cfg.MySQL = collectMySQL()
	}

	// Windows-specific
	if runtime.GOOS == "windows" {
		cfg.IIS = collectIIS()
		cfg.DNS = collectDNSWindows()
		cfg.AD = collectAD()
		cfg.MSSQL = collectMSSQL()
	}

	return cfg, nil
}

func collectDNSLinux() *shared.DNSConfig {
	// Detect BIND
	if _, err := os.Stat("/etc/bind/named.conf"); err == nil {
		cfg := &shared.DNSConfig{Type: "bind"}
		// Parse forwarders from named.conf
		if data, err := os.ReadFile("/etc/bind/named.conf.options"); err == nil {
			cfg.Forwarders = extractForwarders(string(data))
		}
		return cfg
	}
	// Detect Unbound
	if _, err := os.Stat("/etc/unbound/unbound.conf"); err == nil {
		return &shared.DNSConfig{Type: "unbound"}
	}
	// Check systemd-resolved
	out, err := runCmd("resolvectl", "status")
	if err == nil && strings.Contains(out, "DNS Servers") {
		return &shared.DNSConfig{Type: "systemd-resolved"}
	}
	return nil
}

func extractForwarders(config string) []string {
	var forwarders []string
	inBlock := false
	for _, line := range strings.Split(config, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "forwarders") && strings.Contains(line, "{") {
			inBlock = true
			continue
		}
		if inBlock {
			if strings.Contains(line, "}") {
				break
			}
			ip := strings.TrimSuffix(strings.TrimSpace(line), ";")
			if ip != "" {
				forwarders = append(forwarders, ip)
			}
		}
	}
	return forwarders
}

func collectApache() *shared.ApacheConfig {
	configPaths := []string{
		"/etc/apache2/apache2.conf",
		"/etc/httpd/conf/httpd.conf",
		"/etc/apache2/httpd.conf",
	}
	for _, path := range configPaths {
		if _, err := os.Stat(path); err == nil {
			cfg := &shared.ApacheConfig{ConfigFile: path}
			// Get version
			if out, err := runCmd("apache2", "-v"); err == nil {
				for _, line := range strings.Split(out, "\n") {
					if strings.Contains(line, "Server version") {
						parts := strings.Split(line, "/")
						if len(parts) >= 2 {
							cfg.Version = strings.Fields(parts[1])[0]
						}
					}
				}
			}
			if cfg.Version == "" {
				if out, err := runCmd("httpd", "-v"); err == nil {
					for _, line := range strings.Split(out, "\n") {
						if strings.Contains(line, "Server version") {
							parts := strings.Split(line, "/")
							if len(parts) >= 2 {
								cfg.Version = strings.Fields(parts[1])[0]
							}
						}
					}
				}
			}
			// List vhosts
			cfg.VHosts = collectApacheVHosts()
			return cfg
		}
	}
	return nil
}

func collectApacheVHosts() []string {
	dirs := []string{"/etc/apache2/sites-enabled", "/etc/httpd/conf.d"}
	var vhosts []string
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				vhosts = append(vhosts, e.Name())
			}
		}
	}
	return vhosts
}

func collectNginx() *shared.NginxConfig {
	configPaths := []string{"/etc/nginx/nginx.conf", "/usr/local/etc/nginx/nginx.conf"}
	for _, path := range configPaths {
		if _, err := os.Stat(path); err == nil {
			cfg := &shared.NginxConfig{ConfigFile: path}
			// Get version
			if out, err := runCmd("nginx", "-v"); err == nil {
				for _, line := range strings.Split(out+"\n", "\n") {
					if strings.Contains(line, "nginx/") {
						parts := strings.Split(line, "/")
						if len(parts) >= 2 {
							cfg.Version = strings.TrimSpace(parts[1])
						}
					}
				}
			}
			// List sites
			cfg.Sites = collectNginxSites()
			return cfg
		}
	}
	return nil
}

func collectNginxSites() []shared.NginxSite {
	dirs := []string{"/etc/nginx/sites-enabled", "/etc/nginx/conf.d"}
	var sites []shared.NginxSite
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				sites = append(sites, shared.NginxSite{Name: e.Name()})
			}
		}
	}
	return sites
}

func collectPostgreSQL() *shared.PostgreSQLConfig {
	// Check if postgres is running
	if _, err := runCmd("psql", "--version"); err != nil {
		if _, err2 := os.Stat("/etc/postgresql"); err2 != nil {
			return nil
		}
	}
	cfg := &shared.PostgreSQLConfig{Port: 5432}

	if out, err := runCmd("psql", "--version"); err == nil {
		parts := strings.Fields(out)
		if len(parts) >= 3 {
			cfg.Version = parts[2]
		}
	}

	// Try to get databases (may require no-password access)
	if out, err := runCmd("psql", "-U", "postgres", "-t", "-c",
		"SELECT datname FROM pg_database WHERE datistemplate = false;"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			db := strings.TrimSpace(line)
			if db != "" {
				cfg.Databases = append(cfg.Databases, db)
			}
		}
	}
	return cfg
}

func collectMySQL() *shared.MySQLConfig {
	if _, err := runCmd("mysql", "--version"); err != nil {
		if _, err2 := os.Stat("/etc/mysql"); err2 != nil {
			return nil
		}
	}
	cfg := &shared.MySQLConfig{Port: 3306}
	if out, err := runCmd("mysql", "--version"); err == nil {
		cfg.Version = extractVersion(out)
	}
	return cfg
}

// Windows-specific collectors

func collectIIS() *shared.IISConfig {
	out, err := runCmd("powershell", "-Command",
		`Import-Module WebAdministration -ErrorAction SilentlyContinue;
		$sites = Get-Website | Select-Object Name,ID,State,PhysicalPath,Bindings;
		$sites | ForEach-Object { "$($_.Name)|$($_.ID)|$($_.State)|$($_.PhysicalPath)" }`)
	if err != nil {
		return nil
	}

	cfg := &shared.IISConfig{}

	// Get IIS version from registry
	if verOut, err := runCmd("powershell", "-Command",
		`(Get-ItemProperty HKLM:\SOFTWARE\Microsoft\InetStp -ErrorAction SilentlyContinue).setupstring`); err == nil {
		cfg.Version = strings.TrimSpace(verOut)
	}

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 3 {
			continue
		}
		id := 0
		if len(parts) > 1 {
			// parse id
		}
		cfg.Sites = append(cfg.Sites, shared.IISSite{
			Name:     parts[0],
			ID:       id,
			State:    parts[2],
			PhysPath: func() string { if len(parts) > 3 { return parts[3] }; return "" }(),
		})
	}

	// App Pools
	if poolOut, err := runCmd("powershell", "-Command",
		`Get-WebConfiguration system.applicationHost/applicationPools/add |
		ForEach-Object { "$($_.name)|$($_.state)|$($_.managedRuntimeVersion)|$($_.managedPipelineMode)" }`); err == nil {
		for _, line := range strings.Split(poolOut, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			parts := strings.Split(line, "|")
			if len(parts) >= 1 {
				pool := shared.IISAppPool{Name: parts[0]}
				if len(parts) > 1 { pool.State = parts[1] }
				if len(parts) > 2 { pool.RuntimeVersion = parts[2] }
				if len(parts) > 3 { pool.ManagedPipelineMode = parts[3] }
				cfg.AppPools = append(cfg.AppPools, pool)
			}
		}
	}
	return cfg
}

func collectDNSWindows() *shared.DNSConfig {
	// Check if DNS Server role is installed
	out, err := runCmd("powershell", "-Command",
		`Get-WindowsFeature DNS -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InstallState`)
	if err != nil || !strings.Contains(out, "Installed") {
		return nil
	}
	cfg := &shared.DNSConfig{Type: "windows"}

	// Get forwarders
	if fwdOut, err := runCmd("powershell", "-Command",
		`Get-DnsServerForwarder | Select-Object -ExpandProperty IPAddress | ForEach-Object { $_.ToString() }`); err == nil {
		for _, line := range strings.Split(fwdOut, "\n") {
			ip := strings.TrimSpace(line)
			if ip != "" {
				cfg.Forwarders = append(cfg.Forwarders, ip)
			}
		}
	}

	// Get zones
	if zoneOut, err := runCmd("powershell", "-Command",
		`Get-DnsServerZone | Select-Object -ExpandProperty ZoneName`); err == nil {
		for _, line := range strings.Split(zoneOut, "\n") {
			z := strings.TrimSpace(line)
			if z != "" {
				cfg.Zones = append(cfg.Zones, z)
			}
		}
	}
	return cfg
}

func collectAD() *shared.ADConfig {
	// Check if this is a Domain Controller
	out, err := runCmd("powershell", "-Command",
		`(Get-WmiObject Win32_ComputerSystem -ErrorAction SilentlyContinue).DomainRole`)
	if err != nil {
		return nil
	}
	role := strings.TrimSpace(out)
	// DomainRole: 4 = Backup DC, 5 = Primary DC
	if role != "4" && role != "5" {
		return nil
	}

	cfg := &shared.ADConfig{IsGlobalCatalog: role == "5"}

	// Get domain info
	if domOut, err := runCmd("powershell", "-Command",
		`Import-Module ActiveDirectory -ErrorAction SilentlyContinue;
		$d = Get-ADDomain -ErrorAction SilentlyContinue;
		"$($d.DNSRoot)|$($d.Forest)|$($d.DomainMode)"`); err == nil {
		parts := strings.Split(strings.TrimSpace(domOut), "|")
		if len(parts) >= 1 { cfg.DomainName = parts[0] }
		if len(parts) >= 2 { cfg.ForestName = parts[1] }
		if len(parts) >= 3 { cfg.DomainMode = parts[2] }
	}

	// FSMO roles
	if fsmoOut, err := runCmd("powershell", "-Command",
		`netdom query fsmo 2>$null`); err == nil {
		for _, line := range strings.Split(fsmoOut, "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				cfg.FSMORoles = append(cfg.FSMORoles, line)
			}
		}
	}

	return cfg
}

func collectMSSQL() *shared.MSSQLConfig {
	out, err := runCmd("powershell", "-Command",
		`$svc = Get-Service | Where-Object {$_.Name -like 'MSSQL*' -and $_.Status -eq 'Running'};
		if ($svc) { "found" } else { "notfound" }`)
	if err != nil || !strings.Contains(out, "found") {
		return nil
	}

	cfg := &shared.MSSQLConfig{Port: 1433}

	// Get version via sqlcmd
	if verOut, err := runCmd("sqlcmd", "-Q", "SELECT @@VERSION", "-h", "-1"); err == nil {
		cfg.Version = extractVersion(verOut)
	}

	return cfg
}
