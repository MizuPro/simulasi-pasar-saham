package engine

import (
	"context"
	"math"
	"sort"

	"mbit-backend-go/config"
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

// Function to EXECUTE the IEP match (Call Auction)
func (e *IEPEngine) ExecuteIEP(symbol string, engine *MatchingEngine) error {
	iep, err := e.CalculateIEP(symbol)
	if err != nil || iep == nil {
		return nil
	}

	// Iterate orders and match at IEP Price
	ctx := context.Background()

	// Need to fetch again to be sure of state or reuse if we lock?
	// The caller should have locked the symbol.
	// We assume we are inside the lock.

	// In Call Auction, all Buy orders with Price >= IEP and Sell orders with Price <= IEP are matched at IEP.

	// 1. Fetch
	buyQueueRaw, _ := config.RedisMain.ZRevRangeWithScores(ctx, "orderbook:"+symbol+":buy", 0, -1).Result()
	sellQueueRaw, _ := config.RedisMain.ZRangeWithScores(ctx, "orderbook:"+symbol+":sell", 0, -1).Result()

	buys := parseOrders(buyQueueRaw) // Descending Price
	sells := parseOrders(sellQueueRaw) // Ascending Price

	// 2. Filter eligible
	var eligibleBuys []ParsedOrder
	for _, b := range buys {
		if b.Price >= iep.Price {
			eligibleBuys = append(eligibleBuys, b)
		}
	}

	var eligibleSells []ParsedOrder
	for _, s := range sells {
		if s.Price <= iep.Price {
			eligibleSells = append(eligibleSells, s)
		}
	}

	// 3. Match Loop
	bIdx, sIdx := 0, 0
	for bIdx < len(eligibleBuys) && sIdx < len(eligibleSells) {
		buy := eligibleBuys[bIdx]
		sell := eligibleSells[sIdx]

		// Execute at IEP Price
		if err := engine.ExecuteTrade(buy.Data, sell.Data, iep.Price, symbol, buy.Price, sell.Price, buy.Raw, sell.Raw); err != nil {
			// Log error?
			break
		}

		// Check remaining to advance index
		// Since ExecuteTrade modifies the order in DB and Redis,
		// but `buy` and `sell` structs here are stale copies of Data.RemainingQuantity.
		// However, ExecuteTrade logic uses the passed struct data.
		// Wait, ExecuteTrade logic calculates matchQty based on passed struct.
		// It returns nil on success.
		// We need to update our local state to know if we advanced.

		matchQty := buy.Data.RemainingQuantity
		if sell.Data.RemainingQuantity < matchQty {
			matchQty = sell.Data.RemainingQuantity
		}

		buy.Data.RemainingQuantity -= matchQty
		sell.Data.RemainingQuantity -= matchQty

		eligibleBuys[bIdx] = buy
		eligibleSells[sIdx] = sell

		if buy.Data.RemainingQuantity <= 0 {
			bIdx++
		}
		if sell.Data.RemainingQuantity <= 0 {
			sIdx++
		}
	}

	return nil
}

var GlobalIEPEngine = &IEPEngine{}
