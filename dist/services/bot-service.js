"use strict";
//services/bot-service.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotService = void 0;
const database_1 = __importDefault(require("../config/database"));
const redis_1 = __importStar(require("../config/redis"));
const uuid_1 = require("uuid");
class BotService {
    /**
     * Mendapatkan informasi supply saham (total beredar vs max_shares)
     */
    static async getStockSupplyInfo(symbol) {
        const client = await database_1.default.connect();
        try {
            const stockRes = await client.query('SELECT id, symbol, max_shares FROM stocks WHERE symbol = $1', [symbol]);
            if (stockRes.rowCount === 0)
                throw new Error(`Stock ${symbol} tidak ditemukan`);
            const stock = stockRes.rows[0];
            const maxShares = parseInt(stock.max_shares) || 0;
            const circulatingRes = await client.query('SELECT SUM(quantity_owned) as total FROM portfolios WHERE stock_id = $1', [stock.id]);
            const totalCirculatingShares = parseInt(circulatingRes.rows[0].total || '0');
            return {
                symbol: stock.symbol,
                maxShares,
                circulatingShares: totalCirculatingShares,
                availableSupply: Math.max(0, maxShares - totalCirculatingShares),
                isFullyDiluted: totalCirculatingShares >= maxShares
            };
        }
        finally {
            client.release();
        }
    }
    /**
     * Generate synthetic orderbook untuk membuat market terlihat aktif
     * Mengisi bid dan offer secara random di sekitar harga referensi
     */
    static async populateOrderbook(symbol, options) {
        const client = await database_1.default.connect();
        try {
            // Default options
            const { minLot = 1, maxLot = 10, spreadPercent = 0.5, priceLevels = 5 } = options || {};
            // 1. Ambil info stock
            const stockRes = await client.query('SELECT id, symbol, max_shares FROM stocks WHERE symbol = $1 AND is_active = true', [symbol]);
            if (stockRes.rowCount === 0)
                throw new Error(`Stock ${symbol} tidak ditemukan`);
            const stock = stockRes.rows[0];
            const maxShares = parseInt(stock.max_shares) || 1000000;
            // 2. Cek session aktif
            const sessionRes = await client.query("SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1");
            if (sessionRes.rowCount === 0)
                throw new Error('Tidak ada sesi trading yang aktif');
            const sessionId = sessionRes.rows[0].id;
            // 3. Cek total saham yang beredar (untuk validasi max_shares)
            const supplyInfo = await this.getStockSupplyInfo(symbol);
            const totalCirculatingShares = supplyInfo.circulatingShares;
            // 3a. Hitung total existing bot sell orders di Redis
            let totalBotSellLot = 0;
            try {
                const existingSellOrders = await redis_1.default.zrange(`orderbook:${symbol}:sell`, 0, -1);
                for (const orderStr of existingSellOrders) {
                    const order = JSON.parse(orderStr);
                    if (order.userId === 'SYSTEM_BOT' || order.orderId.startsWith('BOT-')) {
                        totalBotSellLot += order.remaining_quantity || order.quantity || 0;
                    }
                }
            }
            catch (err) {
                // Jika error saat baca Redis, asumsikan 0
                totalBotSellLot = 0;
            }
            // 3b. Cek apakah masih bisa generate sell orders
            // Total = Portfolio Real User + Bot Sell Orders tidak boleh melebihi max_shares
            const availableForSell = maxShares - totalCirculatingShares - totalBotSellLot;
            const canSell = availableForSell > 0;
            // 4. Ambil harga referensi
            const dailyDataRes = await client.query('SELECT prev_close, close_price, ara_limit, arb_limit FROM daily_stock_data WHERE stock_id = $1 AND session_id = $2', [stock.id, sessionId]);
            if (dailyDataRes.rowCount === 0)
                throw new Error(`Data harian ${symbol} belum ada`);
            const dailyData = dailyDataRes.rows[0];
            const referencePrice = parseFloat(dailyData.close_price || dailyData.prev_close);
            const araLimit = parseFloat(dailyData.ara_limit);
            const arbLimit = parseFloat(dailyData.arb_limit);
            const tickSize = this.getTickSize(referencePrice);
            const timestamp = Date.now();
            const buyOrders = [];
            const sellOrders = [];
            // 5. Generate BUY orders (BID) - Downwards
            const startBid = this.roundToTickSize(referencePrice * (1 - (spreadPercent / 200)));
            for (let i = 0; i < priceLevels; i++) {
                const levelPrice = this.roundToTickSize(startBid - (i * tickSize));
                if (levelPrice < arbLimit)
                    continue; // Jangan tembus ARB (batas bawah)
                const ordersInLevel = Math.floor(Math.random() * 3) + 1;
                for (let j = 0; j < ordersInLevel; j++) {
                    const quantity = Math.floor(Math.random() * (maxLot - minLot + 1)) + minLot;
                    buyOrders.push({ price: levelPrice, quantity });
                }
            }
            // 6. Generate SELL orders (OFFER) - Upwards (Hanya jika belum mencapai max_shares)
            let totalNewSellLot = 0;
            if (canSell) {
                const startOffer = this.roundToTickSize(referencePrice * (1 + (spreadPercent / 200)));
                for (let i = 0; i < priceLevels; i++) {
                    const levelPrice = this.roundToTickSize(startOffer + (i * tickSize));
                    if (levelPrice > araLimit)
                        continue; // Jangan tembus ARA (batas atas)
                    const ordersInLevel = Math.floor(Math.random() * 3) + 1;
                    for (let j = 0; j < ordersInLevel; j++) {
                        const quantity = Math.floor(Math.random() * (maxLot - minLot + 1)) + minLot;
                        // Cek apakah masih ada slot untuk sell order
                        if (totalNewSellLot + quantity <= availableForSell) {
                            sellOrders.push({ price: levelPrice, quantity });
                            totalNewSellLot += quantity;
                        }
                        else if (totalNewSellLot < availableForSell) {
                            // Ambil sisa yang masih bisa
                            const remaining = availableForSell - totalNewSellLot;
                            if (remaining > 0) {
                                sellOrders.push({ price: levelPrice, quantity: remaining });
                                totalNewSellLot += remaining;
                            }
                            break; // Sudah penuh
                        }
                    }
                    if (totalNewSellLot >= availableForSell)
                        break;
                }
            }
            // 7. Insert ke Redis
            let inserted = 0;
            const allToInsert = [];
            allToInsert.push(...buyOrders.map(o => ({ ...o, type: 'BUY' })));
            if (canSell) {
                allToInsert.push(...sellOrders.map(o => ({ ...o, type: 'SELL' })));
            }
            // Use pipeline untuk batch insert (lebih cepat)
            const pipelineCommands = [];
            for (const order of allToInsert) {
                const orderId = `BOT-${order.type}-${(0, uuid_1.v4)()}`;
                const orderData = {
                    orderId,
                    userId: 'SYSTEM_BOT',
                    stockId: stock.id,
                    sessionId,
                    type: order.type,
                    price: order.price,
                    quantity: order.quantity,
                    remaining_quantity: order.quantity,
                    timestamp: timestamp + Math.random() * 1000
                };
                pipelineCommands.push([
                    'zadd',
                    `orderbook:${symbol}:${order.type.toLowerCase()}`,
                    order.price,
                    JSON.stringify(orderData)
                ]);
                inserted++;
            }
            // Execute batch insert
            if (pipelineCommands.length > 0) {
                await (0, redis_1.redisPipeline)(pipelineCommands);
            }
            return {
                success: true,
                symbol,
                priceLevels,
                ordersCreated: inserted,
                referencePrice,
                supply: {
                    ...supplyInfo,
                    existingBotSellLot: totalBotSellLot,
                    newBotSellLot: totalNewSellLot,
                    totalBotSellLot: totalBotSellLot + totalNewSellLot,
                    availableForSell
                },
                sellSideActive: canSell
            };
        }
        finally {
            client.release();
        }
    }
    static getTickSize(price) {
        if (price < 200)
            return 1;
        if (price < 500)
            return 2;
        if (price < 2000)
            return 5;
        if (price < 5000)
            return 10;
        return 25;
    }
    static roundToTickSize(price) {
        const tick = this.getTickSize(price);
        return Math.round(price / tick) * tick;
    }
    /**
     * Populate orderbook untuk semua saham aktif
     */
    static async populateAllStocks(options) {
        const client = await database_1.default.connect();
        try {
            const stocksRes = await client.query(`
                SELECT symbol FROM stocks WHERE is_active = true
            `);
            const results = [];
            for (const stock of stocksRes.rows) {
                try {
                    const result = await this.populateOrderbook(stock.symbol, options);
                    results.push(result);
                }
                catch (err) {
                    results.push({
                        success: false,
                        symbol: stock.symbol,
                        error: err.message
                    });
                }
            }
            return {
                success: true,
                totalStocks: stocksRes.rowCount,
                results
            };
        }
        finally {
            client.release();
        }
    }
    /**
     * Clear synthetic bot orders dari orderbook
     */
    static async clearBotOrders(symbol) {
        try {
            if (symbol) {
                // Clear untuk symbol tertentu
                const [buyOrders, sellOrders] = await Promise.all([
                    redis_1.default.zrange(`orderbook:${symbol}:buy`, 0, -1),
                    redis_1.default.zrange(`orderbook:${symbol}:sell`, 0, -1)
                ]);
                const pipelineCommands = [];
                for (const orderStr of buyOrders) {
                    try {
                        const order = JSON.parse(orderStr);
                        if (order.userId === 'SYSTEM_BOT' || order.orderId?.startsWith('BOT-')) {
                            pipelineCommands.push(['zrem', `orderbook:${symbol}:buy`, orderStr]);
                        }
                    }
                    catch { /* skip corrupt data */ }
                }
                for (const orderStr of sellOrders) {
                    try {
                        const order = JSON.parse(orderStr);
                        if (order.userId === 'SYSTEM_BOT' || order.orderId?.startsWith('BOT-')) {
                            pipelineCommands.push(['zrem', `orderbook:${symbol}:sell`, orderStr]);
                        }
                    }
                    catch { /* skip corrupt data */ }
                }
                // Execute batch delete
                if (pipelineCommands.length > 0) {
                    await (0, redis_1.redisPipeline)(pipelineCommands);
                }
                return { success: true, symbol, ordersRemoved: pipelineCommands.length };
            }
            else {
                // Clear semua stocks
                const client = await database_1.default.connect();
                try {
                    const stocksRes = await client.query(`
                        SELECT symbol FROM stocks WHERE is_active = true
                    `);
                    let totalRemoved = 0;
                    for (const stock of stocksRes.rows) {
                        const result = await this.clearBotOrders(stock.symbol);
                        totalRemoved += (result.ordersRemoved || 0);
                    }
                    return { success: true, totalOrdersRemoved: totalRemoved };
                }
                finally {
                    client.release();
                }
            }
        }
        catch (err) {
            throw new Error(`Failed to clear bot orders: ${err.message}`);
        }
    }
    /**
     * Get statistics dari orderbook
     */
    static async getOrderbookStats(symbol) {
        try {
            const buyOrders = await redis_1.default.zrange(`orderbook:${symbol}:buy`, 0, -1, 'WITHSCORES');
            const sellOrders = await redis_1.default.zrange(`orderbook:${symbol}:sell`, 0, -1, 'WITHSCORES');
            let totalBuy = 0;
            let botBuy = 0;
            let userBuy = 0;
            let botBuyLot = 0;
            let userBuyLot = 0;
            for (let i = 0; i < buyOrders.length; i += 2) {
                totalBuy++;
                const order = JSON.parse(buyOrders[i]);
                const lot = order.remaining_quantity || order.quantity || 0;
                if (order.userId === 'SYSTEM_BOT' || order.orderId.startsWith('BOT-')) {
                    botBuy++;
                    botBuyLot += lot;
                }
                else {
                    userBuy++;
                    userBuyLot += lot;
                }
            }
            let totalSell = 0;
            let botSell = 0;
            let userSell = 0;
            let botSellLot = 0;
            let userSellLot = 0;
            for (let i = 0; i < sellOrders.length; i += 2) {
                totalSell++;
                const order = JSON.parse(sellOrders[i]);
                const lot = order.remaining_quantity || order.quantity || 0;
                if (order.userId === 'SYSTEM_BOT' || order.orderId.startsWith('BOT-')) {
                    botSell++;
                    botSellLot += lot;
                }
                else {
                    userSell++;
                    userSellLot += lot;
                }
            }
            return {
                symbol,
                buy: {
                    total: totalBuy,
                    bot: botBuy,
                    user: userBuy,
                    botLot: botBuyLot,
                    userLot: userBuyLot,
                    totalLot: botBuyLot + userBuyLot
                },
                sell: {
                    total: totalSell,
                    bot: botSell,
                    user: userSell,
                    botLot: botSellLot,
                    userLot: userSellLot,
                    totalLot: botSellLot + userSellLot
                },
                total: {
                    total: totalBuy + totalSell,
                    bot: botBuy + botSell,
                    user: userBuy + userSell,
                    botLot: botBuyLot + botSellLot,
                    userLot: userBuyLot + userSellLot,
                    totalLot: botBuyLot + botSellLot + userBuyLot + userSellLot
                }
            };
        }
        catch (err) {
            throw new Error(`Failed to get orderbook stats: ${err.message}`);
        }
    }
}
exports.BotService = BotService;
