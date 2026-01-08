-- ============================================
-- SCRIPT: TUTUP DAN BUKA SESI TRADING BARU
-- Database: mbit_db
-- Tanggal: 2026-01-07
-- ============================================

-- LANGKAH 1: CEK STATUS SESI SAAT INI
-- ============================================
SELECT
    id,
    session_date,
    status,
    created_at,
    closed_at
FROM trading_sessions
ORDER BY id DESC
LIMIT 5;

-- Output akan menunjukkan sesi terakhir dan statusnya (OPEN/CLOSED)


-- LANGKAH 2: CEK ORDER YANG MASIH PENDING/PARTIAL
-- ============================================
-- PENTING: Jika ada order pending, Anda harus batalkan dulu
-- untuk mengembalikan saldo/saham ke user

SELECT
    o.id,
    o.type,
    s.symbol,
    o.price,
    o.quantity,
    o.remaining_quantity,
    o.status,
    u.username
FROM orders o
JOIN stocks s ON o.stock_id = s.id
JOIN users u ON o.user_id = u.id
WHERE o.status IN ('PENDING', 'PARTIAL')
ORDER BY o.created_at DESC;

-- Jika hasilnya > 0 baris, lebih aman gunakan API endpoint /api/admin/session/close
-- karena endpoint tersebut otomatis melakukan refund


-- LANGKAH 3: TUTUP SESI YANG SEDANG OPEN (MANUAL)
-- ============================================
-- ⚠️ PERINGATAN: Hanya jalankan ini jika tidak ada order pending
-- atau jika Anda sudah yakin

BEGIN;

-- Update status sesi jadi CLOSED
UPDATE trading_sessions
SET
    status = 'CLOSED',
    closed_at = NOW()
WHERE status = 'OPEN'
RETURNING id, session_date, status, closed_at;

-- Jika berhasil, akan menampilkan baris sesi yang ditutup
-- Jika tidak ada output, berarti tidak ada sesi OPEN

COMMIT;
-- Atau ROLLBACK; jika Anda ingin membatalkan


-- LANGKAH 4: CEK HARGA PENUTUPAN TERAKHIR UNTUK SETIAP SAHAM
-- ============================================
-- Ini akan digunakan sebagai prev_close untuk sesi baru

SELECT
    s.id,
    s.symbol,
    s.name,
    COALESCE(d.close_price, s.prev_close, s.last_price) as prev_close
FROM stocks s
LEFT JOIN daily_stock_data d ON s.id = d.stock_id
    AND d.session_id = (
        SELECT id FROM trading_sessions
        WHERE status = 'CLOSED'
        ORDER BY id DESC
        LIMIT 1
    )
WHERE s.is_active = true
ORDER BY s.symbol;


-- LANGKAH 5: BUKA SESI TRADING BARU
-- ============================================
BEGIN;

-- Buat sesi baru
INSERT INTO trading_sessions (session_date, status, created_at)
VALUES (CURRENT_DATE, 'OPEN', NOW())
RETURNING id, session_date, status, created_at;

-- Simpan session ID yang dikembalikan, lalu gunakan di query berikutnya
-- Ganti <SESSION_ID> dengan ID yang baru saja dibuat
-- Contoh: jika ID = 5, ganti semua <SESSION_ID> dengan 5

COMMIT;


-- LANGKAH 6: BUAT DATA HARIAN (daily_stock_data) UNTUK SEMUA SAHAM
-- ============================================
-- ⚠️ GANTI <SESSION_ID> dengan ID sesi yang baru dibuat di LANGKAH 5

BEGIN;

INSERT INTO daily_stock_data (
    stock_id,
    session_id,
    prev_close,
    open_price,
    high_price,
    low_price,
    close_price,
    volume,
    ara_limit,
    arb_limit
)
SELECT
    s.id,
    <SESSION_ID>,  -- ⚠️ GANTI INI dengan session ID baru
    COALESCE(d.close_price, s.prev_close, s.last_price) as prev_close,
    COALESCE(d.close_price, s.prev_close, s.last_price) as open_price,
    COALESCE(d.close_price, s.prev_close, s.last_price) as high_price,
    COALESCE(d.close_price, s.prev_close, s.last_price) as low_price,
    COALESCE(d.close_price, s.prev_close, s.last_price) as close_price,
    0 as volume,
    NULL as ara_limit,  -- Akan dihitung dengan fungsi atau endpoint
    NULL as arb_limit   -- Akan dihitung dengan fungsi atau endpoint
FROM stocks s
LEFT JOIN daily_stock_data d ON s.id = d.stock_id
    AND d.session_id = (
        SELECT id FROM trading_sessions
        WHERE status = 'CLOSED'
        ORDER BY id DESC
        LIMIT 1
    )
WHERE s.is_active = true;

COMMIT;


-- LANGKAH 7: HITUNG DAN UPDATE ARA/ARB (MANUAL - OPSIONAL)
-- ============================================
-- Jika Anda ingin menghitung ARA/ARB di SQL (tanpa endpoint)
-- Ini adalah rumus dasar IDX (belum termasuk pembulatan tick-size)

-- ⚠️ GANTI <SESSION_ID> dengan session ID baru

BEGIN;

UPDATE daily_stock_data d
SET
    ara_limit = CASE
        WHEN d.prev_close <= 200 THEN d.prev_close * 1.35
        WHEN d.prev_close <= 5000 THEN d.prev_close * 1.25
        ELSE d.prev_close * 1.20
    END,
    arb_limit = CASE
        WHEN d.prev_close <= 200 THEN d.prev_close * 0.65
        WHEN d.prev_close <= 5000 THEN d.prev_close * 0.75
        ELSE d.prev_close * 0.80
    END
WHERE d.session_id = <SESSION_ID>;  -- ⚠️ GANTI INI dengan session ID baru

COMMIT;


-- LANGKAH 8: VERIFIKASI SESI BARU SUDAH BENAR
-- ============================================
SELECT
    s.symbol,
    d.prev_close,
    d.open_price,
    d.ara_limit,
    d.arb_limit,
    d.volume
FROM daily_stock_data d
JOIN stocks s ON d.stock_id = s.id
WHERE d.session_id = <SESSION_ID>  -- ⚠️ GANTI INI dengan session ID baru
ORDER BY s.symbol;


-- LANGKAH 9 (OPSIONAL): BERSIHKAN REDIS ORDERBOOK
-- ============================================
-- Redis tidak bisa dibersihkan via SQL
-- Gunakan redis-cli atau restart Redis, atau biarkan
-- (orderbook kosong otomatis jika tidak ada order)


-- ============================================
-- CATATAN PENTING:
-- ============================================
-- 1. Lebih aman gunakan API endpoint daripada SQL manual:
--    - POST /api/admin/session/close (otomatis refund order pending)
--    - POST /api/admin/session/open (otomatis hitung ARA/ARB)
--
-- 2. Jika menggunakan SQL manual, pastikan:
--    - Tidak ada order PENDING/PARTIAL (atau batalkan dulu)
--    - Ganti semua <SESSION_ID> dengan ID sesi yang benar
--    - Redis orderbook dibersihkan jika perlu
--
-- 3. Untuk pembulatan ARA/ARB yang tepat sesuai tick-size,
--    sebaiknya gunakan endpoint API atau fungsi backend.

