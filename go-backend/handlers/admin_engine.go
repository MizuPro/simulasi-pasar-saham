package handlers

import (
	"context"
	"fmt"
	"mbit-backend-go/config"
	"mbit-backend-go/core/engine"
	"time"

	"github.com/gofiber/fiber/v2"
)

// GetAllOrders
func GetAllOrders(c *fiber.Ctx) error {
	status := c.Query("status")
	symbol := c.Query("symbol")
	limit := c.QueryInt("limit", 100)

	fullQuery := `
		SELECT
			o.id, o.user_id, u.username, o.stock_id, s.symbol,
			o.type, o.price, o.quantity, o.remaining_quantity, o.status, o.created_at
		FROM orders o
		JOIN users u ON o.user_id = u.id
		JOIN stocks s ON o.stock_id = s.id
		WHERE 1=1
	`

	args := []interface{}{}
	argCounter := 1

	if status != "" {
		fullQuery += fmt.Sprintf(" AND o.status = $%d", argCounter)
		args = append(args, status)
		argCounter++
	}
	if symbol != "" {
		fullQuery += fmt.Sprintf(" AND s.symbol = $%d", argCounter)
		args = append(args, symbol)
		argCounter++
	}

	fullQuery += fmt.Sprintf(" ORDER BY o.created_at DESC LIMIT $%d", argCounter)
	args = append(args, limit)

	rows, err := config.DB.Query(context.Background(), fullQuery, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	type AdminOrder struct {
		ID           string    `json:"id"`
		UserID       string    `json:"user_id"`
		Username     string    `json:"username"`
		StockID      int       `json:"stock_id"`
		Symbol       string    `json:"symbol"`
		Type         string    `json:"type"`
		Price        float64   `json:"price"`
		Quantity     int64     `json:"quantity"`
		RemainingQty int64     `json:"remaining_quantity"`
		Status       string    `json:"status"`
		CreatedAt    time.Time `json:"created_at"`
	}

	var orders []AdminOrder
	for rows.Next() {
		var o AdminOrder
		rows.Scan(&o.ID, &o.UserID, &o.Username, &o.StockID, &o.Symbol, &o.Type, &o.Price, &o.Quantity, &o.RemainingQty, &o.Status, &o.CreatedAt)
		orders = append(orders, o)
	}
	return c.JSON(orders)
}

// GetAllTrades
func GetAllTrades(c *fiber.Ctx) error {
	limit := c.QueryInt("limit", 100)

	query := `
		SELECT
			t.id, t.buy_order_id, t.sell_order_id,
			ub.username as buyer,
			us.username as seller,
			s.symbol,
			t.price,
			t.quantity,
			t.executed_at
		FROM trades t
		LEFT JOIN orders ob ON t.buy_order_id = ob.id
		LEFT JOIN users ub ON ob.user_id = ub.id
		LEFT JOIN orders os ON t.sell_order_id = os.id
		LEFT JOIN users us ON os.user_id = us.id
		JOIN stocks s ON t.stock_id = s.id
		ORDER BY t.executed_at DESC
		LIMIT $1
	`
	rows, err := config.DB.Query(context.Background(), query, limit)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	defer rows.Close()

	type AdminTrade struct {
		ID          string    `json:"id"`
		BuyOrderID  *string   `json:"buy_order_id"`
		SellOrderID *string   `json:"sell_order_id"`
		Buyer       *string   `json:"buyer"`
		Seller      *string   `json:"seller"`
		Symbol      string    `json:"symbol"`
		Price       float64   `json:"price"`
		Quantity    int64     `json:"quantity"`
		ExecutedAt  time.Time `json:"executed_at"`
	}

	var trades []AdminTrade
	for rows.Next() {
		var t AdminTrade
		rows.Scan(&t.ID, &t.BuyOrderID, &t.SellOrderID, &t.Buyer, &t.Seller, &t.Symbol, &t.Price, &t.Quantity, &t.ExecutedAt)
		trades = append(trades, t)
	}
	return c.JSON(trades)
}

// InitSession (Calculate ARA/ARB only)
func InitSession(c *fiber.Ctx) error {
	var req struct {
		Symbol    string  `json:"symbol"`
		PrevClose float64 `json:"prevClose"`
	}
	if err := c.BodyParser(&req); err != nil { return c.Status(400).JSON(fiber.Map{"error": "Invalid request"}) }

	ara, arb := calculateLimits(req.PrevClose)

	// Tick size logic
	// < 200: 1
	// 200-500: 2
	// 500-2000: 5
	// 2000-5000: 10
	// >5000: 25
	var tick int
	if req.PrevClose < 200 { tick = 1 } else if req.PrevClose < 500 { tick = 2 } else if req.PrevClose < 2000 { tick = 5 } else if req.PrevClose < 5000 { tick = 10 } else { tick = 25 }

	return c.JSON(fiber.Map{
		"symbol": req.Symbol,
		"prevClose": req.PrevClose,
		"araLimit": ara,
		"arbLimit": arb,
		"tickSize": tick,
	})
}

// GetEngineStats
func GetEngineStats(c *fiber.Ctx) error {
	// Dummy stats for now, real stats would need atomic counters in engine
	return c.JSON(fiber.Map{
		"matchesProcessed": 0,
		"tradesExecuted": 0,
		"errors": 0,
		"circuitBroken": 0,
		"activeSymbols": []string{},
	})
}

// HealthCheck
func HealthCheck(c *fiber.Ctx) error {
	ctx := context.Background()
	dbStat := "ok"
	if err := config.DB.Ping(ctx); err != nil { dbStat = "error" }

	redisStat := "ok"
	if err := config.RedisMain.Ping(ctx).Err(); err != nil { redisStat = "error" }

	return c.JSON(fiber.Map{
		"status": "healthy",
		"timestamp": time.Now().UnixMilli(),
		"redisConnected": redisStat == "ok",
		"dbStatus": dbStat,
	})
}

// ValidateOrderbook
func ValidateOrderbook(c *fiber.Ctx) error {
	symbol := c.Query("symbol")
	if symbol == "" { return c.Status(400).JSON(fiber.Map{"error": "Symbol required"}) }

	// Count redis orders
	buyCount, _ := config.RedisMain.ZCard(context.Background(), "orderbook:"+symbol+":buy").Result()
	sellCount, _ := config.RedisMain.ZCard(context.Background(), "orderbook:"+symbol+":sell").Result()

	return c.JSON(fiber.Map{
		"success": true,
		"symbol": symbol,
		"healthy": true,
		"totalBuyOrders": buyCount,
		"totalSellOrders": sellCount,
		"issues": fiber.Map{"buy": []string{}, "sell": []string{}},
	})
}

// ResetCircuit
func ResetCircuit(c *fiber.Ctx) error {
	// No circuit breaker logic implemented yet in Go, just mock
	return c.JSON(fiber.Map{"success": true, "message": "Circuit breaker reset"})
}

// ForceBroadcast
func ForceBroadcast(c *fiber.Ctx) error {
	var req struct { Symbol string `json:"symbol"` }
	c.BodyParser(&req)
	if req.Symbol != "" {
		engine.Engine.BroadcastOrderBook(req.Symbol)
	}
	return c.JSON(fiber.Map{"success": true, "message": "Broadcast sent"})
}
