@echo off
title M-BIT Redis Orderbook Cleaner
color 0B

:MENU
cls
echo ==========================================
echo      M-BIT REDIS ORDERBOOK CLEANER
echo ==========================================
echo 1. Safe Cleanup (Hapus key 'orderbook:*' saja)
echo 2. Hard Flush (Hapus SEMUA data - FLUSHDB)
echo 3. Exit
echo ==========================================
set /p choice=Pilih opsi (1-3):

if "%choice%"=="1" goto SAFE_CLEAN
if "%choice%"=="2" goto HARD_FLUSH
if "%choice%"=="3" goto END
goto MENU

:SAFE_CLEAN
echo.
echo [INFO] Scanning 'orderbook:*' keys...
echo.

set found=0
for /f "tokens=*" %%i in ('redis-cli --scan --pattern orderbook:*') do (
    redis-cli DEL %%i >nul
    echo [DELETED] %%i
    set found=1
)

if "%found%"=="0" (
    echo [INFO] Tidak ada key orderbook yang ditemukan.
) else (
    echo.
    echo [SUCCESS] Orderbook berhasil dibersihkan!
)
pause
goto MENU

:HARD_FLUSH
echo.
color 0C
echo [WARNING] INI AKAN MENGHAPUS SEMUA DATA DI REDIS (Session, User, dll)!
set /p confirm=Ketik 'YES' untuk lanjut:

if "%confirm%"=="YES" (
    redis-cli FLUSHDB
    echo.
    echo [SUCCESS] Database FLUSHED. Bersih total.
) else (
    echo [INFO] Dibatalkan.
)
color 0B
pause
goto MENU

:END
exit