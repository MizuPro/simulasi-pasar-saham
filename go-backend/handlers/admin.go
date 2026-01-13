package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"time"

	"mbit-backend-go/config"
	"mbit-backend-go/core/engine"
	"mbit-backend-go/models"
	"mbit-backend-go/services"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

type OpenSessionRequest struct {
	// Empty body is fine
}

func OpenSession(c *fiber.Ctx) error {
	ctx := context.Background()
	tx, err := config.DB.Begin(ctx)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	defer tx.Rollback(ctx)

	// 1. Check existing session
	var count int
	err = tx.QueryRow(ctx, "SELECT COUNT(*) FROM trading_sessions WHERE status IN ('OPEN', 'PRE_OPEN', 'LOCKED')").Scan(&count)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	if count > 0 {
		return c.Status(400).JSON(fiber.Map{"error": "Sudah ada sesi trading yang sedang berjalan"})
	}

	// 2. Create new session (PRE_OPEN)
	var session models.MarketSession
	err = tx.QueryRow(ctx, `
		INSERT INTO trading_sessions (session_number, status, started_at)
		VALUES (
			COALESCE((SELECT MAX(session_number) FROM trading_sessions), 0) + 1,
			'PRE_OPEN',
			NOW()
		)
		RETURNING id, session_number, status, started_at
	`).Scan(&session.ID, &session.SessionNo, &session.Status, &session.StartedAt)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	// 3. Init Daily Stock Data
	// Fetch active stocks
	rows, err := tx.Query(ctx, "SELECT id, symbol FROM stocks WHERE is_active = true")
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	defer rows.Close()

	type Stock struct { ID int; Symbol string }
	var stocks []Stock
	for rows.Next() {
		var s Stock
		if err := rows.Scan(&s.ID, &s.Symbol); err == nil {
			stocks = append(stocks, s)
		}
	}
	rows.Close()

	for _, stock := range stocks {
		// Get last close price
		var prevClose float64 = 1000 // Default
		// Try from candles
		err = tx.QueryRow(ctx, "SELECT close_price FROM stock_candles WHERE stock_id = $1 ORDER BY start_time DESC LIMIT 1", stock.ID).Scan(&prevClose)
		if err == pgx.ErrNoRows {
			// Try from daily_stock_data
			err = tx.QueryRow(ctx, "SELECT COALESCE(close_price, prev_close) FROM daily_stock_data WHERE stock_id = $1 ORDER BY session_id DESC LIMIT 1", stock.ID).Scan(&prevClose)
			if err == pgx.ErrNoRows {
				prevClose = 1000
			}
		}

		araLimit, arbLimit := calculateLimits(prevClose)

		_, err = tx.Exec(ctx, `
			INSERT INTO daily_stock_data (stock_id, session_id, prev_close, open_price, close_price, ara_limit, arb_limit)
			VALUES ($1, $2, $3, $3, $3, $4, $5)
		`, stock.ID, session.ID, prevClose, araLimit, arbLimit)
		if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

		log.Printf("✅ Init %s: prev=%.2f, ara=%.2f, arb=%.2f", stock.Symbol, prevClose, araLimit, arbLimit)
	}

	// 4. Move Pending Orders from Offline
	// Find previous session ID
	var prevSessionId int
	err = tx.QueryRow(ctx, "SELECT id FROM trading_sessions WHERE status = 'CLOSED' AND id < $1 ORDER BY ended_at DESC LIMIT 1", session.ID).Scan(&prevSessionId)
	if err == nil {
		// Move pending orders
		_, err = tx.Exec(ctx, "UPDATE orders SET session_id = $1 WHERE session_id = $2 AND status = 'PENDING'", session.ID, prevSessionId)
		if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

		// Load into Redis
		// Fetch moved orders
		rows, err := tx.Query(ctx, "SELECT o.id, o.user_id, o.stock_id, o.price, o.quantity, o.remaining_quantity, o.created_at, o.type, s.symbol FROM orders o JOIN stocks s ON o.stock_id = s.id WHERE o.session_id = $1 AND o.status = 'PENDING'", session.ID)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var o models.Order
				var symbol string
				var ts time.Time
				if err := rows.Scan(&o.ID, &o.UserID, &o.StockID, &o.Price, &o.Quantity, &o.RemainingQty, &ts, &o.Type, &symbol); err == nil {
					payload := models.RedisOrderData{
						OrderId:           o.ID,
						UserId:            o.UserID,
						StockId:           o.StockID,
						Price:             o.Price,
						Quantity:          o.Quantity,
						RemainingQuantity: o.RemainingQty,
						Timestamp:         ts.UnixMilli(),
					}
					bytes, _ := json.Marshal(payload)
					key := fmt.Sprintf("orderbook:%s:%s", symbol, func() string { if o.Type == "BUY" { return "buy" } else { return "sell" } }())
					config.RedisMain.ZAdd(context.Background(), key, redis.Z{Score: o.Price, Member: string(bytes)})
				}
			}
		}
	}

	if err := tx.Commit(ctx); err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	// 5. Start Background Transitions
	engine.Engine.SessionStatus = engine.StatusPreOpen

	// Need to run transitions in background
	go runSessionTransitions(session.ID)

	return c.JSON(fiber.Map{
		"message": "Sesi trading berhasil dibuka (Pre-Opening)",
		"session": session,
	})
}

