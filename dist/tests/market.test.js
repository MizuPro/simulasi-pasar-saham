"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bot_service_1 = require("../services/bot-service");
const market_logic_1 = require("../core/market-logic");
// Mock dependencies
jest.mock('../config/database', () => ({
    __esModule: true,
    default: {
        connect: jest.fn().mockResolvedValue({
            query: jest.fn(),
            release: jest.fn(),
        }),
    },
}));
jest.mock('../config/redis', () => ({
    __esModule: true,
    default: {
        zrange: jest.fn(),
    },
    redisPipeline: jest.fn(),
}));
describe('Market Logic', () => {
    test('getTickSize returns correct tick size for different price ranges', () => {
        expect((0, market_logic_1.getTickSize)(100)).toBe(1);
        expect((0, market_logic_1.getTickSize)(300)).toBe(2);
        expect((0, market_logic_1.getTickSize)(1000)).toBe(5);
        expect((0, market_logic_1.getTickSize)(3000)).toBe(10);
        expect((0, market_logic_1.getTickSize)(10000)).toBe(25);
    });
});
describe('Bot Service Validation', () => {
    test('populateOrderbook validates input options', async () => {
        await expect(bot_service_1.BotService.populateOrderbook('TEST', { minLot: 0 }))
            .rejects.toThrow('minLot must be >= 1');
        await expect(bot_service_1.BotService.populateOrderbook('TEST', { minLot: 10, maxLot: 5 }))
            .rejects.toThrow('maxLot must be >= minLot');
    });
});
