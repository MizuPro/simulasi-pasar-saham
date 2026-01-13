package handlers

import (
	"context"
	"mbit-backend-go/config"

	"github.com/gofiber/fiber/v2"
)

type CreateStockRequest struct {
	Symbol    string      `json:"symbol"`
	Name      string      `json:"name"`
	MaxShares interface{} `json:"max_shares"` // string or int
}

type UpdateStockRequest struct {
	Name      *string      `json:"name"`
	MaxShares *interface{} `json:"max_shares"`
	IsActive  *bool        `json:"is_active"`
}

type IssueSharesRequest struct {
	UserID   string `json:"userId"`
	Quantity int64  `json:"quantity"`
}

func CreateStock(c *fiber.Ctx) error {
	var req CreateStockRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	if req.Symbol == "" || req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"error": "Symbol dan Name wajib diisi"})
	}

	// Handle max_shares type
	var maxShares int64
	switch v := req.MaxShares.(type) {
	case float64:
		maxShares = int64(v)
	case string:
		// parse string
		// simplified, assume int from json number usually comes as float64
	default:
		maxShares = 1000000 // default or error
	}

	var stockId int
	err := config.DB.QueryRow(context.Background(), `
		INSERT INTO stocks (symbol, name, max_shares, is_active)
		VALUES ($1, $2, $3, true)
		RETURNING id
	`, req.Symbol, req.Name, maxShares).Scan(&stockId)

	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{
		"message": "Saham berhasil ditambahkan",
		"stock": fiber.Map{
			"id":           stockId,
			"symbol":       req.Symbol,
			"name":         req.Name,
			"max_shares":   maxShares, // return as is
			"total_shares": 0,
			"is_active":    true,
		},
	})
}

func UpdateStock(c *fiber.Ctx) error {
	id := c.Params("id")
	var req UpdateStockRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	tx, err := config.DB.Begin(context.Background())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer tx.Rollback(context.Background())

	if req.Name != nil {
		_, err = tx.Exec(context.Background(), "UPDATE stocks SET name = $1 WHERE id = $2", *req.Name, id)
		if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	}
	if req.MaxShares != nil {
		var ms int64
		// similar parsing logic
		switch v := (*req.MaxShares).(type) {
		case float64:
			ms = int64(v)
		}
		if ms > 0 {
			_, err = tx.Exec(context.Background(), "UPDATE stocks SET max_shares = $1 WHERE id = $2", ms, id)
			if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
		}
	}
	if req.IsActive != nil {
		_, err = tx.Exec(context.Background(), "UPDATE stocks SET is_active = $1 WHERE id = $2", *req.IsActive, id)
		if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	}

	if err := tx.Commit(context.Background()); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	// Retrieve updated
	var s struct {
		ID        int    `json:"id"`
		Symbol    string `json:"symbol"`
		Name      string `json:"name"`
		MaxShares int64  `json:"max_shares"` // string in response if node compatibility needed?
		IsActive  bool   `json:"is_active"`
	}
	err = config.DB.QueryRow(context.Background(), "SELECT id, symbol, name, max_shares, is_active FROM stocks WHERE id = $1", id).Scan(
		&s.ID, &s.Symbol, &s.Name, &s.MaxShares, &s.IsActive,
	)

	return c.JSON(fiber.Map{
		"message": "Saham berhasil diperbarui",
		"stock":   s,
	})
}

func IssueShares(c *fiber.Ctx) error {
	stockId := c.Params("id")
	var req IssueSharesRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	ctx := context.Background()
	tx, err := config.DB.Begin(ctx)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	defer tx.Rollback(ctx)

	// 1. Check Max Shares
	var maxShares int64
	var currentIssued int64
	// Calculate current issued from portfolios
	err = tx.QueryRow(ctx, "SELECT max_shares FROM stocks WHERE id = $1", stockId).Scan(&maxShares)
	if err != nil { return c.Status(404).JSON(fiber.Map{"error": "Saham tidak ditemukan"}) }

	err = tx.QueryRow(ctx, "SELECT COALESCE(SUM(quantity_owned), 0) FROM portfolios WHERE stock_id = $1", stockId).Scan(&currentIssued)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	if currentIssued+req.Quantity > maxShares {
		return c.Status(400).JSON(fiber.Map{
			"error": "Melebihi batas max_shares",
			"max": maxShares,
			"current": currentIssued,
			"requested": req.Quantity,
		})
	}

	// 2. Add to Portfolio
	// Upsert
	_, err = tx.Exec(ctx, `
		INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
		VALUES ($1, $2, $3, 0) -- Free shares? Or assume 0 price for issuance
		ON CONFLICT (user_id, stock_id)
		DO UPDATE SET quantity_owned = portfolios.quantity_owned + $3
	`, req.UserID, stockId, req.Quantity)

	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	if err := tx.Commit(ctx); err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	// Get updated portfolio
	var p struct {
		UserID   string `json:"user_id"`
		StockID  int    `json:"stock_id"`
		Quantity int64  `json:"quantity_owned"`
	}
	// Need cast stockId to int
	config.DB.QueryRow(ctx, "SELECT user_id, stock_id, quantity_owned FROM portfolios WHERE user_id = $1 AND stock_id = $2", req.UserID, stockId).Scan(&p.UserID, &p.StockID, &p.Quantity)

	return c.JSON(fiber.Map{
		"message": "Saham berhasil di-issue ke user",
		"portfolio": p,
		"total_shares": currentIssued + req.Quantity,
		"max_shares": maxShares,
		"available_supply": maxShares - (currentIssued + req.Quantity),
	})
}
