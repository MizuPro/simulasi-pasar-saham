package models

import (
	"time"
)

// Updated Models to match DB Schema Types

// User represents the users table
type User struct {
	ID           string    `json:"id" db:"id"`
	Username     string    `json:"username" db:"username"`
	FullName     string    `json:"full_name" db:"full_name"`
	PasswordHash string    `json:"-" db:"password_hash"`
	BalanceRDN   float64   `json:"balance_rdn" db:"balance_rdn"`
	Role         string    `json:"role" db:"role"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time `json:"updated_at" db:"updated_at"` // Not in schema explicitly?
}

// Stock represents the stocks table
type Stock struct {
	ID          int       `json:"id" db:"id"` // Changed to int
	Symbol      string    `json:"symbol" db:"symbol"`
	CompanyName string    `json:"company_name" db:"name"` // Mapped to 'name' column
	InitialPrice float64  `json:"initial_price" db:"initial_price"` // Not in schema 'stocks', likely in 'daily_stock_data' or calculated?
							// Wait, Schema `stocks` only has: id, symbol, name, is_active, max_shares, total_shares_sold.
							// `daily_stock_data` has prices.
							// `GetStocks` query must join.
	CurrentPrice float64  `json:"current_price"` // Calculated/Joined
	TotalShares int64     `json:"total_shares" db:"max_shares"`
	Status      string    `json:"status"` // Mapped from is_active boolean?
}

// Order represents the orders table
type Order struct {
	ID              string    `json:"id" db:"id"`
	UserID          string    `json:"user_id" db:"user_id"`
	StockID         int       `json:"stock_id" db:"stock_id"` // int
	SessionID       *int      `json:"session_id,omitempty" db:"session_id"`
	Type            string    `json:"type" db:"type"`   // BUY, SELL
	Price           float64   `json:"price" db:"price"`
	Quantity        int64     `json:"quantity" db:"quantity"`
	RemainingQty    int64     `json:"remaining_quantity" db:"remaining_quantity"`
	Status          string    `json:"status" db:"status"`
	AvgPriceAtOrder *float64  `json:"avg_price_at_order,omitempty" db:"avg_price_at_order"`
	CreatedAt       time.Time `json:"created_at" db:"created_at"`
	UpdatedAt       time.Time `json:"updated_at" db:"updated_at"`
}

// Trade represents the trades table
type Trade struct {
	ID          string    `json:"id" db:"id"`
	StockID     int       `json:"stock_id" db:"stock_id"` // int
	BuyOrderID  *string   `json:"buy_order_id,omitempty" db:"buy_order_id"`
	SellOrderID *string   `json:"sell_order_id,omitempty" db:"sell_order_id"`
	Price       float64   `json:"price" db:"price"`
	Quantity    int64     `json:"quantity" db:"quantity"`
	ExecutedAt  time.Time `json:"executed_at" db:"executed_at"`
}

// Portfolio represents the portfolio view
type PortfolioItem struct {
	UserID       string    `json:"user_id" db:"user_id"`
	StockID      int       `json:"stock_id" db:"stock_id"` // int
	Symbol       string    `json:"symbol"`
	Quantity     int64     `json:"quantity" db:"quantity_owned"`
	AveragePrice float64   `json:"average_price" db:"avg_buy_price"`
	CurrentPrice float64   `json:"current_price"`
	UnrealizedPL float64   `json:"unrealized_pl"`
}

// RedisOrderData matches the JSON structure stored in Redis
type RedisOrderData struct {
	OrderId           string  `json:"orderId"`
	UserId            string  `json:"userId"`
	StockId           int     `json:"stockId"`
	Price             float64 `json:"price"`
	Quantity          int64   `json:"quantity"`
	Timestamp         int64   `json:"timestamp"` // ms timestamp
	RemainingQuantity int64   `json:"remaining_quantity"`
	AvgPriceAtOrder   *float64 `json:"avg_price_at_order,omitempty"`
}

// MarketSession represents session state
type MarketSession struct {
	ID        int       `json:"id" db:"id"`
	SessionNo int       `json:"session_number" db:"session_number"`
	Status    string    `json:"status" db:"status"` // CLOSED, PRE_OPEN, LOCKED, OPEN
	StartedAt time.Time `json:"started_at" db:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty" db:"ended_at"`
}
