package config

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var DB *pgxpool.Pool

func ConnectDB() {
	user := GetEnv("DB_USER", "postgres")
	pass := GetEnv("DB_PASSWORD", "password")
	host := GetEnv("DB_HOST", "localhost")
	port := GetEnv("DB_PORT", "5432")
	name := GetEnv("DB_NAME", "mbit_db")

	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable", user, pass, host, port, name)

	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatalf("❌ Unable to parse DB config: %v", err)
	}

	// High throughput config mirroring Node.js settings
	config.MaxConns = 60
	config.MinConns = 10
	config.MaxConnIdleTime = 2 * time.Minute
	config.MaxConnLifetime = 30 * time.Minute
	config.HealthCheckPeriod = 1 * time.Minute

	// Connection timeout
	config.ConnConfig.ConnectTimeout = 10 * time.Second

	// Set statement timeout on connect
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET statement_timeout = 10000")
		if err != nil {
			return err
		}
		_, err = conn.Exec(ctx, "SET idle_in_transaction_session_timeout = 30000")
		return err
	}

	DB, err = pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		log.Fatalf("❌ Unable to connect to database: %v", err)
	}

	// Warmup/Check
	if err := DB.Ping(context.Background()); err != nil {
		log.Fatalf("❌ Database ping failed: %v", err)
	}

	log.Println("✅ Database connected successfully with high-throughput pool")

	// Start monitoring goroutine
	go monitorDB()
}

func monitorDB() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		stats := DB.Stat()
		utilization := 0.0
		if stats.TotalConns() > 0 {
			utilization = (float64(stats.AcquiredConns()) / float64(stats.TotalConns())) * 100
		}

		log.Printf("📊 DB Pool: Total=%d, Active=%d, Idle=%d, Waiting=%d (%.1f%% utilized)",
			stats.TotalConns(), stats.AcquiredConns(), stats.IdleConns(), stats.NewConnsCount(), utilization)
	}
}

func CloseDB() {
	if DB != nil {
		DB.Close()
		log.Println("✅ Database pool closed")
	}
}
