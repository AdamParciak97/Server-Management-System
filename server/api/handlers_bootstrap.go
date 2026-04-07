package api

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
)

const agentPackageName = "sms-agent"

func (s *Server) handleCACertificate(w http.ResponseWriter, r *http.Request) {
	if s.caCertFile == "" {
		respondError(w, http.StatusNotFound, "ca certificate not configured")
		return
	}
	if _, err := os.Stat(s.caCertFile); err != nil {
		respondError(w, http.StatusNotFound, "ca certificate not found")
		return
	}

	w.Header().Set("Content-Type", "application/x-pem-file")
	http.ServeFile(w, r, s.caCertFile)
}

func (s *Server) handleLatestPackageDownload(w http.ResponseWriter, r *http.Request) {
	target := chi.URLParam(r, "target")
	osTarget, archTarget, ok := packageTargetFromSlug(target)
	if !ok {
		respondError(w, http.StatusBadRequest, "unsupported package target")
		return
	}

	pkg, err := s.db.GetLatestPackageForTarget(r.Context(), agentPackageName, osTarget, archTarget)
	if err == nil && pkg != nil {
		filename := fmt.Sprintf("%s-%s-%s-%s", pkg.Name, pkg.Version, osTarget, archTarget)
		if osTarget == "windows" {
			filename += ".exe"
		}
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
		http.ServeFile(w, r, pkg.FilePath)
		return
	}

	if bundledPath, bundledName, ok := s.bundledAgentForTarget(osTarget, archTarget); ok {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", bundledName))
		http.ServeFile(w, r, bundledPath)
		return
	}

	respondError(w, http.StatusNotFound, "package not found")
}

func packageTargetFromSlug(target string) (osTarget, archTarget string, ok bool) {
	switch target {
	case "agent-linux", "agent-linux-amd64":
		return "linux", "amd64", true
	case "agent-linux-arm64":
		return "linux", "arm64", true
	case "agent-windows", "agent-windows-amd64":
		return "windows", "amd64", true
	default:
		return "", "", false
	}
}

func (s *Server) bundledAgentForTarget(osTarget, archTarget string) (path string, name string, ok bool) {
	if s.agentsDir == "" {
		return "", "", false
	}

	filename := ""
	switch {
	case osTarget == "linux" && archTarget == "amd64":
		filename = "sms-agent-linux-amd64"
	case osTarget == "linux" && archTarget == "arm64":
		filename = "sms-agent-linux-arm64"
	case osTarget == "windows" && archTarget == "amd64":
		filename = "sms-agent-windows-amd64.exe"
	default:
		return "", "", false
	}

	fullPath := filepath.Join(s.agentsDir, filename)
	if _, err := os.Stat(fullPath); err != nil {
		return "", "", false
	}
	return fullPath, filename, true
}
