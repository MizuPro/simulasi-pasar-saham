"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const matching_engine_1 = require("../core/matching-engine");
const redis_1 = __importDefault(require("../config/redis"));
const database_1 = __importDefault(require("../config/database"));
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
        matching_engine_1.MatchingEngine.initialize({ to: jest.fn().mockReturnThis(), emit: jest.fn() });
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
        redis_1.default.zrevrange.mockResolvedValueOnce([
            JSON.stringify(buyOrderA), "1000",
            JSON.stringify(buyOrderB), "1000"
        ]);
        redis_1.default.zrange.mockResolvedValueOnce([
            JSON.stringify(sellOrderC), "1000"
        ]);
        // Iteration 2: Empty
        redis_1.default.zrevrange.mockResolvedValueOnce([]);
        redis_1.default.zrange.mockResolvedValueOnce([]);
        // Mock Database Checks
        const mockClient = await database_1.default.connect();
        const mockQuery = mockClient.query;
        mockQuery.mockImplementation((query, params) => {
            if (query.includes('FROM orders WHERE id = ANY')) {
                const ids = params[0];
                return {
                    rowCount: ids.length,
                    rows: ids.map((id) => ({ id }))
                };
            }
            if (query.includes('INSERT INTO trades'))
                return { rowCount: 1 };
            if (query.includes('SELECT volume, prev_close'))
                return { rows: [{ volume: 0, prev_close: 1000 }] };
            return { rowCount: 1, rows: [] };
        });
        // Run Match
        await matching_engine_1.MatchingEngine.match(symbol);
        // Verify Trade Execution
        const tradeInsertCall = mockQuery.mock.calls.find(call => call[0].includes('INSERT INTO trades'));
        expect(tradeInsertCall).toBeDefined();
        expect(tradeInsertCall[1][0]).toBe('ORDER-A');
        expect(tradeInsertCall[1][1]).toBe('ORDER-C');
    });
});
