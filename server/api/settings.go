package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
)

type integrationSettingsStore interface {
	GetPublicSystemConfig(context.Context) (map[string]string, error)
	SetSystemConfigBatch(context.Context, map[string]string) error
}

type integrationSettingsSpec struct {
	keys   []string
	secret string
}

var ldapSettingsSpec = integrationSettingsSpec{
	keys: []string{"ldap_enabled", "ldap_server_url", "ldap_bind_dn", "ldap_base_dn",
		"ldap_user_filter", "ldap_start_tls", "ldap_default_role"},
	secret: "ldap_bind_password",
}

var smtpSettingsSpec = integrationSettingsSpec{
	keys: []string{"smtp_enabled", "smtp_host", "smtp_port", "smtp_username", "smtp_from", "smtp_to"},
	secret: "smtp_password",
}

func (s *Server) getIntegrationSettings(w http.ResponseWriter, r *http.Request, store integrationSettingsStore, spec integrationSettingsSpec) {
	w.Header().Set("Cache-Control", "no-store")
	s.requirePermission("settings.read")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values, err := store.GetPublicSystemConfig(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to load integration settings")
			return
		}
		// Explicit allowlist also prevents unrelated configuration from escaping.
		result := make(map[string]string, len(spec.keys)+1)
		for _, key := range spec.keys {
			result[key] = values[key]
		}
		result[spec.secret+"_configured"] = "false"
		if values[spec.secret+"_configured"] == "true" {
			result[spec.secret+"_configured"] = "true"
		}
		respondOK(w, result)
	})).ServeHTTP(w, r)
}

func (s *Server) setIntegrationSettings(w http.ResponseWriter, r *http.Request, store integrationSettingsStore, spec integrationSettingsSpec) {
	w.Header().Set("Cache-Control", "no-store")
	s.requirePermission("settings.write")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		decoder := json.NewDecoder(r.Body)
		var req map[string]json.RawMessage
		if err := decoder.Decode(&req); err != nil || req == nil {
			respondError(w, http.StatusBadRequest, "invalid settings request")
			return
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			respondError(w, http.StatusBadRequest, "invalid settings request")
			return
		}
		allowed := map[string]bool{spec.secret: true, "secret_action": true}
		for _, key := range spec.keys {
			allowed[key] = true
		}
		values := make(map[string]string, len(req))
		for key, raw := range req {
			var value string
			if !allowed[key] || string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				respondError(w, http.StatusBadRequest, "unknown setting or invalid value")
				return
			}
			values[key] = value
		}
		action := values["secret_action"]
		secret, supplied := values[spec.secret]
		delete(values, "secret_action")
		delete(values, spec.secret)
		switch action {
		case "", "keep":
			// An empty legacy field is safe; a value requires explicit intent.
			if supplied && secret != "" {
				respondError(w, http.StatusBadRequest, "replacing a secret requires secret_action replace")
				return
			}
		case "replace":
			if secret == "" {
				respondError(w, http.StatusBadRequest, "replacement secret is required")
				return
			}
			values[spec.secret] = secret
		case "clear":
			if supplied && secret != "" {
				respondError(w, http.StatusBadRequest, "clear cannot include a replacement secret")
				return
			}
			values[spec.secret] = ""
		default:
			respondError(w, http.StatusBadRequest, "invalid secret action")
			return
		}
		if err := store.SetSystemConfigBatch(r.Context(), values); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to save integration settings")
			return
		}
		respondOK(w, map[string]string{"status": "saved"})
	})).ServeHTTP(w, r)
}
