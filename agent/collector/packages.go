package collector

import (
	"runtime"
	"strings"

	"github.com/sms/server-mgmt/shared"
)

// CollectPackages gathers installed packages using the appropriate package manager.
func CollectPackages() ([]shared.Package, error) {
	switch runtime.GOOS {
	case "linux":
		return collectLinuxPackages()
	case "windows":
		return collectWindowsPackages()
	default:
		return nil, nil
	}
}

func collectLinuxPackages() ([]shared.Package, error) {
	// Try dpkg (Debian/Ubuntu)
	if pkgs, err := collectDpkg(); err == nil && len(pkgs) > 0 {
		return pkgs, nil
	}
	// Try rpm (RHEL/CentOS/Fedora)
	if pkgs, err := collectRPM(); err == nil && len(pkgs) > 0 {
		return pkgs, nil
	}
	return nil, nil
}

func collectDpkg() ([]shared.Package, error) {
	out, err := runCmd("dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\t${binary:Summary}\n")
	if err != nil {
		return nil, err
	}
	var pkgs []shared.Package
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		p := shared.Package{
			Name:    fields[0],
			Manager: "dpkg",
		}
		if len(fields) > 1 {
			p.Version = fields[1]
		}
		if len(fields) > 2 {
			p.Architecture = fields[2]
		}
		if len(fields) > 3 {
			p.Description = fields[3]
		}
		pkgs = append(pkgs, p)
	}
	return pkgs, nil
}

func collectRPM() ([]shared.Package, error) {
	out, err := runCmd("rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\t%{SUMMARY}\n")
	if err != nil {
		return nil, err
	}
	var pkgs []shared.Package
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		p := shared.Package{
			Name:    fields[0],
			Version: fields[1],
			Manager: "rpm",
		}
		if len(fields) > 2 {
			p.Architecture = fields[2]
		}
		if len(fields) > 3 {
			p.Description = fields[3]
		}
		pkgs = append(pkgs, p)
	}
	return pkgs, nil
}

func collectWindowsPackages() ([]shared.Package, error) {
	var pkgs []shared.Package

	// Try winget
	if p, err := collectWinget(); err == nil {
		pkgs = append(pkgs, p...)
	}

	// Try chocolatey
	if p, err := collectChoco(); err == nil {
		pkgs = append(pkgs, p...)
	}

	// Installed programs via registry/WMIC as fallback
	if len(pkgs) == 0 {
		p, _ := collectWMIC()
		pkgs = append(pkgs, p...)
	}

	return pkgs, nil
}

func collectWinget() ([]shared.Package, error) {
	out, err := runCmd("winget", "list", "--source", "winget", "--accept-source-agreements")
	if err != nil {
		return nil, err
	}
	var pkgs []shared.Package
	lines := strings.Split(out, "\n")
	// Skip header lines (first 3)
	for i, line := range lines {
		if i < 3 || strings.TrimSpace(line) == "" {
			continue
		}
		// winget output is fixed-width, parse by splitting on 2+ spaces
		parts := splitFixed(line)
		if len(parts) >= 2 {
			pkgs = append(pkgs, shared.Package{
				Name:    parts[0],
				Version: parts[len(parts)-1],
				Manager: "winget",
			})
		}
	}
	return pkgs, nil
}

func collectChoco() ([]shared.Package, error) {
	out, err := runCmd("choco", "list", "--local-only", "--no-color", "--limit-output")
	if err != nil {
		return nil, err
	}
	var pkgs []shared.Package
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) >= 2 {
			pkgs = append(pkgs, shared.Package{
				Name:    parts[0],
				Version: parts[1],
				Manager: "choco",
			})
		}
	}
	return pkgs, nil
}

func collectWMIC() ([]shared.Package, error) {
	out, err := runCmd("wmic", "product", "get", "name,version", "/format:csv")
	if err != nil {
		return nil, err
	}
	var pkgs []shared.Package
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Node") {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) >= 3 {
			pkgs = append(pkgs, shared.Package{
				Name:    parts[1],
				Version: parts[2],
				Manager: "wmic",
			})
		}
	}
	return pkgs, nil
}

func splitFixed(s string) []string {
	var parts []string
	current := strings.Builder{}
	spaces := 0
	for _, c := range s {
		if c == ' ' {
			spaces++
			if spaces >= 2 && current.Len() > 0 {
				parts = append(parts, strings.TrimSpace(current.String()))
				current.Reset()
				spaces = 0
			} else if spaces < 2 {
				current.WriteRune(c)
			}
		} else {
			spaces = 0
			current.WriteRune(c)
		}
	}
	if current.Len() > 0 {
		parts = append(parts, strings.TrimSpace(current.String()))
	}
	return parts
}
