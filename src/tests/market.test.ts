import { BotService } from '../services/bot-service';
import { getTickSize } from '../core/market-logic';

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
        expect(getTickSize(100)).toBe(1);
        expect(getTickSize(300)).toBe(2);
        expect(getTickSize(1000)).toBe(5);
        expect(getTickSize(3000)).toBe(10);
        expect(getTickSize(10000)).toBe(25);
    });
});

describe('Bot Service Validation', () => {
    test('populateOrderbook validates input options', async () => {
        await expect(BotService.populateOrderbook('TEST', { minLot: 0 }))
            .rejects.toThrow('minLot must be >= 1');

        await expect(BotService.populateOrderbook('TEST', { minLot: 10, maxLot: 5 }))
            .rejects.toThrow('maxLot must be >= minLot');
    });
});
