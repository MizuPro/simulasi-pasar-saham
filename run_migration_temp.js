"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const database_1 = __importDefault(require("./src/config/database"));
async function run() {
    try {
        const sql = fs_1.default.readFileSync('db/migration_iep_ipo_dividend.sql', 'utf8');
        const client = await database_1.default.connect();
        try {
            await client.query(sql);
            console.log('Migration Success');
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        console.error(e);
    }
    finally {
        await database_1.default.end();
    }
}
run();
