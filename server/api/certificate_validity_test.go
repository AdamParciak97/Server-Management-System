package api

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sms/server-mgmt/server/db"
)

type certificateStoreStub struct { calls int; fingerprint string; agent *db.Agent; err error }
func (s *certificateStoreStub) GetAgentByCert(_ context.Context, fingerprint string) (*db.Agent,error) {
	s.calls++; s.fingerprint=fingerprint; return s.agent,s.err
}

type registrationIdentityStub struct { calls int; fingerprint string }
func (s *registrationIdentityStub) RegisterAgentWithToken(_ context.Context, _, _, fingerprint, _ string) (string,error) {
	s.calls++; s.fingerprint=fingerprint; return scopeA,nil
}

func TestAgentCertificateValidityAndPinnedIdentity(t *testing.T) {
	now:=time.Now()
	for _, tc:=range []struct { name string; cert *x509.Certificate; known bool; dbErr error; status int }{
		{"absent",nil,true,nil,401},
		{"expired",&x509.Certificate{Raw:[]byte("expired"),NotBefore:now.Add(-2*time.Hour),NotAfter:now.Add(-time.Hour)},true,nil,401},
		{"future",&x509.Certificate{Raw:[]byte("future"),NotBefore:now.Add(time.Hour),NotAfter:now.Add(2*time.Hour)},true,nil,401},
		{"empty-raw",&x509.Certificate{NotBefore:now.Add(-time.Hour),NotAfter:now.Add(time.Hour)},true,nil,401},
		{"unknown",&x509.Certificate{Raw:[]byte("unknown"),NotBefore:now.Add(-time.Hour),NotAfter:now.Add(time.Hour)},false,nil,401},
		{"lookup-failed",&x509.Certificate{Raw:[]byte("error"),NotBefore:now.Add(-time.Hour),NotAfter:now.Add(time.Hour)},true,errors.New("synthetic-private"),401},
		{"known-valid",&x509.Certificate{Raw:[]byte("valid"),NotBefore:now.Add(-time.Hour),NotAfter:now.Add(time.Hour)},true,nil,204},
	} {
		t.Run(tc.name,func(t *testing.T){
			store:=&certificateStoreStub{err:tc.dbErr}
			if tc.known {store.agent=&db.Agent{ID:scopeA}}
			r:=httptest.NewRequest("GET","/api/agent/commands?agent_id="+scopeB,nil)
			r.Header.Set("X-Agent-ID",scopeB)
			r.TLS=&tls.ConnectionState{}
			if tc.cert!=nil {r.TLS.PeerCertificates=[]*x509.Certificate{tc.cert}}
			called:=false
			h:=(&Server{}).agentCertificateMiddleware(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
				called=true
				if getAgentIDFromCtx(r.Context())!=scopeA {t.Fatal("request-supplied identity trusted")}
				w.WriteHeader(204)
			}),store)
			w:=httptest.NewRecorder();h.ServeHTTP(w,r)
			if w.Code!=tc.status || called!=(tc.status==204) || strings.Contains(w.Body.String(),"synthetic-private") {t.Fatalf("unsafe certificate result %d",w.Code)}
			valid:=tc.cert!=nil && len(tc.cert.Raw)>0 && !now.Before(tc.cert.NotBefore) && now.Before(tc.cert.NotAfter)
			if (store.calls>0)!=valid {t.Fatal("invalid certificate reached identity store")}
			if valid {hash:=sha256.Sum256(tc.cert.Raw);if store.fingerprint!=hex.EncodeToString(hash[:]){t.Fatal("leaf fingerprint differs")}}
		})
	}
}

func TestRegistrationRequiresCurrentlyValidCertificateBeforeConsumingToken(t *testing.T) {
	now:=time.Now()
	for _, offset:=range []time.Duration{-time.Hour,time.Hour} {
		store:=&registrationIdentityStub{}
		r:=httptest.NewRequest("POST","/api/agent/register",strings.NewReader(`{"hostname":"synthetic-host","registration_token":"synthetic-once","agent_version":"test"}`))
		r.TLS=&tls.ConnectionState{PeerCertificates:[]*x509.Certificate{{Raw:[]byte("synthetic-leaf"),NotBefore:now.Add(-2*time.Hour),NotAfter:now.Add(offset)}}}
		w:=httptest.NewRecorder();(&Server{}).registerAgent(w,r,store)
		if offset<0 {
			if w.Code!=401 || store.calls!=0 {t.Fatal("expired registration consumed token")}
		} else if w.Code!=200 || store.calls!=1 || store.fingerprint=="" {t.Fatalf("valid enrollment failed: %d %s",w.Code,w.Body.String())}
	}
}
