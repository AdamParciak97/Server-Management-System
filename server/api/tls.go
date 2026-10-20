package api

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"net/http"
	"time"
)

// TLS proves possession of the key. Enrollment pins the leaf fingerprint;
// RequestClientCert does not validate certificate dates for us.
func clientCertificateFingerprint(r *http.Request, now time.Time) string {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		return ""
	}
	cert := r.TLS.PeerCertificates[0]
	if cert == nil || len(cert.Raw) == 0 || now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
		return ""
	}
	hash := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(hash[:])
}

// BuildTLSConfig returns a TLS config for the server with mTLS support.
// It requests (but does not require) client certificates.
// Agents authenticate via cert; browser dashboard users don't need a client cert.
func BuildTLSConfig(certFile, keyFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequestClientCert,
		MinVersion:   tls.VersionTLS12,
	}, nil
}
