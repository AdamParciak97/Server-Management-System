package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/sms/server-mgmt/shared"
)

// Executor runs commands received from the server.
type Executor struct {
	logger        *slog.Logger
	serverURL     string
	configPath    string
	serviceName   string
	defaultTimeout time.Duration
	queue         chan shared.Command
	results       chan *shared.CommandResult
}

func New(logger *slog.Logger, serverURL, configPath, serviceName string, defaultTimeout time.Duration) *Executor {
	return &Executor{
		logger:        logger,
		serverURL:     strings.TrimRight(serverURL, "/"),
		configPath:    configPath,
		serviceName:   serviceName,
		defaultTimeout: defaultTimeout,
		queue:         make(chan shared.Command, 100),
		results:       make(chan *shared.CommandResult, 100),
	}
}

// Enqueue adds commands to the execution queue, sorted by priority.
func (e *Executor) Enqueue(cmds []shared.Command) {
	// Sort by priority
	sort.Slice(cmds, func(i, j int) bool {
		return priorityOrder(cmds[i].Priority) < priorityOrder(cmds[j].Priority)
	})
	for _, cmd := range cmds {
		select {
		case e.queue <- cmd:
		default:
			e.logger.Warn("command queue full, dropping command", "id", cmd.ID)
		}
	}
}

// Results returns the channel where command results are sent.
func (e *Executor) Results() <-chan *shared.CommandResult {
	return e.results
}

// Run processes commands from the queue until ctx is cancelled.
func (e *Executor) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case cmd := <-e.queue:
			result := e.execute(ctx, cmd)
			select {
			case e.results <- result:
			case <-ctx.Done():
				return
			}
		}
	}
}

func (e *Executor) execute(ctx context.Context, cmd shared.Command) *shared.CommandResult {
	start := time.Now()
	e.logger.Info("executing command", "id", cmd.ID, "type", cmd.Type, "dry_run", cmd.DryRun)

	timeout := e.defaultTimeout
	if cmd.Timeout > 0 {
		timeout = time.Duration(cmd.Timeout) * time.Second
	}

	cmdCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	result := &shared.CommandResult{
		CommandID:   cmd.ID,
		CompletedAt: time.Now(),
	}

	var output string
	var err error

	switch cmd.Type {
	case shared.CmdSystemUpdate:
		output, err = e.runSystemUpdate(cmdCtx, cmd.DryRun)
	case shared.CmdInstallPackage:
		output, err = e.runInstallPackage(cmdCtx, cmd.Payload.PackageName, cmd.Payload.PackageVersion, cmd.Payload.PackageURL, cmd.DryRun)
	case shared.CmdRunScript:
		output, err = e.runScript(cmdCtx, cmd.Payload.ScriptContent, cmd.Payload.ScriptType, cmd.DryRun)
	case shared.CmdServiceControl:
		output, err = e.runServiceControl(cmdCtx, cmd.Payload.ServiceName, cmd.Payload.ServiceAction, cmd.DryRun)
	case shared.CmdInstallAgent:
		output, err = e.runInstallAgent(cmdCtx, cmd.Payload.PackageURL, cmd.DryRun)
	case shared.CmdForceReport:
		output = "force_report_requested"
	default:
		err = fmt.Errorf("unknown command type: %s", cmd.Type)
	}

	result.DurationMs = time.Since(start).Milliseconds()
	result.CompletedAt = time.Now()
	result.Output = output

	if err != nil {
		if cmdCtx.Err() == context.DeadlineExceeded {
			result.Status = "timeout"
			result.Error = "command timed out"
		} else {
			result.Status = "error"
			result.Error = err.Error()
		}
		result.ExitCode = 1
	} else {
		result.Status = "success"
		result.ExitCode = 0
	}

	e.logger.Info("command completed",
		"id", cmd.ID,
		"status", result.Status,
		"duration_ms", result.DurationMs,
	)
	return result
}

