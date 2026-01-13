package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"math/rand"
	"time"

	"mbit-backend-go/config"
	"mbit-backend-go/models"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type BotService struct{}

var GlobalBotService = &BotService{}

type StockSupplyInfo struct {
	Symbol            string `json:"symbol"`
	MaxShares         int64  `json:"maxShares"`
	CirculatingShares int64  `json:"circulatingShares"`
	AvailableSupply   int64  `json:"availableSupply"`
	IsFullyDiluted    bool   `json:"isFullyDiluted"`
}

type BotOptions struct {
	MinLot        int64   `json:"minLot"`
	MaxLot        int64   `json:"maxLot"`
	SpreadPercent float64 `json:"spreadPercent"`
	PriceLevels   int     `json:"priceLevels"`
}

type PopulateResult struct {
	Success       bool             `json:"success"`
	Symbol        string           `json:"symbol"`
	PriceLevels   int              `json:"priceLevels"`
	OrdersCreated int              `json:"ordersCreated"`
	ReferencePrice float64         `json:"referencePrice"`
	Supply        StockSupplyInfo  `json:"supply"`
	SellSideActive bool             `json:"sellSideActive"`
	Error         string           `json:"error,omitempty"`
}

type PopulateAllResult struct {
	Success     bool             `json:"success"`
	TotalStocks int              `json:"totalStocks"`
	Results     []PopulateResult `json:"results"`
}

type ClearResult struct {
	Success           bool   `json:"success"`
	Symbol            string `json:"symbol,omitempty"`
	OrdersRemoved     int    `json:"ordersRemoved,omitempty"`
	TotalOrdersRemoved int   `json:"totalOrdersRemoved,omitempty"`
}

type OrderbookSideStats struct {
	Total    int   `json:"total"`
	Bot      int   `json:"bot"`
	User     int   `json:"user"`
	BotLot   int64 `json:"botLot"`
	UserLot  int64 `json:"userLot"`
	TotalLot int64 `json:"totalLot"`
}

type OrderbookStats struct {
	Symbol string             `json:"symbol"`
	Buy    OrderbookSideStats `json:"buy"`
	Sell   OrderbookSideStats `json:"sell"`
	Total  OrderbookSideStats `json:"total"`
}

// GetTickSize returns the tick size for a given price
func GetTickSize(price float64) float64 {
	if price < 200 {
		return 1
	}
	if price < 500 {
		return 2
	}
	if price < 2000 {
		return 5
	}
	if price < 5000 {
		return 10
	}
	return 25
}

func (s *BotService) RoundToTickSize(price float64) float64 {
	tick := GetTickSize(price)
	return math.Round(price/tick) * tick
}

func (s *BotService) GetStockSupplyInfo(symbol string) (*StockSupplyInfo, error) {
	ctx := context.Background()

	var stockID int
	var maxShares int64
	err := config.DB.QueryRow(ctx, "SELECT id, max_shares FROM stocks WHERE symbol = $1", symbol).Scan(&stockID, &maxShares)
	if err != nil {
		return nil, fmt.Errorf("stock %s not found: %v", symbol, err)
	}

	var totalCirculatingShares int64
	err = config.DB.QueryRow(ctx, "SELECT COALESCE(SUM(quantity_owned), 0) FROM portfolios WHERE stock_id = $1", stockID).Scan(&totalCirculatingShares)
	if err != nil {
		return nil, err
	}

	available := maxShares - totalCirculatingShares
	if available < 0 {
		available = 0
	}

	return &StockSupplyInfo{
		Symbol:            symbol,
		MaxShares:         maxShares,
		CirculatingShares: totalCirculatingShares,
		AvailableSupply:   available,
		IsFullyDiluted:    totalCirculatingShares >= maxShares,
	}, nil
}

