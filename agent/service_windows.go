//go:build windows

package main

import (
	"context"
	"log/slog"

	"github.com/sms/server-mgmt/agent/config"
	"golang.org/x/sys/windows/svc"
)

type smsWindowsService struct {
	cfg        *config.Config
	configPath string
	logger     *slog.Logger
}

func runWindowsServiceIfNeeded(cfg *config.Config, configPath string, logger *slog.Logger) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, err
	}

	handler := &smsWindowsService{
		cfg:        cfg,
		configPath: configPath,
		logger:     logger,
	}
	return true, svc.Run(cfg.Agent.ServiceName, handler)
}

func (s *smsWindowsService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	changes <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- runAgent(ctx, s.cfg, s.configPath, s.logger)
	}()

	changes <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				changes <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			default:
			}
		case err := <-done:
			if err != nil {
				s.logger.Error("service agent loop failed", "error", err)
				return false, 1
			}
			return false, 0
		}
	}
}
