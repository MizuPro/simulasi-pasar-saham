"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const database_1 = __importDefault(require("../src/config/database"));
async function runMigration() {
    try {
        console.log('Running migration...');
        const sqlPath = path_1.default.join(__dirname, 'migration_iep_ipo_dividend.sql');
        const sql = fs_1.default.readFileSync(sqlPath, 'utf8');
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
            console.log('Migration completed successfully.');
        }
        catch (err) {
            await client.query('ROLLBACK');
            console.error('Migration failed:', err);
            process.exit(1);
        }
        finally {
            client.release();
        }
    }
    catch (err) {
        console.error('Error reading migration file:', err);
        process.exit(1);
    }
    finally {
        await database_1.default.end();
    }
}
runMigration();