func (s *BotService) PopulateOrderbook(symbol string, options BotOptions) (*PopulateResult, error) {
	ctx := context.Background()

	// Defaults
	if options.MinLot < 1 { options.MinLot = 1 }
	if options.MaxLot < options.MinLot { options.MaxLot = 10 }
	if options.SpreadPercent == 0 { options.SpreadPercent = 0.5 }
	if options.PriceLevels < 1 { options.PriceLevels = 5 }

	// 1. Get Stock Info
	var stockID int
	var maxShares int64
	err := config.DB.QueryRow(ctx, "SELECT id, max_shares FROM stocks WHERE symbol = $1 AND is_active = true", symbol).Scan(&stockID, &maxShares)
	if err != nil {
		return nil, fmt.Errorf("stock %s not found or inactive", symbol)
	}

	// 2. Check Session
	var sessionID int
	err = config.DB.QueryRow(ctx, "SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1").Scan(&sessionID)
	if err != nil {
		return nil, fmt.Errorf("no active trading session")
	}

	// 3. Supply Info
	supplyInfo, err := s.GetStockSupplyInfo(symbol)
	if err != nil {
		return nil, err
	}

	// 3a. Count existing bot sell orders
	totalBotSellLot := int64(0)
	existingSellOrders, err := config.RedisMain.ZRange(ctx, "orderbook:"+symbol+":sell", 0, -1).Result()
	if err == nil {
		for _, orderStr := range existingSellOrders {
			var order models.RedisOrderData
			if json.Unmarshal([]byte(orderStr), &order) == nil {
				if order.UserId == "SYSTEM_BOT" { // Simplified check
					totalBotSellLot += order.RemainingQuantity
				}
			}
		}
	}

	availableForSell := supplyInfo.AvailableSupply - totalBotSellLot
	canSell := availableForSell > 0

	// 4. Reference Price & Limits
	var prevClose, closePrice, araLimit, arbLimit float64
	// Handle nulls by using COALESCE logic in query or scan into *float64
	// Assuming daily_stock_data columns are numeric/decimal
	err = config.DB.QueryRow(ctx, `
		SELECT
			COALESCE(close_price, prev_close, 0),
			ara_limit,
			arb_limit
		FROM daily_stock_data
		WHERE stock_id = $1 AND session_id = $2
	`, stockID, sessionID).Scan(&prevClose, &araLimit, &arbLimit)

	if err != nil {
		// Fallback if no daily data (shouldn't happen if session is init correctly)
		// Or maybe session just started.
		// Try latest data
		log.Printf("Warning: No daily data for %s session %d. Using fallback.", symbol, sessionID)
		return nil, fmt.Errorf("daily data not found for %s", symbol)
	}

	// Use closePrice variable to avoid unused error
	_ = closePrice

	referencePrice := prevClose
	tickSize := GetTickSize(referencePrice)

	timestamp := time.Now().UnixMilli()

	type OrderRequest struct {
		Type     string
		Price    float64
		Quantity int64
	}
	var orders []OrderRequest

	// 5. Generate BUY orders (BID) - Downwards
	startBid := s.RoundToTickSize(referencePrice * (1 - (options.SpreadPercent / 200.0)))
	for i := 0; i < options.PriceLevels; i++ {
		levelPrice := s.RoundToTickSize(startBid - (float64(i) * tickSize))
		if levelPrice < arbLimit {
			continue
		}

		ordersInLevel := rand.Intn(3) + 1
		for j := 0; j < ordersInLevel; j++ {
			qty := rand.Int63n(options.MaxLot-options.MinLot+1) + options.MinLot
			orders = append(orders, OrderRequest{Type: "BUY", Price: levelPrice, Quantity: qty})
		}
	}

	// 6. Generate SELL orders (OFFER) - Upwards
	totalNewSellLot := int64(0)
	if canSell {
		startOffer := s.RoundToTickSize(referencePrice * (1 + (options.SpreadPercent / 200.0)))
		for i := 0; i < options.PriceLevels; i++ {
			levelPrice := s.RoundToTickSize(startOffer + (float64(i) * tickSize))
			if levelPrice > araLimit {
				continue
			}

			ordersInLevel := rand.Intn(3) + 1
			for j := 0; j < ordersInLevel; j++ {
				qty := rand.Int63n(options.MaxLot-options.MinLot+1) + options.MinLot

				if totalNewSellLot + qty <= availableForSell {
					orders = append(orders, OrderRequest{Type: "SELL", Price: levelPrice, Quantity: qty})
					totalNewSellLot += qty
				} else if totalNewSellLot < availableForSell {
					remaining := availableForSell - totalNewSellLot
					if remaining > 0 {
						orders = append(orders, OrderRequest{Type: "SELL", Price: levelPrice, Quantity: remaining})
						totalNewSellLot += remaining
					}
					goto SellLimitReached // break 2 loops
				}
			}
		}
	}
	SellLimitReached:

	// 7. Insert to Redis
	inserted := 0
	pipeline := config.RedisMain.Pipeline()

	for _, order := range orders {
		orderID := fmt.Sprintf("BOT-%s-%s", order.Type, uuid.New().String())
		redisData := models.RedisOrderData{
			OrderId:           orderID,
			UserId:            "SYSTEM_BOT",
			StockId:           stockID,
			Price:             order.Price,
			Quantity:          order.Quantity,
			RemainingQuantity: order.Quantity,
			Timestamp:         timestamp + rand.Int63n(1000),
		}

		jsonData, _ := json.Marshal(redisData)
		key := fmt.Sprintf("orderbook:%s:%s", symbol, func() string {
			if order.Type == "BUY" { return "buy" }
			return "sell"
		}())

		pipeline.ZAdd(ctx, key, redis.Z{Score: order.Price, Member: jsonData})
		inserted++
	}

	if inserted > 0 {
		_, err = pipeline.Exec(ctx)
		if err != nil {
			return nil, fmt.Errorf("redis pipeline error: %v", err)
		}
	}

	// Update supply info for result
	supplyInfo.CirculatingShares = supplyInfo.CirculatingShares // unchanged actually
	// But we might want to return updated sell stats

	// Create a new supply info for result that includes the bot sell lots info
	// But the struct doesn't have those fields. The Node version returned a mixed object.
	// We'll stick to struct. We can't easily add fields dynamically in Go.
	// We'll trust the logic.

	return &PopulateResult{
		Success:        true,
		Symbol:         symbol,
		PriceLevels:    options.PriceLevels,
		OrdersCreated:  inserted,
		ReferencePrice: referencePrice,
		Supply:         *supplyInfo, // Copy
		SellSideActive: canSell,
	}, nil
}

