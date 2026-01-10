//types/index.ts

// User Role Types
export type UserRole = 'USER' | 'ADMIN';

// 1. Definisi User & RDN
export interface IUser {
    id: string; // UUID
    username: string;
    full_name: string;
    balance_rdn: number;
    role: UserRole;
    created_at: Date;
}

// 2. Definisi Saham
export interface IStock {
    id: number;
    symbol: string;
    name: string;
    is_active: boolean;
    max_shares: number;    // The limit
    total_shares: number;  // The calculated amount in circulation
}

// 3. Data Harian (ARA/ARB Logic)
export interface IDailyStockData {
    stock_id: number;
    session_id: number;
    prev_close: number;
    open_price: number | null;
    high_price: number | null;
    low_price: number | null;
    close_price: number | null;
    ara_limit: number;
    arb_limit: number;
    volume: number;
}

// 4. Order (Antrean Beli/Jual)
export type OrderType = 'BUY' | 'SELL';
export type OrderStatus = 'PENDING' | 'MATCHED' | 'PARTIAL' | 'CANCELED' | 'REJECTED';

export interface IOrder {
    id: string;
    user_id: string;
    stock_id: number;
    type: OrderType;
    price: number;
    quantity: number; // Dalam Lot
    remaining_quantity: number;
    status: OrderStatus;
    created_at: Date;
}

// 5. Watchlist Item
export interface IWatchlistItem {
    id: number;
    stock_id: number;
    symbol: string;
    name: string;
    created_at: Date;
}

// 6. Candle (OHLC)
export interface ICandle {
    id: number;
    stock_id: number;
    timeframe: '1m' | '5m' | '15m' | '1h' | '1d';
    open_price: number;
    high_price: number;
    low_price: number;
    close_price: number;
    volume: number;
    timestamp: Date;
}

// 7. Orderbook Entry
export interface IOrderbookEntry {
    price: number;
    totalQty: number;
    count: number;
}

export interface IOrderbook {
    symbol: string;
    bids: IOrderbookEntry[];
    asks: IOrderbookEntry[];
}
