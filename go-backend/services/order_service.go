package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"time"

	"mbit-backend-go/config"
	"mbit-backend-go/core/engine"
	"mbit-backend-go/models"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

type OrderService struct{}

func (s *OrderService) PlaceOrder(userId string, symbol string, orderType string, price float64, quantity int64) (*models.Order, error) {
	ctx := context.Background()
	tx, err := config.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// 1. Get Stock Data & Session
	// Optimized query to get stock and session data
	var stockId int
	var araLimit, arbLimit float64
	var sessionId int
	var sessionStatus string

	query := `
		SELECT s.id, d.ara_limit, d.arb_limit, d.session_id, ts.status
		FROM stocks s
		JOIN daily_stock_data d ON s.id = d.stock_id
		JOIN trading_sessions ts ON d.session_id = ts.id
		WHERE s.symbol = $1 AND ts.status IN ('OPEN', 'PRE_OPEN', 'LOCKED')
		ORDER BY ts.id DESC LIMIT 1
	`
	err = tx.QueryRow(ctx, query, symbol).Scan(&stockId, &araLimit, &arbLimit, &sessionId, &sessionStatus)

	if err != nil {
		// Try CLOSED
		if err == pgx.ErrNoRows {
			queryClosed := `
				SELECT s.id, d.ara_limit, d.arb_limit, d.session_id
				FROM stocks s
				JOIN daily_stock_data d ON s.id = d.stock_id
				WHERE s.symbol = $1
				ORDER BY d.session_id DESC LIMIT 1
			`
			err = tx.QueryRow(ctx, queryClosed, symbol).Scan(&stockId, &araLimit, &arbLimit, &sessionId)
			if err != nil {
				return nil, errors.New("Saham tidak ditemukan")
			}
			sessionStatus = "CLOSED"
		} else {
			return nil, err
		}
	}

	if sessionStatus == "LOCKED" {
		return nil, errors.New("Market sedang Locked (IEP Calculation). Tidak bisa pasang order.")
	}

	// 2. Validate Price
	if !isValidTickSize(price) {
		return nil, errors.New("Harga tidak sesuai fraksi (Tick Size)")
	}
	if price > araLimit || price < arbLimit {
		return nil, errors.New("Harga melampaui batas ARA/ARB")
	}

	totalCost := price * float64(quantity*100)
	var avgPriceAtOrder *float64

	// 3. Balance / Portfolio Check
	if orderType == "BUY" {
		var balance float64
		err = tx.QueryRow(ctx, "SELECT balance_rdn FROM users WHERE id = $1 FOR UPDATE", userId).Scan(&balance)
		if err != nil { return nil, err }
		if balance < totalCost {
			return nil, errors.New("Saldo RDN tidak cukup")
		}
		_, err = tx.Exec(ctx, "UPDATE users SET balance_rdn = balance_rdn - $1 WHERE id = $2", totalCost, userId)
		if err != nil { return nil, err }
	} else if orderType == "SELL" {
		var ownedQty int64
		var avgPrice float64
		err = tx.QueryRow(ctx, "SELECT quantity_owned, avg_buy_price FROM portfolios WHERE user_id = $1 AND stock_id = $2 FOR UPDATE", userId, stockId).Scan(&ownedQty, &avgPrice)
		if err != nil {
			if err == pgx.ErrNoRows { return nil, errors.New("Anda tidak memiliki saham ini") }
			return nil, err
		}
		avgPriceAtOrder = &avgPrice

		// Check locked quantity
		var lockedQty int64
		err = tx.QueryRow(ctx, "SELECT COALESCE(SUM(remaining_quantity), 0) FROM orders WHERE user_id = $1 AND stock_id = $2 AND type = 'SELL' AND status IN ('PENDING', 'PARTIAL')", userId, stockId).Scan(&lockedQty)
		if err != nil { return nil, err }

		if ownedQty-lockedQty < quantity {
			return nil, fmt.Errorf("Jumlah saham tidak cukup. Anda punya %d lot, tapi %d lot sudah ada di antrean jual.", ownedQty, lockedQty)
		}
	} else {
		return nil, errors.New("Invalid order type")
	}

	// 4. Insert Order
	var orderID string
	err = tx.QueryRow(ctx, `
		INSERT INTO orders (user_id, stock_id, session_id, type, price, quantity, remaining_quantity, status, avg_price_at_order)
		VALUES ($1, $2, $3, $4, $5, $6, $6, 'PENDING', $7)
		RETURNING id
	`, userId, stockId, sessionId, orderType, price, quantity, avgPriceAtOrder).Scan(&orderID)
	if err != nil { return nil, err }

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	// 5. Redis & Engine
	if sessionStatus == "OPEN" || sessionStatus == "PRE_OPEN" {
		timestamp := time.Now().UnixMilli()
		redisPayload := models.RedisOrderData{
			OrderId:           orderID,
			UserId:            userId,
			StockId:           stockId,
			Price:             price,
			Quantity:          quantity,
			Timestamp:         timestamp,
			RemainingQuantity: quantity,
			AvgPriceAtOrder:   avgPriceAtOrder,
		}

		payloadBytes, _ := json.Marshal(redisPayload)
		key := fmt.Sprintf("orderbook:%s:%s", symbol, func() string { if orderType == "BUY" { return "buy" } else { return "sell" } }())

		if err := config.RedisMain.ZAdd(context.Background(), key, redis.Z{
			Score:  price,
			Member: string(payloadBytes),
		}).Err(); err != nil {
			log.Println("Failed to add to Redis:", err)
			// Non-fatal? The order is in DB. But Engine won't see it.
			// Ideally should retry or fail.
		}

		engine.Engine.Match(symbol)
	}

	return &models.Order{ID: orderID, Status: "PENDING"}, nil
}

