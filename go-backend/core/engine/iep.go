package engine

import (
	"context"
	"encoding/json"
	"math"
	"sort"

	"mbit-backend-go/config"
	"mbit-backend-go/models"

	"github.com/redis/go-redis/v9"
)

type IEPEngine struct{}

func (e *IEPEngine) CalculateIEP(symbol string) (*IEPResult, error) {
	ctx := context.Background()

	// 1. Fetch Orderbook
	buyQueueRaw, err := config.RedisMain.ZRangeWithScores(ctx, "orderbook:"+symbol+":buy", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	sellQueueRaw, err := config.RedisMain.ZRangeWithScores(ctx, "orderbook:"+symbol+":sell", 0, -1).Result()
	if err != nil {
		return nil, err
	}

	if len(buyQueueRaw) == 0 || len(sellQueueRaw) == 0 {
		return nil, nil
	}

	// 2. Parse
	buys := parseOrders(buyQueueRaw)
	sells := parseOrders(sellQueueRaw)

	// 3. Unique Price Levels
	prices := make(map[float64]bool)
	for _, o := range buys {
		prices[o.Price] = true
	}
	for _, o := range sells {
		prices[o.Price] = true
	}

	if len(prices) == 0 {
		return nil, nil
	}

	sortedPrices := make([]float64, 0, len(prices))
	for p := range prices {
		sortedPrices = append(sortedPrices, p)
	}
	sort.Float64s(sortedPrices)

	// 4. Aggregate Volume
	buyVolByPrice := make(map[float64]int64)
	for _, o := range buys {
		buyVolByPrice[o.Price] += o.Data.RemainingQuantity
	}

	sellVolByPrice := make(map[float64]int64)
	for _, o := range sells {
		sellVolByPrice[o.Price] += o.Data.RemainingQuantity
	}

	var candidates []IEPResult

	for _, p := range sortedPrices {
		var cumBuy, cumSell int64

		// Buy: Price >= p
		for bp, vol := range buyVolByPrice {
			if bp >= p {
				cumBuy += vol
			}
		}

		// Sell: Price <= p
		for sp, vol := range sellVolByPrice {
			if sp <= p {
				cumSell += vol
			}
		}

		matched := int64(math.Min(float64(cumBuy), float64(cumSell)))
		if matched > 0 {
			candidates = append(candidates, IEPResult{
				Price:         p,
				MatchedVolume: matched,
				Surplus:       cumBuy - cumSell,
			})
		}
	}

	if len(candidates) == 0 {
		return nil, nil
	}

	// 5. Select Best Price
	// Sort by Volume Desc
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].MatchedVolume > candidates[j].MatchedVolume
	})

	maxVol := candidates[0].MatchedVolume
	// Filter max vol
	var bestCandidates []IEPResult
	for _, c := range candidates {
		if c.MatchedVolume == maxVol {
			bestCandidates = append(bestCandidates, c)
		}
	}

	if len(bestCandidates) == 1 {
		return &bestCandidates[0], nil
	}

	// Sort by Min Absolute Surplus
	sort.Slice(bestCandidates, func(i, j int) bool {
		return math.Abs(float64(bestCandidates[i].Surplus)) < math.Abs(float64(bestCandidates[j].Surplus))
	})

	minSurplus := math.Abs(float64(bestCandidates[0].Surplus))
	var surplusCandidates []IEPResult
	for _, c := range bestCandidates {
		if math.Abs(float64(c.Surplus)) == minSurplus {
			surplusCandidates = append(surplusCandidates, c)
		}
	}

	if len(surplusCandidates) == 1 {
		return &surplusCandidates[0], nil
	}

	// Sort by Closeness to Prev Close (TODO: Fetch Prev Close)
	// For now, pick first (lowest price usually due to earlier sort if distinct)
	// Actually sortedPrices was asc.
	return &surplusCandidates[0], nil
}

func parseOrders(raw []redis.Z) []ParsedOrder {
	var parsed []ParsedOrder
	for _, z := range raw {
		var data models.RedisOrderData
		str, ok := z.Member.(string)
		if !ok {
			continue
		}
		if err := json.Unmarshal([]byte(str), &data); err == nil {
			if data.RemainingQuantity > 0 {
				parsed = append(parsed, ParsedOrder{
					Data:  data,
					Price: z.Score,
					Raw:   str,
				})
			}
		}
	}
	return parsed
}

var GlobalIEPEngine = &IEPEngine{}
