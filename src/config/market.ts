export const MARKET_CONFIG = {
    PRE_OPEN_DURATION: 15000, // 15 seconds
    LOCKED_DURATION: 5000,    // 5 seconds
};

export enum SessionStatus {
    PRE_OPEN = 'PRE_OPEN',
    LOCKED = 'LOCKED',
    OPEN = 'OPEN',
    CLOSED = 'CLOSED',
    BREAK = 'BREAK'
}
