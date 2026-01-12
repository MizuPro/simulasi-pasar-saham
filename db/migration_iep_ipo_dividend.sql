-- Migration for IPO and Dividend Systems

-- IPOS Table
CREATE TABLE IF NOT EXISTS public.ipos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_id INTEGER NOT NULL REFERENCES public.stocks(id),
    total_shares BIGINT NOT NULL, -- Total lembar saham yang ditawarkan (dalam Lot atau Lembar? Biasanya Lot di sistem ini, tapi mari asumsi Lot sesuai context) -> Konfirmasi: Lot.
    offering_price NUMERIC(19,4) NOT NULL,
    listing_session_id INTEGER, -- Bisa null jika belum ditentukan
    start_offering_session_id INTEGER,
    end_offering_session_id INTEGER,
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ACTIVE, CLOSED, FINALIZED
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stock_id) REFERENCES public.stocks(id)
);

-- IPO Subscriptions Table
CREATE TABLE IF NOT EXISTS public.ipo_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ipo_id UUID NOT NULL REFERENCES public.ipos(id),
    user_id UUID NOT NULL REFERENCES public.users(id),
    quantity INTEGER NOT NULL, -- Dalam Lot
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ALLOCATED, REFUNDED
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ipo_id, user_id)
);

-- Dividends Table
CREATE TABLE IF NOT EXISTS public.dividends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_id INTEGER NOT NULL REFERENCES public.stocks(id),
    session_id INTEGER REFERENCES public.trading_sessions(id),
    dividend_per_share NUMERIC(19,4) NOT NULL,
    total_payout NUMERIC(19,4) NOT NULL,
    distributed_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Dividend Allocations Table
CREATE TABLE IF NOT EXISTS public.dividend_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dividend_id UUID NOT NULL REFERENCES public.dividends(id),
    user_id UUID NOT NULL REFERENCES public.users(id),
    quantity_owned INTEGER NOT NULL, -- Lot saat cum date
    amount NUMERIC(19,4) NOT NULL, -- Total uang yang diterima
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexing
CREATE INDEX idx_ipos_stock_id ON ipos(stock_id);
CREATE INDEX idx_ipo_subscriptions_user_id ON ipo_subscriptions(user_id);
CREATE INDEX idx_dividend_allocations_user_id ON dividend_allocations(user_id);
