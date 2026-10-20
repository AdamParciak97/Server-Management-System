package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type settingsStoreStub struct {
	public map[string]string
	saved map[string]string
	err error
	reads, writes int
}

func (s *settingsStoreStub) GetPublicSystemConfig(context.Context) (map[string]string, error) {
	s.reads++
	return s.public, s.err
}

func (s *settingsStoreStub) SetSystemConfigBatch(_ context.Context, values map[string]string) error {
	s.writes++
	s.saved = values
	return s.err
}

func settingsRequest(method, body string, claims *JWTClaims) *http.Request {
	r := httptest.NewRequest(method, "/api/settings/test", strings.NewReader(body))
	if claims != nil {
		r = r.WithContext(context.WithValue(r.Context(), ctxUser, claims))
	}
	return r
}

func TestIntegrationSettingsPermissions(t *testing.T) {
	for _, spec := range []integrationSettingsSpec{ldapSettingsSpec, smtpSettingsSpec} {
		for _, tc := range []struct {
			name string
			claims *JWTClaims
			get, put int
		}{
			{"anonymous", nil, 401, 401},
			{"readonly", &JWTClaims{Role: "readonly"}, 403, 403},
			{"operator", &JWTClaims{Role: "operator"}, 403, 403},
			{"reader", &JWTClaims{Role: "readonly", Permissions: []string{"settings.read"}}, 200, 403},
			{"writer", &JWTClaims{Role: "operator", Permissions: []string{"settings.write"}}, 403, 200},
			{"admin", &JWTClaims{Role: "admin"}, 200, 200},
		} {
			t.Run(spec.secret+"/"+tc.name, func(t *testing.T) {
				s := &Server{}
				store := &settingsStoreStub{}
				w := httptest.NewRecorder()
				s.getIntegrationSettings(w, settingsRequest(http.MethodGet, "", tc.claims), store, spec)
				if w.Code != tc.get || (store.reads > 0) != (tc.get == 200) {
					t.Fatalf("GET status=%d reads=%d", w.Code, store.reads)
				}
				w = httptest.NewRecorder()
				s.setIntegrationSettings(w, settingsRequest(http.MethodPut, `{}`, tc.claims), store, spec)
				if w.Code != tc.put || (store.writes > 0) != (tc.put == 200) {
					t.Fatalf("PUT status=%d writes=%d", w.Code, store.writes)
				}
			})
		}
	}
}

func TestIntegrationSettingsNeverReturnSecrets(t *testing.T) {
	for _, spec := range []integrationSettingsSpec{ldapSettingsSpec, smtpSettingsSpec} {
		for _, configured := range []string{"true", "false", "", "invalid"} {
			store := &settingsStoreStub{public: map[string]string{
				"ldap_bind_password": "synthetic-ldap-secret", "smtp_password": "synthetic-smtp-secret",
				"unrelated": "private", spec.keys[0]: "true", spec.secret+"_configured": configured,
			}}
			w := httptest.NewRecorder()
			(&Server{}).getIntegrationSettings(w, settingsRequest(http.MethodGet, "", &JWTClaims{Role: "admin"}), store, spec)
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("invalid GET response: %d", w.Code)
			}
			var response struct { Data map[string]string `json:"data"` }
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil { t.Fatal(err) }
			if len(response.Data) != len(spec.keys)+1 { t.Fatal("unexpected public fields") }
			for _, key := range []string{"ldap_bind_password", "smtp_password", "unrelated"} {
				if _, present := response.Data[key]; present { t.Fatalf("exposed %s", key) }
			}
			want := "false"
			if configured == "true" { want = "true" }
			if response.Data[spec.secret+"_configured"] != want { t.Fatal("invalid configured flag") }
		}
	}
}

