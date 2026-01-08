//core/market-logic.ts

/**
 * Mendapatkan Tick Size (fraksi harga) berdasarkan rentang harga di IDX
 */
export const getTickSize = (price: number): number => {
    if (price < 200) return 1;
    if (price < 500) return 2;
    if (price < 2000) return 5;
    if (price < 5000) return 10;
    return 25;
};

/**
 * Validasi apakah harga yang diinput user sesuai dengan fraksi harga (Tick Size)
 */
export const isValidTickSize = (price: number): boolean => {
    const tickSize = getTickSize(price);
    return price % tickSize === 0;
};

/**
 * Menghitung batas ARA dan ARB berdasarkan harga penutupan sebelumnya (Prev Close)
 */
export const calculateLimits = (prevClose: number) => {
    let percentage: number;

    if (prevClose <= 200) percentage = 0.35;
    else if (prevClose <= 5000) percentage = 0.25;
    else percentage = 0.20;

    // Hitung angka mentah
    let araRaw = prevClose + (prevClose * percentage);
    let arbRaw = prevClose - (prevClose * percentage);

    // Fungsi pembulatan sesuai Tick Size (ARA dibulatkan ke bawah, ARB ke atas)
    const roundToTick = (price: number, direction: 'UP' | 'DOWN'): number => {
        const tick = getTickSize(price);
        if (direction === 'DOWN') return Math.floor(price / tick) * tick;
        return Math.ceil(price / tick) * tick;
    };

    return {
        araLimit: roundToTick(araRaw, 'DOWN'),
        arbLimit: roundToTick(arbRaw, 'UP'),
    };
};