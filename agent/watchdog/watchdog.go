package watchdog

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"
)

// Watchdog monitors the agent's main loop health and restarts it if it freezes.
type Watchdog struct {
	mu       sync.Mutex
	lastBeat time.Time
	logger   *slog.Logger
	timeout  time.Duration
	onDead   func()
}

func New(logger *slog.Logger, timeout time.Duration, onDead func()) *Watchdog {
	return &Watchdog{
		lastBeat: time.Now(),
		logger:   logger,
		timeout:  timeout,
		onDead:   onDead,
	}
}

// Beat updates the last heartbeat time.
func (w *Watchdog) Beat() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.lastBeat = time.Now()
}

// Start runs the watchdog check loop.
func (w *Watchdog) Start(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.mu.Lock()
			since := time.Since(w.lastBeat)
			w.mu.Unlock()

			if since > w.timeout {
				w.logger.Error("watchdog: agent appears dead, triggering restart",
					"last_beat", since.String())
				if w.onDead != nil {
					go w.onDead()
				}
			}
		}
	}
}

// SelfRestart restarts the current process with the same arguments.
// This is a best-effort restart - in production, the OS service manager handles restarts.
func SelfRestart(logger *slog.Logger) {
	logger.Info("initiating self-restart")
	time.Sleep(2 * time.Second)

	// Re-exec self
	exe, err := os.Executable()
	if err != nil {
		logger.Error("get executable path", "error", err)
		os.Exit(1)
		return
	}

	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Start(); err != nil {
		logger.Error("restart failed", "error", err)
		os.Exit(1)
		return
	}
	logger.Info("new process started", "pid", cmd.Process.Pid)
	os.Exit(0)
}
