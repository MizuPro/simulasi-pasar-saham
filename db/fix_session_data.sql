-- fix_session_data.sql
-- Script untuk memperbaiki data session yang sudah OPEN tapi belum ada data di daily_stock_data

-- 1. Check apakah ada session OPEN
DO $$
DECLARE
    v_session_id INT;
    v_stock RECORD;
    v_prev_close NUMERIC;
    v_ara NUMERIC;
    v_arb NUMERIC;
    v_percent NUMERIC;
    v_tick NUMERIC;
BEGIN
    -- Get current OPEN session
    SELECT id INTO v_session_id
    FROM trading_sessions
    WHERE status = 'OPEN'
    ORDER BY id DESC
    LIMIT 1;

    IF v_session_id IS NULL THEN
        RAISE NOTICE '❌ Tidak ada session OPEN. Silakan buka session terlebih dahulu.';
        RETURN;
    END IF;

    RAISE NOTICE '✅ Found OPEN session ID: %', v_session_id;

    -- Loop through all active stocks
    FOR v_stock IN
        SELECT s.id, s.symbol
        FROM stocks s
        WHERE s.is_active = true
    LOOP
        -- Check if daily_stock_data already exists
        IF EXISTS (
            SELECT 1 FROM daily_stock_data
            WHERE stock_id = v_stock.id
            AND session_id = v_session_id
        ) THEN
            RAISE NOTICE '  ⏭️  % already has data', v_stock.symbol;
            CONTINUE;
        END IF;

        -- Get prev_close from last candle or last session
        SELECT close_price INTO v_prev_close
        FROM stock_candles
        WHERE stock_id = v_stock.id
        ORDER BY start_time DESC
        LIMIT 1;

        IF v_prev_close IS NULL THEN
            -- Try from previous session
            SELECT COALESCE(close_price, prev_close, 1000) INTO v_prev_close
            FROM daily_stock_data
            WHERE stock_id = v_stock.id
            ORDER BY session_id DESC
            LIMIT 1;

            IF v_prev_close IS NULL THEN
                v_prev_close := 1000;
            END IF;
        END IF;

        -- Calculate tick size
        v_tick := CASE
            WHEN v_prev_close < 200 THEN 1
            WHEN v_prev_close < 500 THEN 2
            WHEN v_prev_close < 2000 THEN 5
            WHEN v_prev_close < 5000 THEN 10
            ELSE 25
        END;

        -- Calculate percentage for ARA/ARB
        v_percent := CASE
            WHEN v_prev_close <= 200 THEN 0.35
            WHEN v_prev_close <= 5000 THEN 0.25
            ELSE 0.20
        END;

        -- Calculate ARA/ARB
        v_ara := floor((v_prev_close + (v_prev_close * v_percent)) / v_tick) * v_tick;
        v_arb := ceil((v_prev_close - (v_prev_close * v_percent)) / v_tick) * v_tick;

        IF v_arb < 0 THEN
            v_arb := 0;
        END IF;

        -- Insert data
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
        VALUES (
            v_stock.id,
            v_session_id,
            v_prev_close,
            v_prev_close,  -- open_price = prev_close initially
            v_prev_close,  -- close_price = prev_close initially
            v_ara,
            v_arb,
            0
        );

        RAISE NOTICE '  ✅ % initialized: prev=%, ara=%, arb=%',
            v_stock.symbol, v_prev_close, v_ara, v_arb;
    END LOOP;

    RAISE NOTICE '✅ All stocks initialized for session %!', v_session_id;
END $$;

-- 2. Verify the data
SELECT
    s.symbol,
    d.prev_close,
    d.open_price,
    d.close_price,
    d.ara_limit,
    d.arb_limit,
    d.volume
FROM daily_stock_data d
JOIN stocks s ON d.stock_id = s.id
WHERE d.session_id = (
    SELECT id FROM trading_sessions
    WHERE status = 'OPEN'
    ORDER BY id DESC
    LIMIT 1
)
ORDER BY s.symbol;

