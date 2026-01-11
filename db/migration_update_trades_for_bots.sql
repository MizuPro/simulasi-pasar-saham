ALTER TABLE trades ADD COLUMN stock_id INTEGER;
ALTER TABLE trades ALTER COLUMN buy_order_id DROP NOT NULL;
ALTER TABLE trades ALTER COLUMN sell_order_id DROP NOT NULL;
ALTER TABLE trades ADD CONSTRAINT fk_trades_stock FOREIGN KEY (stock_id) REFERENCES stocks(id);

-- Update existing trades to have stock_id based on buy_order_id (if available)
UPDATE trades
SET stock_id = orders.stock_id
FROM orders
WHERE trades.buy_order_id = orders.id AND trades.stock_id IS NULL;

-- Update existing trades to have stock_id based on sell_order_id (if available and not yet set)
UPDATE trades
SET stock_id = orders.stock_id
FROM orders
WHERE trades.sell_order_id = orders.id AND trades.stock_id IS NULL;
