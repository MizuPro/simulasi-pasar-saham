# Script untuk membersihkan Redis orderbook secara manual

Clear-Host
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "      M-BIT REDIS ORDERBOOK CLEANER       " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Cek apakah redis-cli tersedia
$redisCliPath = "redis-cli"

try {
    # Test redis-cli version (redirect error to null biar bersih)
    $null = & $redisCliPath --version 2>&1
} catch {
    Write-Host "❌ redis-cli tidak ditemukan di PATH environment!" -ForegroundColor Red
    Write-Host "Pastikan Redis sudah terinstall." -ForegroundColor Yellow
    exit 1
}

Write-Host "Pilih opsi pembersihan:" -ForegroundColor Yellow
Write-Host "  1. Hapus hanya key 'orderbook:*' (AMAN - Session user tidak hilang)" -ForegroundColor Green
Write-Host "  2. FLUSHDB - Hapus SEMUA data (BAHAYA - Semua data hilang)" -ForegroundColor Red
Write-Host "  3. Batal / Exit" -ForegroundColor Gray
Write-Host ""

$choice = Read-Host "Masukkan pilihan (1-3)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "🔍 Scanning key 'orderbook:*'..." -ForegroundColor Yellow

        # Ambil list key orderbook
        # Menggunakan array wrapper @() memastikan hasil tetap array walau cuma 1 item
        $keys = @( & $redisCliPath --scan --pattern "orderbook:*" )

        if ($keys.Count -gt 0) {
            Write-Host "  Ditemukan $($keys.Count) key orderbook." -ForegroundColor Cyan
            Write-Host ""

            $confirm = Read-Host "Hapus key ini? (y/n)"

            if ($confirm -eq "y" -or $confirm -eq "Y") {
                foreach ($key in $keys) {
                    if (-not [string]::IsNullOrWhiteSpace($key)) {
                        & $redisCliPath DEL $key | Out-Null
                        Write-Host "  ✅ Deleted: $key" -ForegroundColor DarkGray
                    }
                }
                Write-Host ""
                Write-Host "✅ Selesai! Semua key orderbook telah dihapus." -ForegroundColor Green
            } else {
                Write-Host "❌ Dibatalkan." -ForegroundColor Red
            }
        } else {
            Write-Host "  Tidak ada key orderbook yang ditemukan." -ForegroundColor Gray
            Write-Host "✅ Redis sudah bersih." -ForegroundColor Green
        }
    } # <-- Penutup Opsi 1

    "2" {
        Write-Host ""
        Write-Host "⚠️  WARNING: Opsi ini menghapus SELURUH database Redis!" -ForegroundColor Red
        Write-Host "   Session login user juga bakal hilang." -ForegroundColor Yellow
        Write-Host ""

        $confirm = Read-Host "Ketik 'YES' untuk konfirmasi"

        if ($confirm -eq "YES") {
            & $redisCliPath FLUSHDB
            Write-Host ""
            Write-Host "✅ Redis FLUSHDB berhasil!" -ForegroundColor Green
        } else {
            Write-Host "❌ Dibatalkan (Safety first!)." -ForegroundColor Red
        }
    } # <-- Penutup Opsi 2

    "3" {
        Write-Host "Bye!" -ForegroundColor Gray
    } # <-- Penutup Opsi 3

    default {
        Write-Host ""
        Write-Host "❌ Pilihan tidak valid." -ForegroundColor Red
    }
} # <-- Penutup Switch

Write-Host ""
Write-Host "Tekan sembarang tombol untuk keluar..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")