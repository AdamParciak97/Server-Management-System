package config

import (
	"fmt"
	"os"
	"runtime"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server struct {
		URL      string `yaml:"url"`       // https://server:8443
		CACert   string `yaml:"ca_cert"`   // path to CA cert
		ClientCert string `yaml:"client_cert"` // path to client cert
		ClientKey  string `yaml:"client_key"`  // path to client key
	} `yaml:"server"`

	Agent struct {
		RegistrationToken string `yaml:"registration_token"`
		PollInterval      int    `yaml:"poll_interval_seconds"` // default 60
		CommandTimeout    int    `yaml:"command_timeout_seconds"` // default 1800
		BufferDB          string `yaml:"buffer_db"`   // path to SQLite
		ServiceName       string `yaml:"service_name"`
		LogFile           string `yaml:"log_file"`
		LogLevel          string `yaml:"log_level"` // debug, info, warn, error
		HealthPort        int    `yaml:"health_port"` // default 9100
		Version           string `yaml:"version"`
	} `yaml:"agent"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	// Defaults
	if cfg.Agent.PollInterval <= 0 {
		cfg.Agent.PollInterval = 60
	}
	if cfg.Agent.CommandTimeout <= 0 {
		cfg.Agent.CommandTimeout = 1800
	}
	if cfg.Agent.BufferDB == "" {
		cfg.Agent.BufferDB = "/var/lib/sms-agent/buffer.db"
	}
	if cfg.Agent.ServiceName == "" {
		if runtime.GOOS == "windows" {
			cfg.Agent.ServiceName = "SMSAgent"
		} else {
			cfg.Agent.ServiceName = "sms-agent"
		}
	}
	if cfg.Agent.HealthPort <= 0 {
		cfg.Agent.HealthPort = 9100
	}
	if cfg.Agent.LogLevel == "" {
		cfg.Agent.LogLevel = "info"
	}
	if cfg.Agent.Version == "" {
		cfg.Agent.Version = "1.0.0"
	}
	return &cfg, nil
}

func DefaultConfig() *Config {
	var cfg Config
	cfg.Server.URL = "https://server:8443"
	cfg.Agent.PollInterval = 60
	cfg.Agent.CommandTimeout = 1800
	cfg.Agent.BufferDB = "/var/lib/sms-agent/buffer.db"
	cfg.Agent.ServiceName = "sms-agent"
	cfg.Agent.HealthPort = 9100
	cfg.Agent.LogLevel = "info"
	cfg.Agent.Version = "1.0.0"
	return &cfg
}

func WriteDefault(path string) error {
	cfg := DefaultConfig()
	cfg.Server.URL = "https://YOUR_SERVER:8443"
	cfg.Agent.RegistrationToken = "YOUR_REGISTRATION_TOKEN"
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}
