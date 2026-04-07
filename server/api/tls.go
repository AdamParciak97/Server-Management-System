package api

import (
	"crypto/tls"
)

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
