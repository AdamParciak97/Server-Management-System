package db

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DB holds the connection pool and encryption key.
type DB struct {
	Pool    *pgxpool.Pool
	aesKey  []byte
}

// Connect opens a PostgreSQL connection pool.
func Connect(ctx context.Context, dsn string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}

	keyHex := os.Getenv("DB_ENCRYPTION_KEY")
	if keyHex == "" {
		keyHex = "0000000000000000000000000000000000000000000000000000000000000000"
	}
	key, err := decodeKey(keyHex)
	if err != nil {
		return nil, fmt.Errorf("decode encryption key: %w", err)
	}

	return &DB{Pool: pool, aesKey: key}, nil
}

// Close closes the pool.
func (d *DB) Close() {
	d.Pool.Close()
}

func decodeKey(hex string) ([]byte, error) {
	if len(hex) != 64 {
		return nil, fmt.Errorf("DB_ENCRYPTION_KEY must be 64 hex chars (32 bytes)")
	}
	var b [32]byte
	for i := 0; i < 32; i++ {
		n, err := fmt.Sscanf(hex[i*2:i*2+2], "%02x", &b[i])
		if err != nil || n != 1 {
			return nil, fmt.Errorf("invalid hex at position %d", i)
		}
	}
	return b[:], nil
}

// Encrypt encrypts plaintext with AES-256-GCM and returns base64.
func (d *DB) Encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(d.aesKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ct), nil
}

// Decrypt decrypts a base64-encoded AES-256-GCM ciphertext.
func (d *DB) Decrypt(encoded string) (string, error) {
	ct, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(d.aesKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(ct) < gcm.NonceSize() {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ct := ct[:gcm.NonceSize()], ct[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