func TestIntegrationSecretActions(t *testing.T) {
	for _, spec := range []integrationSettingsSpec{ldapSettingsSpec, smtpSettingsSpec} {
		for _, tc := range []struct {
			name, body string
			want map[string]string
		}{
			{"omitted", `{}`, map[string]string{}},
			{"legacy_empty", `{"`+spec.secret+`":""}`, map[string]string{}},
			{"keep", `{"secret_action":"keep","`+spec.keys[0]+`":"true"}`, map[string]string{spec.keys[0]: "true"}},
			{"replace", `{"secret_action":"replace","`+spec.secret+`":"  synthetic-new  "}`, map[string]string{spec.secret: "  synthetic-new  "}},
			{"clear", `{"secret_action":"clear"}`, map[string]string{spec.secret: ""}},
		} {
			t.Run(spec.secret+"/"+tc.name, func(t *testing.T) {
				store := &settingsStoreStub{}
				w := httptest.NewRecorder()
				(&Server{}).setIntegrationSettings(w, settingsRequest(http.MethodPut, tc.body, &JWTClaims{Role: "admin"}), store, spec)
				if w.Code != 200 || store.writes != 1 || !reflect.DeepEqual(store.saved, tc.want) {
					t.Fatalf("status=%d writes=%d values=%v", w.Code, store.writes, store.saved)
				}
				if w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "synthetic-new") {
					t.Fatal("unsafe save response")
				}
			})
		}
	}
}

func TestIntegrationSettingsRejectAmbiguousOrInvalidInput(t *testing.T) {
	for _, spec := range []integrationSettingsSpec{ldapSettingsSpec, smtpSettingsSpec} {
		for _, body := range []string{
			``, `{`, `[]`, `null`, `{} {}`, `{} trailing`, `{"secret_action":null}`,
			`{"secret_action":"unknown"}`, `{"secret_action":"replace"}`,
			`{"secret_action":"replace","`+spec.secret+`":""}`,
			`{"secret_action":"keep","`+spec.secret+`":"synthetic"}`,
			`{"secret_action":"clear","`+spec.secret+`":"synthetic"}`,
			`{"`+spec.secret+`":"synthetic"}`, `{"`+spec.secret+`":false}`,
			`{"`+spec.secret+`_configured":"true"}`, `{"unknown":"value"}`,
			`{"`+spec.keys[0]+`":true}`, `{"`+spec.keys[0]+`":null}`,
			`{"`+spec.keys[0]+`":"`+strings.Repeat("a", 65<<10)+`"}`,
		} {
			store := &settingsStoreStub{}
			w := httptest.NewRecorder()
			(&Server{}).setIntegrationSettings(w, settingsRequest(http.MethodPut, body, &JWTClaims{Role: "admin"}), store, spec)
			if w.Code != 400 || store.writes != 0 { t.Fatalf("invalid request accepted: status=%d writes=%d", w.Code, store.writes) }
		}
		other := ldapSettingsSpec.secret
		if spec.secret == other { other = smtpSettingsSpec.secret }
		store := &settingsStoreStub{}
		w := httptest.NewRecorder()
		(&Server{}).setIntegrationSettings(w, settingsRequest(http.MethodPut, `{"`+other+`":"synthetic"}`, &JWTClaims{Role: "admin"}), store, spec)
		if w.Code != 400 || store.writes != 0 { t.Fatal("cross-integration write accepted") }
	}
}

func TestIntegrationSettingsStorageErrorsAreRedacted(t *testing.T) {
	for _, spec := range []integrationSettingsSpec{ldapSettingsSpec, smtpSettingsSpec} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			store := &settingsStoreStub{err: errors.New("synthetic-private-database-detail")}
			w := httptest.NewRecorder()
			r := settingsRequest(method, `{}`, &JWTClaims{Role: "admin"})
			if method == http.MethodGet { (&Server{}).getIntegrationSettings(w, r, store, spec) } else { (&Server{}).setIntegrationSettings(w, r, store, spec) }
			if w.Code != 500 || strings.Contains(w.Body.String(), "synthetic-private") { t.Fatal("storage failure exposed or reported as success") }
		}
	}
}
