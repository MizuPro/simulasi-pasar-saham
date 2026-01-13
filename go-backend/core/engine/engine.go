package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"mbit-backend-go/config"
	"mbit-backend-go/models"

	"github.com/redis/go-redis/v9"
	socketio "github.com/zishang520/socket.io/v2/socket"
)

type MatchingEngine struct {
	SessionStatus string
	mu            sync.Mutex

	// Processing Queue per symbol (Mutex per symbol)
	symbolLocks sync.Map // map[string]*sync.Mutex

	IoServer *socketio.Server
}

var Engine *MatchingEngine

func InitEngine(io *socketio.Server) {
	Engine = &MatchingEngine{
		SessionStatus: StatusClosed,
		IoServer:      io,
	}
	go Engine.StartStatsLoop()
}

func (e *MatchingEngine) getSymbolLock(symbol string) *sync.Mutex {
	lock, _ := e.symbolLocks.LoadOrStore(symbol, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func (e *MatchingEngine) Match(symbol string) {
	// Goroutine to handle matching to not block caller
	go func() {
		lock := e.getSymbolLock(symbol)
		lock.Lock()
		defer lock.Unlock()

		ctx := context.Background()

		// 1. Check Status
		if e.SessionStatus == StatusPreOpen || e.SessionStatus == StatusLocked {
			// IEP Calculation
			iep, err := GlobalIEPEngine.CalculateIEP(symbol)
			if err != nil {
				log.Println("IEP Error:", err)
				return
			}
			e.broadcastIEP(symbol, iep)
			return
		}

		if e.SessionStatus != StatusOpen {
			return
		}

		// 2. Continuous Matching
		matchOccurred := true
		iterations := 0
		maxIterations := 100

		for matchOccurred && iterations < maxIterations {
			matchOccurred = false
			iterations++

			// Fetch Top Orders
			buyQueue, err := config.RedisMain.ZRevRangeWithScores(ctx, "orderbook:"+symbol+":buy", 0, 19).Result()
			if err != nil {
				break
			}
			sellQueue, err := config.RedisMain.ZRangeWithScores(ctx, "orderbook:"+symbol+":sell", 0, 19).Result()
			if err != nil {
				break
			}

			if len(buyQueue) == 0 || len(sellQueue) == 0 {
				break
			}

			buys := parseOrders(buyQueue)
			sells := parseOrders(sellQueue)

			// Sort (Price desc for buys, asc for sells - already done by ZRange)
			// Secondary sort by Time Asc
			sort.Slice(buys, func(i, j int) bool {
				if buys[i].Price != buys[j].Price {
					return buys[i].Price > buys[j].Price
				}
				return buys[i].Data.Timestamp < buys[j].Data.Timestamp
			})
			sort.Slice(sells, func(i, j int) bool {
				if sells[i].Price != sells[j].Price {
					return sells[i].Price < sells[j].Price
				}
				return sells[i].Data.Timestamp < sells[j].Data.Timestamp
			})

			if len(buys) == 0 || len(sells) == 0 {
				break
			}

			topBuy := buys[0]
			topSell := sells[0]

			if topBuy.Price >= topSell.Price {
				matchOccurred = true

				// Price Time Priority execution price
				execPrice := topBuy.Price
				if topBuy.Data.Timestamp >= topSell.Data.Timestamp {
					execPrice = topSell.Price
				} else {
					execPrice = topBuy.Price
				}

				if err := e.ExecuteTrade(topBuy.Data, topSell.Data, execPrice, symbol, topBuy.Price, topSell.Price, topBuy.Raw, topSell.Raw); err != nil {
					log.Println("Trade execution failed:", err)
					break
				}
			}
		}

		// Broadcast Updates
		e.BroadcastOrderBook(symbol)
	}()
}

func parseOrders(queue []redis.Z) []ParsedOrder {
	var orders []ParsedOrder
	for _, z := range queue {
		str, ok := z.Member.(string)
		if !ok { continue }
		var data models.RedisOrderData
		if err := json.Unmarshal([]byte(str), &data); err != nil { continue }
		orders = append(orders, ParsedOrder{
			Data:  data,
			Price: z.Score,
			Raw:   str,
		})
	}
	return orders
}

func (e *MatchingEngine) ExecuteTrade(buy, sell models.RedisOrderData, price float64, symbol string, buyPrice, sellPrice float64, buyRaw, sellRaw string) error {
	ctx := context.Background()
	tx, err := config.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	matchQty := buy.RemainingQuantity
	if sell.RemainingQuantity < matchQty {
		matchQty = sell.RemainingQuantity
	}

	buyRem := buy.RemainingQuantity - matchQty
	sellRem := sell.RemainingQuantity - matchQty

	var buyOrderID, sellOrderID *string
	if buy.UserId != "SYSTEM_BOT" {
		id := buy.OrderId
		buyOrderID = &id
	}
	if sell.UserId != "SYSTEM_BOT" {
		id := sell.OrderId
		sellOrderID = &id
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO trades (buy_order_id, sell_order_id, stock_id, price, quantity)
		VALUES ($1, $2, $3, $4, $5)
	`, buyOrderID, sellOrderID, buy.StockId, price, matchQty)
	if err != nil {
		return err
	}

	// 2. Update Orders
	if buyOrderID != nil {
		status := "MATCHED"
		if buyRem > 0 { status = "PARTIAL" }
		_, err = tx.Exec(ctx, "UPDATE orders SET status = $1, remaining_quantity = $2, updated_at = NOW() WHERE id = $3", status, buyRem, *buyOrderID)
		if err != nil { return err }
	}
	if sellOrderID != nil {
		status := "MATCHED"
		if sellRem > 0 { status = "PARTIAL" }
		_, err = tx.Exec(ctx, "UPDATE orders SET status = $1, remaining_quantity = $2, updated_at = NOW() WHERE id = $3", status, sellRem, *sellOrderID)
		if err != nil { return err }
	}

	// 3. Update Portfolios
	if buyOrderID != nil && price < buyPrice {
		refund := (buyPrice - price) * float64(matchQty) * 100
		if refund > 0 {
			_, err = tx.Exec(ctx, "UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2", refund, buy.UserId)
			if err != nil { return err }
		}
	}

	if sellOrderID != nil {
		gain := price * float64(matchQty) * 100
		_, err = tx.Exec(ctx, "UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2", gain, sell.UserId)
		if err != nil { return err }
		_, err = tx.Exec(ctx, "UPDATE portfolios SET quantity_owned = quantity_owned - $1 WHERE user_id = $2 AND stock_id = $3", matchQty, sell.UserId, sell.StockId)
		if err != nil { return err }
	}

	if buyOrderID != nil {
		q := `
			INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (user_id, stock_id) DO UPDATE SET
			avg_buy_price = CASE
				WHEN portfolios.quantity_owned + $3 = 0 THEN 0
				ELSE ((portfolios.avg_buy_price * portfolios.quantity_owned) + ($4 * $3)) / (portfolios.quantity_owned + $3)
			END,
			quantity_owned = portfolios.quantity_owned + $3
		`
		_, err = tx.Exec(ctx, q, buy.UserId, buy.StockId, matchQty, price)
		if err != nil { return err }
	}

	// 4. Commit
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// 5. Update Redis
	pipe := config.RedisMain.Pipeline()
	pipe.ZRem(ctx, "orderbook:"+symbol+":buy", buyRaw)
	pipe.ZRem(ctx, "orderbook:"+symbol+":sell", sellRaw)

	if buyRem > 0 {
		newBuy := buy
		newBuy.RemainingQuantity = buyRem
		bytes, _ := json.Marshal(newBuy)
		pipe.ZAdd(ctx, "orderbook:"+symbol+":buy", redis.Z{Score: buyPrice, Member: string(bytes)})
	}
	if sellRem > 0 {
		newSell := sell
		newSell.RemainingQuantity = sellRem
		bytes, _ := json.Marshal(newSell)
		pipe.ZAdd(ctx, "orderbook:"+symbol+":sell", redis.Z{Score: sellPrice, Member: string(bytes)})
	}
	_, err = pipe.Exec(ctx)

	// 6. Notify
	if err == nil {
		e.NotifyTrade(symbol, price, matchQty, buy, sell)
	}

	return err
}

func (e *MatchingEngine) broadcastIEP(symbol string, iep *IEPResult) {
	if e.IoServer != nil {
		e.IoServer.To(socketio.Room(symbol)).Emit("iep_update", iep)
	}
}

func (e *MatchingEngine) BroadcastOrderBook(symbol string) {
	if e.IoServer == nil {
		return
	}

	ctx := context.Background()
	buyQueue, _ := config.RedisMain.ZRevRangeWithScores(ctx, "orderbook:"+symbol+":buy", 0, 49).Result()
	sellQueue, _ := config.RedisMain.ZRangeWithScores(ctx, "orderbook:"+symbol+":sell", 0, 49).Result()

	aggregate := func(queue []redis.Z) []map[string]interface{} {
		var res []map[string]interface{}
		if len(queue) == 0 { return res }

		type Level struct {
			Price    float64
			TotalQty int64
			Count    int
		}
		var current *Level

		for _, z := range queue {
			str, ok := z.Member.(string)
			if !ok { continue }
			var data models.RedisOrderData
			if err := json.Unmarshal([]byte(str), &data); err != nil { continue }
			if data.RemainingQuantity <= 0 { continue }

			if current == nil || current.Price != z.Score {
				if current != nil {
					res = append(res, map[string]interface{}{"price": current.Price, "totalQty": current.TotalQty, "count": current.Count})
				}
				current = &Level{Price: z.Score, TotalQty: 0, Count: 0}
			}
			current.TotalQty += data.RemainingQuantity
			current.Count++
		}
		if current != nil {
			res = append(res, map[string]interface{}{"price": current.Price, "totalQty": current.TotalQty, "count": current.Count})
		}
		return res
	}

	bids := aggregate(buyQueue)
	asks := aggregate(sellQueue)

	if len(bids) > 20 { bids = bids[:20] }
	if len(asks) > 20 { asks = asks[:20] }

	e.IoServer.To(socketio.Room(symbol)).Emit("orderbook_update", map[string]interface{}{
		"symbol":    symbol,
		"bids":      bids,
		"asks":      asks,
		"timestamp": time.Now().UnixMilli(),
	})
}

func (e *MatchingEngine) NotifyTrade(symbol string, price float64, qty int64, buyOrder, sellOrder models.RedisOrderData) {
	if e.IoServer == nil { return }

	ts := time.Now().UnixMilli()

	// Emit Trade (Public)
	e.IoServer.To(socketio.Room(symbol)).Emit("trade", map[string]interface{}{
		"symbol":    symbol,
		"price":     price,
		"quantity":  qty,
		"timestamp": ts,
	})

	// Private Notifications
	if buyOrder.UserId != "SYSTEM_BOT" {
		status := "MATCHED"
		if buyOrder.RemainingQuantity > 0 { status = "PARTIAL" }

		e.IoServer.To(socketio.Room("user:"+buyOrder.UserId)).Emit("order_matched", map[string]interface{}{
			"type": "BUY", "symbol": symbol, "price": price, "quantity": qty,
			"message": fmt.Sprintf("Beli %s: %d lot @ Rp%.0f (%s)", symbol, qty, price, status),
		})

		e.IoServer.To(socketio.Room("user:"+buyOrder.UserId)).Emit("order_status", map[string]interface{}{
			"order_id": buyOrder.OrderId, "status": status, "price": price,
			"matched_quantity": qty, "remaining_quantity": buyOrder.RemainingQuantity,
			"symbol": symbol, "type": "BUY", "timestamp": ts,
		})
	}

	if sellOrder.UserId != "SYSTEM_BOT" {
		status := "MATCHED"
		if sellOrder.RemainingQuantity > 0 { status = "PARTIAL" }

		e.IoServer.To(socketio.Room("user:"+sellOrder.UserId)).Emit("order_matched", map[string]interface{}{
			"type": "SELL", "symbol": symbol, "price": price, "quantity": qty,
			"message": fmt.Sprintf("Jual %s: %d lot @ Rp%.0f (%s)", symbol, qty, price, status),
		})

		e.IoServer.To(socketio.Room("user:"+sellOrder.UserId)).Emit("order_status", map[string]interface{}{
			"order_id": sellOrder.OrderId, "status": status, "price": price,
			"matched_quantity": qty, "remaining_quantity": sellOrder.RemainingQuantity,
			"symbol": symbol, "type": "SELL", "timestamp": ts,
		})
	}
}

func (e *MatchingEngine) StartStatsLoop() {
	// Log stats every minute
}