func (s *BotService) PopulateAllStocks(options BotOptions) (*PopulateAllResult, error) {
	ctx := context.Background()
	rows, err := config.DB.Query(ctx, "SELECT symbol FROM stocks WHERE is_active = true")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []PopulateResult
	count := 0

	for rows.Next() {
		var symbol string
		if err := rows.Scan(&symbol); err != nil {
			continue
		}
		res, err := s.PopulateOrderbook(symbol, options)
		if err != nil {
			results = append(results, PopulateResult{
				Success: false,
				Symbol:  symbol,
				Error:   err.Error(),
			})
		} else {
			results = append(results, *res)
		}
		count++
	}

	return &PopulateAllResult{
		Success:     true,
		TotalStocks: count,
		Results:     results,
	}, nil
}

func (s *BotService) ClearBotOrders(symbol string) (*ClearResult, error) {
	ctx := context.Background()

	if symbol != "" {
		// Clear specific
		pipeline := config.RedisMain.Pipeline()
		removed := 0

		for _, side := range []string{"buy", "sell"} {
			key := fmt.Sprintf("orderbook:%s:%s", symbol, side)
			orders, err := config.RedisMain.ZRange(ctx, key, 0, -1).Result()
			if err != nil { continue }

			for _, orderStr := range orders {
				var order models.RedisOrderData
				if json.Unmarshal([]byte(orderStr), &order) == nil {
					if order.UserId == "SYSTEM_BOT" {
						pipeline.ZRem(ctx, key, orderStr)
						removed++
					}
				}
			}
		}

		if removed > 0 {
			_, err := pipeline.Exec(ctx)
			if err != nil {
				return nil, err
			}
		}

		return &ClearResult{
			Success:       true,
			Symbol:        symbol,
			OrdersRemoved: removed,
		}, nil
	} else {
		// Clear all
		rows, err := config.DB.Query(ctx, "SELECT symbol FROM stocks WHERE is_active = true")
		if err != nil { return nil, err }
		defer rows.Close()

		totalRemoved := 0
		for rows.Next() {
			var sym string
			rows.Scan(&sym)
			res, _ := s.ClearBotOrders(sym)
			if res != nil {
				totalRemoved += res.OrdersRemoved
			}
		}

		return &ClearResult{
			Success:            true,
			TotalOrdersRemoved: totalRemoved,
		}, nil
	}
}

func (s *BotService) GetOrderbookStats(symbol string) (*OrderbookStats, error) {
	ctx := context.Background()

	buyOrders, err := config.RedisMain.ZRange(ctx, "orderbook:"+symbol+":buy", 0, -1).Result()
	if err != nil { return nil, err }
	sellOrders, err := config.RedisMain.ZRange(ctx, "orderbook:"+symbol+":sell", 0, -1).Result()
	if err != nil { return nil, err }

	stats := &OrderbookStats{Symbol: symbol}

	process := func(orders []string, sideStats *OrderbookSideStats) {
		for _, orderStr := range orders {
			sideStats.Total++
			var order models.RedisOrderData
			if json.Unmarshal([]byte(orderStr), &order) != nil { continue }

			lot := order.RemainingQuantity
			sideStats.TotalLot += lot

			if order.UserId == "SYSTEM_BOT" {
				sideStats.Bot++
				sideStats.BotLot += lot
			} else {
				sideStats.User++
				sideStats.UserLot += lot
			}
		}
	}

	process(buyOrders, &stats.Buy)
	process(sellOrders, &stats.Sell)

	stats.Total.Total = stats.Buy.Total + stats.Sell.Total
	stats.Total.Bot = stats.Buy.Bot + stats.Sell.Bot
	stats.Total.User = stats.Buy.User + stats.Sell.User
	stats.Total.TotalLot = stats.Buy.TotalLot + stats.Sell.TotalLot
	stats.Total.BotLot = stats.Buy.BotLot + stats.Sell.BotLot
	stats.Total.UserLot = stats.Buy.UserLot + stats.Sell.UserLot

	return stats, nil
}
