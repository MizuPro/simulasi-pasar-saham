package handlers

import (
	"context"
	"time"

	"mbit-backend-go/config"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
)

// GetSessionStatus returns current session status
func GetSessionStatus(c *fiber.Ctx) error {
	ctx := context.Background()

	// Check table existence (optional safety, skip for perf usually, but Node had it)
	// ... skipping schema check

	var session struct {
		ID        int        `json:"id"`
		Status    string     `json:"status"`
		SessionNo int        `json:"session_number"`
		StartedAt time.Time  `json:"started_at"`
		EndedAt   *time.Time `json:"ended_at"`
	}

	err := config.DB.QueryRow(ctx, `
		SELECT id, status, session_number, started_at, ended_at
		FROM trading_sessions
		ORDER BY id DESC
		LIMIT 1
	`).Scan(&session.ID, &session.Status, &session.SessionNo, &session.StartedAt, &session.EndedAt)

	if err != nil {
		if err == pgx.ErrNoRows {
			return c.JSON(fiber.Map{
				"id":             0,
				"status":         "CLOSED",
				"session_number": 0,
				"started_at":     time.Now(),
				"ended_at":       nil,
				"message":        "Tidak ada sesi aktif",
			})
		}
		return c.JSON(fiber.Map{
			"id":             0,
			"status":         "CLOSED",
			"session_number": 0,
			"started_at":     time.Now(),
			"ended_at":       nil,
			"message":        "Error: " + err.Error(),
		})
	}

	return c.JSON(session)
}