func (e *Executor) runSystemUpdate(ctx context.Context, dryRun bool) (string, error) {
	switch runtime.GOOS {
	case "linux":
		return e.runLinuxUpdate(ctx, dryRun)
	case "windows":
		return e.runWindowsUpdate(ctx, dryRun)
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

func (e *Executor) runLinuxUpdate(ctx context.Context, dryRun bool) (string, error) {
	// Detect package manager
	if _, err := exec.LookPath("apt-get"); err == nil {
		if dryRun {
			return runWithOutput(ctx, "apt-get", "-s", "upgrade")
		}
		// Update first
		if out, err := runWithOutput(ctx, "apt-get", "update"); err != nil {
			return out, err
		}
		return runWithOutput(ctx, "apt-get", "-y", "upgrade")
	}
	if _, err := exec.LookPath("yum"); err == nil {
		if dryRun {
			return runWithOutput(ctx, "yum", "check-update")
		}
		return runWithOutput(ctx, "yum", "-y", "update")
	}
	if _, err := exec.LookPath("dnf"); err == nil {
		if dryRun {
			return runWithOutput(ctx, "dnf", "check-update")
		}
		return runWithOutput(ctx, "dnf", "-y", "upgrade")
	}
	return "", fmt.Errorf("no supported package manager found")
}

func (e *Executor) runWindowsUpdate(ctx context.Context, dryRun bool) (string, error) {
	if dryRun {
		return runWithOutput(ctx, "powershell", "-Command",
			"Get-WindowsUpdate -ErrorAction Stop | Select-Object Title,Size,IsDownloaded")
	}
	return runWithOutput(ctx, "powershell", "-Command",
		"Install-WindowsUpdate -AcceptAll -AutoReboot:$false -ErrorAction Stop | Out-String")
}

func (e *Executor) runInstallPackage(ctx context.Context, name, version, packageURL string, dryRun bool) (string, error) {
	if packageURL != "" {
		return e.runInstallPackageFromURL(ctx, packageURL, dryRun)
	}

	pkg := name
	if version != "" {
		pkg = name + "=" + version
	}
	switch runtime.GOOS {
	case "linux":
		if _, err := exec.LookPath("apt-get"); err == nil {
			if dryRun {
				return runWithOutput(ctx, "apt-get", "-s", "install", pkg)
			}
			return runWithOutput(ctx, "apt-get", "-y", "install", pkg)
		}
		if _, err := exec.LookPath("yum"); err == nil {
			if dryRun {
				return fmt.Sprintf("Would install: %s", pkg), nil
			}
			return runWithOutput(ctx, "yum", "-y", "install", pkg)
		}
	case "windows":
		if dryRun {
			return fmt.Sprintf("Would install: %s", pkg), nil
		}
		return runWithOutput(ctx, "winget", "install", "--id", name, "--accept-source-agreements", "--accept-package-agreements")
	}
	return "", fmt.Errorf("unsupported OS")
}

func (e *Executor) runInstallPackageFromURL(ctx context.Context, packageURL string, dryRun bool) (string, error) {
	if dryRun {
		return fmt.Sprintf("Would install uploaded package from %s", packageURL), nil
	}

	tmpDir, err := os.MkdirTemp("", "sms-package-install-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)

	filename := filepath.Base(strings.Split(packageURL, "?")[0])
	if filename == "" || filename == "." || filename == "/" {
		filename = "package.bin"
	}
	localPath := filepath.Join(tmpDir, filename)
	if err := downloadFile(ctx, packageURL, localPath); err != nil {
		return "", fmt.Errorf("download package: %w", err)
	}
	if err := os.Chmod(localPath, 0755); err != nil {
		return "", err
	}

	ext := strings.ToLower(filepath.Ext(localPath))
	switch runtime.GOOS {
	case "linux":
		switch ext {
		case ".deb":
			out, err := runWithOutput(ctx, "dpkg", "-i", localPath)
			if err != nil {
				if _, aptErr := exec.LookPath("apt-get"); aptErr == nil {
					fixOut, fixErr := runWithOutput(ctx, "apt-get", "-f", "-y", "install")
					return out + "\n" + fixOut, fixErr
				}
			}
			return out, err
		case ".rpm":
			if _, err := exec.LookPath("dnf"); err == nil {
				return runWithOutput(ctx, "dnf", "-y", "install", localPath)
			}
			if _, err := exec.LookPath("yum"); err == nil {
				return runWithOutput(ctx, "yum", "-y", "localinstall", localPath)
			}
			return runWithOutput(ctx, "rpm", "-Uvh", localPath)
		case ".apk":
			return runWithOutput(ctx, "apk", "add", "--allow-untrusted", localPath)
		default:
			return runWithOutput(ctx, localPath)
		}
	case "windows":
		switch ext {
		case ".msi":
			return runWithOutput(ctx, "msiexec", "/i", localPath, "/qn", "/norestart")
		case ".msu":
			return runWithOutput(ctx, "wusa", localPath, "/quiet", "/norestart")
		case ".ps1":
			return runWithOutput(ctx, "powershell", "-ExecutionPolicy", "Bypass", "-File", localPath)
		case ".exe":
			out, err := runWithOutput(ctx, localPath, "/quiet", "/norestart")
			if err == nil {
				return out, nil
			}
			fallback, fallbackErr := runWithOutput(ctx, localPath, "/S")
			return out + "\n" + fallback, fallbackErr
		default:
			return runWithOutput(ctx, localPath)
		}
	}

	return "", fmt.Errorf("unsupported OS")
}

func (e *Executor) runScript(ctx context.Context, content, scriptType string, dryRun bool) (string, error) {
	if dryRun {
		return fmt.Sprintf("Dry-run: would execute %s script:\n%s", scriptType, content), nil
	}

	// Write script to temp file
	var ext string
	switch strings.ToLower(scriptType) {
	case "bash", "sh":
		ext = ".sh"
	case "powershell", "ps1":
		ext = ".ps1"
	default:
		ext = ".sh"
	}

	tmpFile, err := os.CreateTemp("", "sms-script-*"+ext)
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(content); err != nil {
		return "", fmt.Errorf("write script: %w", err)
	}
	tmpFile.Close()

	if err := os.Chmod(tmpFile.Name(), 0700); err != nil {
		return "", fmt.Errorf("chmod script: %w", err)
	}

	switch strings.ToLower(scriptType) {
	case "bash", "sh":
		return runWithOutput(ctx, "bash", tmpFile.Name())
	case "powershell", "ps1":
		return runWithOutput(ctx, "powershell", "-ExecutionPolicy", "Bypass", "-File", tmpFile.Name())
	default:
		return runWithOutput(ctx, "bash", tmpFile.Name())
	}
}

func (e *Executor) runServiceControl(ctx context.Context, name, action string, dryRun bool) (string, error) {
	if dryRun {
		return fmt.Sprintf("Dry-run: would %s service %s", action, name), nil
	}
	switch runtime.GOOS {
	case "linux":
		return runWithOutput(ctx, "systemctl", action, name)
	case "windows":
		switch action {
		case "start":
			return runWithOutput(ctx, "sc", "start", name)
		case "stop":
			return runWithOutput(ctx, "sc", "stop", name)
		case "restart":
			if _, err := runWithOutput(ctx, "sc", "stop", name); err != nil {
				// Ignore stop error
			}
			time.Sleep(2 * time.Second)
			return runWithOutput(ctx, "sc", "start", name)
		}
	}
	return "", fmt.Errorf("unsupported action: %s", action)
}

func (e *Executor) runInstallAgent(ctx context.Context, packageURL string, dryRun bool) (string, error) {
	if packageURL == "" {
		defaultURL, err := e.defaultAgentPackageURL()
		if err != nil {
			return "", err
		}
		packageURL = defaultURL
	}
	if dryRun {
		return fmt.Sprintf("Dry-run: would download and install agent from %s", packageURL), nil
	}

	tmpDir, err := os.MkdirTemp("", "sms-agent-install-*")
	if err != nil {
		return "", err
	}

	localPath := filepath.Join(tmpDir, "agent-package"+agentPackageExt())
	if err := downloadFile(ctx, packageURL, localPath); err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	if err := os.Chmod(localPath, 0755); err != nil {
		return "", err
	}
	currentExe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve current executable: %w", err)
	}
	if e.configPath == "" {
		return "", fmt.Errorf("config path required for self-update")
	}

	switch runtime.GOOS {
	case "windows":
		return e.scheduleWindowsSelfUpdate(currentExe, localPath)
	case "linux":
		return e.scheduleLinuxSelfUpdate(currentExe, localPath)
	default:
		return "", fmt.Errorf("self-update not supported on %s", runtime.GOOS)
	}
}

func (e *Executor) defaultAgentPackageURL() (string, error) {
	if e.serverURL == "" {
		return "", fmt.Errorf("server URL is not configured")
	}

	target := ""
	switch runtime.GOOS {
	case "windows":
		if runtime.GOARCH != "amd64" {
			return "", fmt.Errorf("unsupported Windows architecture: %s", runtime.GOARCH)
		}
		target = "agent-windows-amd64"
	case "linux":
		switch runtime.GOARCH {
		case "amd64":
			target = "agent-linux-amd64"
		case "arm64":
			target = "agent-linux-arm64"
		default:
			return "", fmt.Errorf("unsupported Linux architecture: %s", runtime.GOARCH)
		}
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}

	base, err := url.Parse(e.serverURL)
	if err != nil {
		return "", fmt.Errorf("parse server URL: %w", err)
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/api/packages/latest/" + target
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

func agentPackageExt() string {
	switch runtime.GOOS {
	case "windows":
		return ".exe"
	default:
		return ""
	}
}

func (e *Executor) scheduleWindowsSelfUpdate(currentExe, packagePath string) (string, error) {
	scriptPath := filepath.Join(filepath.Dir(packagePath), "sms-agent-update.ps1")
	serviceName := e.serviceName
	if serviceName == "" {
		serviceName = "SMSAgent"
	}

	script := fmt.Sprintf(`$ErrorActionPreference = 'SilentlyContinue'
$serviceName = %q
$packagePath = %q
$targetPath = %q
$configPath = %q
$currentPid = %d
Start-Sleep -Seconds 3
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
  Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
}
try {
  Wait-Process -Id $currentPid -Timeout 30
} catch {}
for ($i = 0; $i -lt 20; $i++) {
  try {
    Copy-Item $packagePath $targetPath -Force
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}
if ($service) {
  Start-Service -Name $serviceName -ErrorAction SilentlyContinue
} else {
  Start-Process -FilePath $targetPath -ArgumentList @('-config', $configPath) -WindowStyle Hidden
}
Remove-Item $packagePath -Force -ErrorAction SilentlyContinue
Remove-Item $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`, serviceName, packagePath, currentExe, e.configPath, os.Getpid())

	if err := os.WriteFile(scriptPath, []byte(script), 0600); err != nil {
		return "", fmt.Errorf("write updater script: %w", err)
	}

	cmd := exec.Command("powershell", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start updater: %w", err)
	}
	if err := cmd.Process.Release(); err != nil {
		return "", fmt.Errorf("detach updater: %w", err)
	}

	return fmt.Sprintf("agent update staged from %s; updater pid scheduled for service %s", packagePath, serviceName), nil
}

func (e *Executor) scheduleLinuxSelfUpdate(currentExe, packagePath string) (string, error) {
	scriptPath := filepath.Join(filepath.Dir(packagePath), "sms-agent-update.sh")
	serviceName := e.serviceName
	if serviceName == "" {
		serviceName = "sms-agent"
	}

	script := fmt.Sprintf(`#!/bin/sh
set +e
SERVICE_NAME=%q
PACKAGE_PATH=%q
TARGET_PATH=%q
CONFIG_PATH=%q
sleep 3
if command -v systemctl >/dev/null 2>&1 && systemctl status "$SERVICE_NAME" >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
fi
for i in $(seq 1 20); do
  cp "$PACKAGE_PATH" "$TARGET_PATH" >/dev/null 2>&1 && chmod 755 "$TARGET_PATH" >/dev/null 2>&1 && break
  sleep 1
done
if command -v systemctl >/dev/null 2>&1 && systemctl status "$SERVICE_NAME" >/dev/null 2>&1; then
  systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || systemctl restart "$SERVICE_NAME" >/dev/null 2>&1
else
  nohup "$TARGET_PATH" -config "$CONFIG_PATH" >/dev/null 2>&1 &
fi
rm -f "$PACKAGE_PATH"
rm -f "$0"
`, serviceName, packagePath, currentExe, e.configPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0700); err != nil {
		return "", fmt.Errorf("write updater script: %w", err)
	}

	cmd := exec.Command("sh", scriptPath)
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start updater: %w", err)
	}
	if err := cmd.Process.Release(); err != nil {
		return "", fmt.Errorf("detach updater: %w", err)
	}

	return fmt.Sprintf("agent update staged from %s; updater will restart %s", packagePath, serviceName), nil
}

func runWithOutput(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var buf bytes.Buffer
	cmd.Stdout = io.MultiWriter(&buf)
	cmd.Stderr = io.MultiWriter(&buf)
	err := cmd.Run()
	return buf.String(), err
}

func downloadFile(ctx context.Context, url, dest string) error {
	if _, err := exec.LookPath("curl"); err == nil {
		_, err := runWithOutput(ctx, "curl", "-kfsSL", "-o", dest, url)
		return err
	}
	if _, err := exec.LookPath("wget"); err == nil {
		_, err := runWithOutput(ctx, "wget", "--no-check-certificate", "-q", "-O", dest, url)
		return err
	}
	if runtime.GOOS == "windows" {
		_, err := runWithOutput(ctx, "powershell", "-Command",
			fmt.Sprintf("Invoke-WebRequest -Uri %q -OutFile %q -SkipCertificateCheck", url, dest))
		return err
	}
	return fmt.Errorf("no download tool available (curl or wget required)")
}

func priorityOrder(p shared.CommandPriority) int {
	switch p {
	case shared.PriorityCritical:
		return 1
	case shared.PriorityHigh:
		return 2
	case shared.PriorityNormal:
		return 3
	case shared.PriorityLow:
		return 4
	default:
		return 3
	}
}
