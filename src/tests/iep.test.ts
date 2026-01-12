
import { IEPEngine } from '../core/iep-engine';

// Mock Redis directly here
jest.mock('../config/redis', () => {
    return {
        default: {
            zrange: jest.fn(),
            zrevrange: jest.fn(),
            zadd: jest.fn(),
            zrem: jest.fn()
        },
        __esModule: true
    };
});

// Mock Pool
jest.mock('../config/database', () => {
    return {
        default: {
            query: jest.fn().mockResolvedValue({ rows: [{ prev_close: 1000 }] }) // Mock Prev Close
        },
        __esModule: true
    };
});

import redis from '../config/redis';

describe('IEP Engine', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should calculate correct IEP based on Max Volume', async () => {
        const symbol = 'IEPTEST';

        // Mock Orderbook Data (ZRange returns array of [payload, price, payload, price...])
        // Need to simulate redis response structure for zrange with WITHSCORES
        // redis returns: [member1, score1, member2, score2, ...] as string[]

        // Buy Orders:
        // 10 lot @ 1000
        // 20 lot @ 900
        // 50 lot @ 800
        const buyOrders = [
            JSON.stringify({ remaining_quantity: 10 }), '1000',
            JSON.stringify({ remaining_quantity: 20 }), '900',
            JSON.stringify({ remaining_quantity: 50 }), '800'
        ];

        // Sell Orders:
        // 5 lot @ 700
        // 15 lot @ 900
        // 30 lot @ 1000
        const sellOrders = [
            JSON.stringify({ remaining_quantity: 5 }), '700',
            JSON.stringify({ remaining_quantity: 15 }), '900',
            JSON.stringify({ remaining_quantity: 30 }), '1000'
        ];

        (redis.zrange as jest.Mock).mockImplementation((key) => {
            if (key.includes(':buy')) return Promise.resolve(buyOrders);
            if (key.includes(':sell')) return Promise.resolve(sellOrders);
            return Promise.resolve([]);
        });

        // Run Calculation
        const result = await IEPEngine.calculateIEP(symbol);

        // Analysis:
        // P=700: Buy=80, Sell=5 -> Match 5
        // P=800: Buy=80, Sell=5 -> Match 5
        // P=900: Buy=30, Sell=20 -> Match 20
        // P=1000: Buy=10, Sell=50 -> Match 10
        // Max Volume = 20 @ 900.

        expect(result).not.toBeNull();
        expect(result?.price).toBe(900);
        expect(result?.matchedVolume).toBe(20);
    });

    test('should return null if no overlap', async () => {
        const symbol = 'NOOVERLAP';

        const buyOrders = [
            JSON.stringify({ remaining_quantity: 10 }), '800'
        ];

        const sellOrders = [
            JSON.stringify({ remaining_quantity: 10 }), '900'
        ];

        (redis.zrange as jest.Mock).mockImplementation((key) => {
            if (key.includes(':buy')) return Promise.resolve(buyOrders);
            if (key.includes(':sell')) return Promise.resolve(sellOrders);
            return Promise.resolve([]);
        });

        const result = await IEPEngine.calculateIEP(symbol);

        // P=800: Buy=10, Sell=0 -> Match 0
        // P=900: Buy=0, Sell=10 -> Match 0

        expect(result).toBeNull();
    });
});
