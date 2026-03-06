/* ============================================================
   T-CMD — Supabase Configuration
   
   SETUP INSTRUCTIONS:
   1. Go to supabase.com → your project → Settings → API
   2. Replace the placeholder values below with your real values
   3. Save this file and push to GitHub
   ============================================================ */

const TCMD_CONFIG = {
    SUPABASE_URL: 'https://agzpgdnjlpigcceooxvv.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnenBnZG5qbHBpZ2NjZW9veHZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NjI0MTQsImV4cCI6MjA4ODIzODQxNH0.6Zn75cA5vFO8XXjoCUQqvlkps2O0o68GkZMfBaDAOl4',

    // Base URL for invite links (auto-detected, no change needed)
    get APP_URL() {
        return window.location.origin + window.location.pathname.replace(/\/$/, '');
    }
};

// Check if Supabase is configured
const SUPABASE_READY = (
    TCMD_CONFIG.SUPABASE_URL !== 'PASTE_YOUR_SUPABASE_URL_HERE' &&
    TCMD_CONFIG.SUPABASE_ANON_KEY !== 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE'
);

// Default API keys — used when js/keys.js (gitignored) is absent,
// e.g. on GitHub Pages. These are free-tier keys.
// If keys.js loaded first it already set window.TCMD_KEYS, so we skip.
if (!window.TCMD_KEYS || !window.TCMD_KEYS.birdeye) {
    window.TCMD_KEYS = Object.assign({
        helius:  '742cfd02-85ba-48c9-b6b8-3fe3e3aa70b3',
        birdeye: '6ad6eba8bf594e1681764f5fb0b17ed8'
    }, window.TCMD_KEYS || {});
}
