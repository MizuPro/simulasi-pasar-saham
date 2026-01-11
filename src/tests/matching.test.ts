
import { MatchingEngine } from '../core/matching-engine';
import redis from '../config/redis';
import pool from '../config/database';

// Mocks
jest.mock('../config/redis', () => ({
    __esModule: true,
    default: {
        zrevrange: jest.fn(),
        zrange: jest.fn(),
        zrem: jest.fn(),
        multi: jest.fn(() => ({
            zrem: jest.fn(),
            zadd: jest.fn(),
            exec: jest.fn().mockResolvedValue([]),
        })),
        scan: jest.fn().mockResolvedValue(['0', []]),
    },
    redisPipeline: jest.fn(),
}));

jest.mock('../config/database', () => {
    const mockQuery = jest.fn();
    const mockClient = {
        query: mockQuery,
        release: jest.fn(),
    };
    return {
        __esModule: true,
        default: {
            connect: jest.fn().mockResolvedValue(mockClient),
            query: mockQuery,
            totalCount: 0,
            idleCount: 0,
            waitingCount: 0,
        },
    };
});

describe('Matching Engine FIFO Logic', () => {
    beforeAll(() => {
        jest.useFakeTimers(); // Stop intervals from keeping process alive
        MatchingEngine.initialize({ to: jest.fn().mockReturnThis(), emit: jest.fn() } as any);
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    test('should match orders based on Price-Time Priority (FIFO)', async () => {
        const symbol = 'TEST';

        const buyOrderA = {
            orderId: 'ORDER-A', userId: 'USER-A', stockId: 1,
            price: 1000, quantity: 10, remaining_quantity: 10, timestamp: 100
        };
        const buyOrderB = {
            orderId: 'ORDER-B', userId: 'USER-B', stockId: 1,
            price: 1000, quantity: 10, remaining_quantity: 10, timestamp: 200
        };
        const sellOrderC = {
            orderId: 'ORDER-C', userId: 'USER-C', stockId: 1,
            price: 1000, quantity: 5, remaining_quantity: 5, timestamp: 300
        };

        // Iteration 1: Returns Orders A, B and C. Match A vs C happens.
        (redis.zrevrange as jest.Mock).mockResolvedValueOnce([
            JSON.stringify(buyOrderA), "1000",
            JSON.stringify(buyOrderB), "1000"
        ]);
        (redis.zrange as jest.Mock).mockResolvedValueOnce([
            JSON.stringify(sellOrderC), "1000"
        ]);

        // Iteration 2: Empty
        (redis.zrevrange as jest.Mock).mockResolvedValueOnce([]);
        (redis.zrange as jest.Mock).mockResolvedValueOnce([]);

        // Mock Database Checks
        const mockClient = await pool.connect();
        const mockQuery = mockClient.query as jest.Mock;

        mockQuery.mockImplementation((query, params) => {
            if (query.includes('FROM orders WHERE id = ANY')) {
                const ids = params[0];
                return {
                    rowCount: ids.length,
                    rows: ids.map((id: string) => ({ id }))
                };
            }
            if (query.includes('INSERT INTO trades')) return { rowCount: 1 };
            if (query.includes('SELECT volume, prev_close')) return { rows: [{ volume: 0, prev_close: 1000 }] };
            return { rowCount: 1, rows: [] };
        });

        // Run Match
        await MatchingEngine.match(symbol);

        // Verify Trade Execution
        const tradeInsertCall = mockQuery.mock.calls.find(call => call[0].includes('INSERT INTO trades'));
        expect(tradeInsertCall).toBeDefined();

        expect(tradeInsertCall[1][0]).toBe('ORDER-A');
        expect(tradeInsertCall[1][1]).toBe('ORDER-C');
    });
});
