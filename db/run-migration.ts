
import fs from 'fs';
import path from 'path';
import pool from '../src/config/database';

async function runMigration() {
    try {
        console.log('Running migration...');
        const sqlPath = path.join(__dirname, 'migration_update_trades_for_bots.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
            console.log('Migration completed successfully.');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Migration failed:', err);
            process.exit(1);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error reading migration file:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigration();
