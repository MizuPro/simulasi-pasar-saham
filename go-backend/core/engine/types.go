package engine

import (
	"mbit-backend-go/models"
)

type ParsedOrder struct {
	Data  models.RedisOrderData
	Price float64
	Raw   string
}

type IEPResult struct {
	Price         float64
	MatchedVolume int64
	Surplus       int64
}

// SessionStatus enum
const (
	StatusClosed  = "CLOSED"
	StatusPreOpen = "PRE_OPEN"
	StatusLocked  = "LOCKED"
	StatusOpen    = "OPEN"
)
