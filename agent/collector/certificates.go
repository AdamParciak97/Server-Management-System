package collector

import (
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sms/server-mgmt/shared"
)

func collectLinuxCertificates() []shared.CertificateInfo {
	patterns := []string{
		"/etc/ssl/certs/*.pem",
		"/etc/ssl/certs/*.crt",
		"/usr/local/share/ca-certificates/*.crt",
	}

	seen := map[string]bool{}
	var out []shared.CertificateInfo
	now := time.Now()

	for _, pattern := range patterns {
		matches, _ := filepath.Glob(pattern)
		for _, match := range matches {
			if seen[match] {
				continue
			}
			seen[match] = true
			data, err := os.ReadFile(match)
			if err != nil {
				continue
			}
			for len(data) > 0 {
				block, rest := pem.Decode(data)
				if block == nil {
					break
				}
				data = rest
				if block.Type != "CERTIFICATE" {
					continue
				}
				cert, err := x509.ParseCertificate(block.Bytes)
				if err != nil {
					continue
				}
				out = append(out, shared.CertificateInfo{
					Subject:    cert.Subject.String(),
					Issuer:     cert.Issuer.String(),
					Thumbprint: strings.ToUpper(hexDigest(cert.Raw)),
					Store:      match,
					NotAfter:   cert.NotAfter.UTC(),
					DaysLeft:   int(cert.NotAfter.Sub(now).Hours() / 24),
				})
				break
			}
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].DaysLeft == out[j].DaysLeft {
			return out[i].Subject < out[j].Subject
		}
		return out[i].DaysLeft < out[j].DaysLeft
	})

	if len(out) > 50 {
		return out[:50]
	}
	return out
}

func hexDigest(data []byte) string {
	const chars = "0123456789ABCDEF"
	out := make([]byte, len(data)*2)
	for i, b := range data {
		out[i*2] = chars[b>>4]
		out[i*2+1] = chars[b&0x0F]
	}
	return string(out)
}
