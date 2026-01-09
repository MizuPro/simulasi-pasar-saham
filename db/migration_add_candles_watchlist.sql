-- Migration: Menambahkan tabel candles (multi-timeframe) dan watchlists
-- Jalankan script ini di database PostgreSQL

-- 1. Tabel candles untuk multi-timeframe support (1m, 5m, 15m, 1h, 1d)
CREATE TABLE IF NOT EXISTS public.candles
(
    id          serial PRIMARY KEY,
    stock_id    integer        NOT NULL REFERENCES public.stocks ON DELETE CASCADE,
    timeframe   varchar(5)     NOT NULL DEFAULT '1m',
    open_price  numeric(15, 2) NOT NULL,
    high_price  numeric(15, 2) NOT NULL,
    low_price   numeric(15, 2) NOT NULL,
    close_price numeric(15, 2) NOT NULL,
    volume      integer        NOT NULL DEFAULT 0,
    timestamp   timestamp      NOT NULL,
    created_at  timestamp      DEFAULT now(),
    UNIQUE (stock_id, timeframe, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_candles_multi_timeframe
    ON public.candles (stock_id, timeframe, timestamp);

-- 2. Tabel watchlists untuk menyimpan saham favorit user
CREATE TABLE IF NOT EXISTS public.watchlists
(
    id         serial PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES public.users ON DELETE CASCADE,
    stock_id   integer     NOT NULL REFERENCES public.stocks ON DELETE CASCADE,
    created_at timestamp   DEFAULT now(),
    UNIQUE (user_id, stock_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlists_user
    ON public.watchlists (user_id);

-- Konfirmasi
SELECT 'Migration completed: candles and watchlists tables created.' as status;

