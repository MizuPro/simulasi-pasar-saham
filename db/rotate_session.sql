-- CLOSE

DO $$
    DECLARE
        v_session_id INT;
    BEGIN
        -- 1. Cari Session ID yang lagi OPEN
        SELECT id INTO v_session_id
        FROM public.trading_sessions
        WHERE status = 'OPEN'
        LIMIT 1;

        IF v_session_id IS NULL THEN
            RAISE NOTICE 'Gak ada sesi yang lagi OPEN bos.';
            RETURN;
        END IF;

        -- 2. REFUND DUIT (Untuk Order BUY yang belum match)
        -- Balikin duit user (saldo_awal + (sisa_qty * harga))
        UPDATE public.users u
        SET balance_rdn = balance_rdn + (o.remaining_quantity * o.price)
        FROM public.orders o
        WHERE u.id = o.user_id
          AND o.session_id = v_session_id
          AND o.type = 'BUY'
          AND o.status IN ('PENDING', 'PARTIAL');

        -- 3. REFUND SAHAM (Untuk Order SELL yang belum match)
        -- Balikin stok saham ke portfolio user
        UPDATE public.portfolios p
        SET quantity_owned = quantity_owned + o.remaining_quantity
        FROM public.orders o
        WHERE p.user_id = o.user_id
          AND p.stock_id = o.stock_id
          AND o.session_id = v_session_id
          AND o.type = 'SELL'
          AND o.status IN ('PENDING', 'PARTIAL');

        -- 4. MATIKAN ORDER (Set ke CANCELED)
        -- Semua order pending di sesi ini dianggap batal
        UPDATE public.orders
        SET status = 'CANCELED'
        WHERE session_id = v_session_id
          AND status IN ('PENDING', 'PARTIAL');

        -- 5. TUTUP SESI
        UPDATE public.trading_sessions
        SET status = 'CLOSED', ended_at = CURRENT_TIMESTAMP
        WHERE id = v_session_id;

        RAISE NOTICE 'Sesi ID % berhasil ditutup. Refund & Cancel selesai.', v_session_id;
        RAISE NOTICE '⚠️  PENTING: Jalankan Redis FLUSHDB atau restart backend untuk membersihkan orderbook cache!';
    END $$;



-- OPEN
DO $$
    DECLARE
        v_last_session_id INT;
        v_new_session_id INT;
        v_next_number INT;
    BEGIN
        -- 1. Ambil data sesi terakhir (buat referensi harga saham & nomor urut)
        SELECT id, session_number INTO v_last_session_id, v_next_number
        FROM public.trading_sessions
        ORDER BY id DESC
        LIMIT 1;

        -- Logic nomor sesi berikutnya
        IF v_next_number IS NULL THEN
            v_next_number := 1;
        ELSE
            v_next_number := v_next_number + 1;
        END IF;

        -- 2. Buat Sesi Baru (OPEN)
        INSERT INTO public.trading_sessions (session_number, status, started_at)
        VALUES (v_next_number, 'OPEN', CURRENT_TIMESTAMP)
        RETURNING id INTO v_new_session_id;

        -- 3. GENERATE DATA SAHAM HARIAN
        -- Logic: Ambil closing price kemarin. Kalau kemarin gak ada trade, ambil prev_close kemarin.
        INSERT INTO public.daily_stock_data
        (
            session_id, stock_id, prev_close,
            open_price, high_price, low_price, close_price,
            ara_limit, arb_limit, volume
        )
        SELECT
            v_new_session_id,                             -- ID Sesi Baru
            dsd.stock_id,
            COALESCE(dsd.close_price, dsd.prev_close),    -- Prev Close Baru
            NULL, NULL, NULL, NULL,                       -- Reset harga OHLC
            -- Hitung ARA (Prev Close + 25%)
            FLOOR(COALESCE(dsd.close_price, dsd.prev_close) * 1.25),
            -- Hitung ARB (Prev Close - 25%)
            CEIL(COALESCE(dsd.close_price, dsd.prev_close) * 0.75),
            0                                             -- Reset Volume nol
        FROM public.daily_stock_data dsd
        WHERE dsd.session_id = v_last_session_id;

        RAISE NOTICE 'Sesi Baru ID % (Nomor %) berhasil dibuka.', v_new_session_id, v_next_number;
    END $$;