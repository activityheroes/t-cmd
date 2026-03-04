/* ============================================================
   T-CMD — Supabase Configuration
   
   SETUP INSTRUCTIONS:
   1. Go to supabase.com → your project → Settings → API
   2. Replace the placeholder values below with your real values
   3. Save this file and push to GitHub
   ============================================================ */

const TCMD_CONFIG = {
    // ← Paste your Supabase Project URL here
    SUPABASE_URL: 'PASTE_YOUR_SUPABASE_URL_HERE',

    // ← Paste your Supabase anon/public key here
    SUPABASE_ANON_KEY: 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE',

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
