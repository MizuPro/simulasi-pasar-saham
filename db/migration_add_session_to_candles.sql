-- Migration: Menambahkan kolom session_id ke tabel candles dan stock_candles
-- Tujuannya agar setiap candle bisa ditelusuri berasal dari sesi trading mana

-- 1. Tambah kolom session_id ke tabel stock_candles (raw 1m candles)
ALTER TABLE public.stock_candles
    ADD COLUMN IF NOT EXISTS session_id integer REFERENCES public.trading_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_candles_session
    ON public.stock_candles (session_id);

-- 2. Tambah kolom session_id ke tabel candles (multi-timeframe candles)
ALTER TABLE public.candles
    ADD COLUMN IF NOT EXISTS session_id integer REFERENCES public.trading_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_candles_session
    ON public.candles (session_id);

-- Konfirmasi
SELECT 'Migration completed: session_id added to candles tables.' as status;
