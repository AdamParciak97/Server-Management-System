package db

var allPermissions = []string{
	"servers.read",
	"servers.write",
	"commands.read",
	"commands.write",
	"commands.approve",
	"alerts.read",
	"alerts.ack",
	"packages.read",
	"packages.write",
	"compliance.read",
	"compliance.write",
	"users.read",
	"users.write",
	"groups.read",
	"groups.write",
	"tokens.read",
	"tokens.write",
	"audit.read",
	"stats.read",
	"settings.read",
	"settings.write",
}

var defaultPermissionsByRole = map[string][]string{
	"admin": allPermissions,
	"operator": {
		"servers.read", "servers.write",
		"commands.read", "commands.write", "commands.approve",
		"alerts.read", "alerts.ack",
		"packages.read", "packages.write",
		"compliance.read", "compliance.write",
		"groups.read", "groups.write",
		"stats.read",
		"settings.read",
	},
	"readonly": {
		"servers.read",
		"commands.read",
		"alerts.read",
		"packages.read",
		"compliance.read",
		"groups.read",
		"stats.read",
		"settings.read",
	},
}

func DefaultPermissionsForRole(role string) []string {
	items := defaultPermissionsByRole[role]
	out := make([]string, 0, len(items))
	out = append(out, items...)
	return out
}

func AllPermissions() []string {
	out := make([]string, 0, len(allPermissions))
	out = append(out, allPermissions...)
	return out
}

func BuildEffectivePermissions(role string, extra []string) []string {
	seen := map[string]bool{}
	items := []string{}
	for _, permission := range DefaultPermissionsForRole(role) {
		if !seen[permission] {
			seen[permission] = true
			items = append(items, permission)
		}
	}
	for _, permission := range extra {
		if !seen[permission] {
			seen[permission] = true
			items = append(items, permission)
		}
	}
	return items
}
