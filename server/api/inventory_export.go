package api

import (
	"context"
	"encoding/csv"
	"net/http"
	"strings"
	"unicode"

	"github.com/sms/server-mgmt/server/db"
)

type inventoryExportStore interface {
	ListAgents(context.Context) ([]*db.Agent, error)
}

// Quoting alone does not stop spreadsheet formula interpretation.
func inventoryCSVCell(value string) string {
	trimmed := strings.TrimLeftFunc(value, unicode.IsSpace)
	if strings.ContainsAny(value, "\t\r\n") || (trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0]))) {
		return "'" + value
	}
	return value
}

func (s *Server) exportInventory(w http.ResponseWriter, r *http.Request, store inventoryExportStore) {
	s.requirePermission("servers.read")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("format") != "csv" {
			respondError(w, http.StatusBadRequest, "unsupported format, use csv")
			return
		}
		agents, err := store.ListAgents(r.Context())
		if err != nil {
			respondError(w, http.StatusServiceUnavailable, "inventory export unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="servers.csv"`)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		writer := csv.NewWriter(w)
		if err := writer.Write([]string{"ID", "Hostname", "OS", "Status", "Last Seen", "Group"}); err != nil { return }
		for _, agent := range agents {
			if agent == nil || !s.canAccessGroup(getUserFromCtx(r.Context()), agent.GroupID) { continue }
			lastSeen := ""
			if agent.LastSeen != nil { lastSeen = agent.LastSeen.UTC().Format("2006-01-02 15:04:05") }
			row := []string{agent.ID, agent.Hostname, agent.OS, agent.Status, lastSeen, agent.GroupName}
			for i := range row { row[i] = inventoryCSVCell(row[i]) }
			if err := writer.Write(row); err != nil { return }
		}
		writer.Flush()
		if err := writer.Error(); err != nil && s.logger != nil { s.logger.Error("write inventory export", "error", err) }
	})).ServeHTTP(w, r)
}
