//go:build !windows

package main

import (
	"log/slog"

	"github.com/sms/server-mgmt/agent/config"
)

func runWindowsServiceIfNeeded(_ *config.Config, _ string, _ *slog.Logger) (bool, error) {
	return false, nil
}
