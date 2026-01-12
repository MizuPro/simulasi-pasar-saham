"use strict";
// src/config/market.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARKET_CONFIG = void 0;
exports.MARKET_CONFIG = {
    // IEP Duration in milliseconds
    IEP_DURATION_MS: 15000,
    // Limits
    MAX_ORDER_PRICE_RATIO: 0.35, // ARA/ARB limit ratio (approx, logic is in market-logic.ts)
};
