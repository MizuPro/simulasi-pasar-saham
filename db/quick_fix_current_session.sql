-- quick_fix_current_session.sql
-- Quick fix untuk session yang sedang OPEN tapi data tidak lengkap

-- Langsung update/insert data untuk session OPEN
WITH open_session AS (
    SELECT id as session_id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1
),
stock_prices AS (
    SELECT
        s.id as stock_id,
        s.symbol,
        COALESCE(
            (SELECT close_price FROM stock_candles WHERE stock_id = s.id ORDER BY start_time DESC LIMIT 1),
            (SELECT COALESCE(close_price, prev_close, 1000) FROM daily_stock_data WHERE stock_id = s.id ORDER BY session_id DESC LIMIT 1),
            1000
        ) as prev_close
    FROM stocks s
    WHERE s.is_active = true
),
calculated_limits AS (
    SELECT
        stock_id,
        symbol,
        prev_close,
        -- Tick size
        CASE
            WHEN prev_close < 200 THEN 1
            WHEN prev_close < 500 THEN 2
            WHEN prev_close < 2000 THEN 5
            WHEN prev_close < 5000 THEN 10
            ELSE 25
        END as tick,
        -- Percentage
        CASE
            WHEN prev_close <= 200 THEN 0.35
            WHEN prev_close <= 5000 THEN 0.25
            ELSE 0.20
        END as percent
    FROM stock_prices
),
final_limits AS (
    SELECT
        stock_id,
        symbol,
        prev_close,
        floor((prev_close + (prev_close * percent)) / tick) * tick as ara_limit,
        GREATEST(0, ceil((prev_close - (prev_close * percent)) / tick) * tick) as arb_limit
    FROM calculated_limits
)
INSERT INTO daily_stock_data (
    stock_id,
    session_id,
    prev_close,
    open_price,
    close_price,
    ara_limit,
    arb_limit,
    volume
)
SELECT
    fl.stock_id,
    os.session_id,
    fl.prev_close,
    fl.prev_close,
    fl.prev_close,
    fl.ara_limit,
    fl.arb_limit,
    0
FROM final_limits fl
CROSS JOIN open_session os
ON CONFLICT (stock_id, session_id) DO UPDATE
SET
    prev_close = EXCLUDED.prev_close,
    open_price = COALESCE(daily_stock_data.open_price, EXCLUDED.open_price),
    close_price = COALESCE(daily_stock_data.close_price, EXCLUDED.close_price),
    ara_limit = EXCLUDED.ara_limit,
    arb_limit = EXCLUDED.arb_limit;

-- Show results
SELECT
    s.symbol,
    d.prev_close,
    d.ara_limit,
    d.arb_limit,
    d.open_price,
    d.close_price,
    d.volume,
    ts.session_number,
    ts.status
FROM daily_stock_data d
JOIN stocks s ON d.stock_id = s.id
JOIN trading_sessions ts ON d.session_id = ts.id
WHERE ts.status = 'OPEN'
ORDER BY s.symbol;

