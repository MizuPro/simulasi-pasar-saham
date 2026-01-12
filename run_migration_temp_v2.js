"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pool = new pg_1.Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5433'),
});
async function run() {
    try {
        const sql = fs_1.default.readFileSync('db/migration_iep_ipo_dividend.sql', 'utf8');
        const client = await pool.connect();
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
        await pool.end();
    }
}
run();