func CloseSession(c *fiber.Ctx) error {
	ctx := context.Background()
	tx, err := config.DB.Begin(ctx)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	defer tx.Rollback(ctx)

	// 1. Update status sesi jadi CLOSED
	var sessionId int
	err = tx.QueryRow(ctx, `
		UPDATE trading_sessions
		SET status = 'CLOSED', ended_at = NOW()
		WHERE status IN ('OPEN', 'PRE_OPEN', 'LOCKED')
		RETURNING id
	`).Scan(&sessionId)

	if err != nil {
		if err == pgx.ErrNoRows {
			return c.Status(400).JSON(fiber.Map{"error": "Tidak ada sesi yang sedang berjalan"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	engine.Engine.SessionStatus = engine.StatusClosed

	// 2. Cancel semua order yang masih PENDING/PARTIAL
	// Ambil dulu semua order untuk di-refund
	rows, err := tx.Query(ctx, `
		SELECT o.id, o.user_id, o.type, o.price, o.remaining_quantity, s.symbol
		FROM orders o
		JOIN stocks s ON o.stock_id = s.id
		WHERE o.session_id = $1 AND o.status IN ('PENDING', 'PARTIAL')
	`, sessionId)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	type PendingOrder struct {
		ID           string
		UserID       string
		Type         string
		Price        float64
		RemainingQty int64
		Symbol       string
	}
	var orders []PendingOrder

	for rows.Next() {
		var o PendingOrder
		if err := rows.Scan(&o.ID, &o.UserID, &o.Type, &o.Price, &o.RemainingQty, &o.Symbol); err == nil {
			orders = append(orders, o)
		}
	}
	rows.Close()

	for _, order := range orders {
		if order.Type == "BUY" {
			// Kembalikan saldo RDN
			refund := order.Price * float64(order.RemainingQty * 100) // Assuming 100 shares/lot
			// Use simple update, logic mirroring Node
			_, err := tx.Exec(ctx, "UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2", refund, order.UserID)
			if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
		}

		// Update status order
		_, err := tx.Exec(ctx, "UPDATE orders SET status = 'CANCELED' WHERE id = $1", order.ID)
		if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

		// Hapus dari Redis
		// Optimized: Since we flush all Redis later, we might skip individual ZRem if we just clear everything.
		// The Node code did individual ZRem AND full flush.
		// Let's stick to full flush for efficiency and correctness at end.
		// key := fmt.Sprintf("orderbook:%s:%s", order.Symbol, func() string { if order.Type == "BUY" { return "buy" } else { return "sell" } }())
		// _ = key // unused
	}

	if err := tx.Commit(ctx); err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	// IMPORTANT: Flush all orderbook data from Redis
	// Get all unique symbols
	sRows, err := config.DB.Query(ctx, "SELECT DISTINCT symbol FROM stocks WHERE is_active = true")
	if err == nil {
		defer sRows.Close()
		pipeline := config.RedisMain.Pipeline()
		for sRows.Next() {
			var symbol string
			if err := sRows.Scan(&symbol); err == nil {
				pipeline.Del(ctx, "orderbook:"+symbol+":buy")
				pipeline.Del(ctx, "orderbook:"+symbol+":sell")
			}
		}
		pipeline.Exec(ctx)
	}

	return c.JSON(fiber.Map{
		"message":        "Sesi trading berhasil ditutup",
		"canceledOrders": len(orders),
	})
}

// Bot Handlers
func PopulateBot(c *fiber.Ctx) error {
	var req struct {
		Symbol string `json:"symbol"`
		services.BotOptions
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}

	if req.Symbol == "" {
		return c.Status(400).JSON(fiber.Map{"error": "Symbol diperlukan"})
	}

	result, err := services.GlobalBotService.PopulateOrderbook(req.Symbol, req.BotOptions)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	// Trigger match to broadcast update
	engine.Engine.BroadcastOrderBook(req.Symbol)

	return c.JSON(result)
}

func PopulateAllBots(c *fiber.Ctx) error {
	var body services.BotOptions
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}

	result, err := services.GlobalBotService.PopulateAllStocks(body)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	// Trigger broadcast for all affected
	for _, res := range result.Results {
		if res.Success {
			engine.Engine.BroadcastOrderBook(res.Symbol)
		}
	}

	return c.JSON(result)
}

func ClearBotOrders(c *fiber.Ctx) error {
	symbol := c.Query("symbol")
	result, err := services.GlobalBotService.ClearBotOrders(symbol)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	if symbol != "" {
		engine.Engine.BroadcastOrderBook(symbol)
	} else {
		// Broadcast all active stocks
		// ... optimization: list symbols from somewhere
	}

	return c.JSON(result)
}

func GetBotStats(c *fiber.Ctx) error {
	symbol := c.Params("symbol")
	stats, err := services.GlobalBotService.GetOrderbookStats(symbol)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(stats)
}

func GetBotSupply(c *fiber.Ctx) error {
	symbol := c.Params("symbol")
	info, err := services.GlobalBotService.GetStockSupplyInfo(symbol)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(info)
}

func calculateLimits(prevClose float64) (float64, float64) {
	// Simple Indonesia Stock Exchange logic approximation or mirroring src/core/market-logic.ts
	// < 200: 35%
	// 200 - 5000: 25%
	// > 5000: 20%
	var percentage float64
	if prevClose < 200 {
		percentage = 0.35
	} else if prevClose < 5000 {
		percentage = 0.25
	} else {
		percentage = 0.20
	}

	limitUp := prevClose * (1 + percentage)
	limitDown := prevClose * (1 - percentage)

	return math.Floor(limitUp), math.Ceil(limitDown) // Simplified
}

func runSessionTransitions(sessionId int) {
	log.Println("⏰ Session started: PRE_OPEN")

	// Config durations
	preOpenDur := 15 * time.Second
	lockedDur := 5 * time.Second

	time.Sleep(preOpenDur)

	// PRE_OPEN -> LOCKED
	log.Println("🔒 Entering LOCKED Phase...")
	engine.Engine.SessionStatus = engine.StatusLocked
	config.DB.Exec(context.Background(), "UPDATE trading_sessions SET status = 'LOCKED' WHERE id = $1", sessionId)

	// Trigger matches (Calculates IEP)
	rows, _ := config.DB.Query(context.Background(), "SELECT symbol FROM stocks WHERE is_active = true")
	var symbols []string
	for rows.Next() {
		var s string
		rows.Scan(&s)
		symbols = append(symbols, s)
	}
	rows.Close()

	for _, s := range symbols {
		engine.Engine.Match(s)
	}

	time.Sleep(lockedDur)

	// LOCKED -> OPEN
	log.Println("🔓 Entering OPEN Phase (IEP Execution)...")
	engine.Engine.SessionStatus = engine.StatusOpen
	config.DB.Exec(context.Background(), "UPDATE trading_sessions SET status = 'OPEN' WHERE id = $1", sessionId)

	for _, s := range symbols {
		engine.GlobalIEPEngine.ExecuteIEP(s, engine.Engine)
		engine.Engine.Match(s) // Resume continuous matching
	}

	log.Println("✅ Market fully OPEN")
}
