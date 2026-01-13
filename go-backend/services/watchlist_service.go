package services

import (
	"context"
	"fmt"
	"time"

	"mbit-backend-go/config"

	"github.com/jackc/pgx/v5"
)

type WatchlistItem struct {
	ID        int       `json:"id"`
	StockID   int       `json:"stock_id"`
	Symbol    string    `json:"symbol"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type WatchlistService struct{}

var GlobalWatchlistService = &WatchlistService{}

func (s *WatchlistService) GetWatchlist(userID string) ([]WatchlistItem, error) {
	ctx := context.Background()
	query := `
		SELECT
			w.id,
			w.stock_id,
			s.symbol,
			s.name,
			w.created_at
		FROM watchlists w
		JOIN stocks s ON w.stock_id = s.id
		WHERE w.user_id = $1
		ORDER BY w.created_at DESC
	`
	rows, err := config.DB.Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []WatchlistItem
	for rows.Next() {
		var item WatchlistItem
		if err := rows.Scan(&item.ID, &item.StockID, &item.Symbol, &item.Name, &item.CreatedAt); err != nil {
			continue
		}
		items = append(items, item)
	}

	if items == nil {
		items = []WatchlistItem{}
	}

	return items, nil
}

func (s *WatchlistService) AddToWatchlist(userID string, symbol string) (*WatchlistItem, error) {
	ctx := context.Background()

	// Check stock
	var stockID int
	var stockName string
	err := config.DB.QueryRow(ctx, "SELECT id, name FROM stocks WHERE symbol = $1 AND is_active = true", symbol).Scan(&stockID, &stockName)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("saham tidak ditemukan atau tidak aktif")
		}
		return nil, err
	}

	// Insert
	var item WatchlistItem
	err = config.DB.QueryRow(ctx, `
		INSERT INTO watchlists (user_id, stock_id)
		VALUES ($1, $2)
		ON CONFLICT (user_id, stock_id) DO NOTHING
		RETURNING id, stock_id, created_at
	`, userID, stockID).Scan(&item.ID, &item.StockID, &item.CreatedAt)

	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("saham sudah ada di watchlist")
		}
		return nil, err
	}

	item.Symbol = symbol
	item.Name = stockName

	return &item, nil
}

func (s *WatchlistService) RemoveFromWatchlist(userID string, symbol string) error {
	ctx := context.Background()

	// Get stock id
	var stockID int
	err := config.DB.QueryRow(ctx, "SELECT id FROM stocks WHERE symbol = $1", symbol).Scan(&stockID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return fmt.Errorf("saham tidak ditemukan")
		}
		return err
	}

	// Delete
	tag, err := config.DB.Exec(ctx, "DELETE FROM watchlists WHERE user_id = $1 AND stock_id = $2", userID, stockID)
	if err != nil {
		return err
	}

	if tag.RowsAffected() == 0 {
		return fmt.Errorf("saham tidak ada di watchlist")
	}

	return nil
}