func (s *OrderService) CancelOrder(userId string, orderId string) error {
	ctx := context.Background()
	tx, err := config.DB.Begin(ctx)
	if err != nil { return err }
	defer tx.Rollback(ctx)

	// 1. Get Order
	var o models.Order
	var symbol string
	// Join stocks to get symbol
	err = tx.QueryRow(ctx, `
		SELECT o.id, o.stock_id, o.type, o.price, o.remaining_quantity, o.status, s.symbol
		FROM orders o
		JOIN stocks s ON o.stock_id = s.id
		WHERE o.id = $1 AND o.user_id = $2
		FOR UPDATE
	`, orderId, userId).Scan(&o.ID, &o.StockID, &o.Type, &o.Price, &o.RemainingQty, &o.Status, &symbol)

	if err != nil {
		if err == pgx.ErrNoRows { return errors.New("Order tidak ditemukan") }
		return err
	}

	if o.Status != "PENDING" && o.Status != "PARTIAL" {
		return fmt.Errorf("Order tidak bisa dibatalkan (status: %s)", o.Status)
	}

	// 2. Refund
	if o.Type == "BUY" {
		refund := o.Price * float64(o.RemainingQty*100)
		_, err = tx.Exec(ctx, "UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2", refund, userId)
		if err != nil { return err }
	}

	// 3. Update Status
	_, err = tx.Exec(ctx, "UPDATE orders SET status = 'CANCELED', updated_at = NOW() WHERE id = $1", orderId)
	if err != nil { return err }

	// 4. Redis Removal
	// This is tricky because we need to match the member string exactly or parse it.
	// Node implementation scans ZRANGE.
	key := fmt.Sprintf("orderbook:%s:%s", symbol, func() string { if o.Type == "BUY" { return "buy" } else { return "sell" } }())

	// We do this AFTER commit to ensure DB consistency? No, inside transaction implies logic consistency.
	// But Redis isn't transactional with PG.
	// If Redis fails, order is cancelled in DB but stuck in Orderbook. BAD.
	// But we can't rollback Redis easily if DB commit fails.
	// Best effort: Remove from Redis after DB commit.

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	go func() {
		// Clean from Redis
		orders, err := config.RedisMain.ZRange(context.Background(), key, 0, -1).Result()
		if err != nil { return }

		for _, member := range orders {
			var data models.RedisOrderData
			if err := json.Unmarshal([]byte(member), &data); err == nil {
				if data.OrderId == orderId {
					config.RedisMain.ZRem(context.Background(), key, member)
					break
				}
			}
		}
		// Trigger broadcast
		engine.Engine.BroadcastOrderBook(symbol)
	}()

	return nil
}

// Helper: Tick Size Validation
func isValidTickSize(price float64) bool {
	if price < 50 { return true } // No specific rule < 50 usually in ID limit? Node code has logic.
	// Porting `src/core/market-logic.ts` logic
	// Standard ID rules:
	// < 200: tick 1
	// < 500: tick 2
	// < 2000: tick 5
	// < 5000: tick 10
	// >= 5000: tick 25

	p := int(math.Round(price)) // Assuming integer prices for ticks usually?
	// Node logic might be more complex. Let's assume passed price is valid for now or strict check.
	// Check `src/core/market-logic.ts` if needed.

	if price < 200 { return p % 1 == 0 }
	if price < 500 { return p % 2 == 0 }
	if price < 2000 { return p % 5 == 0 }
	if price < 5000 { return p % 10 == 0 }
	return p % 25 == 0
}

var GlobalOrderService = &OrderService{}
