# v2.0.0 — Cloud conversion

- Converted the v1.12.0 beginner iPhone build from local Python/iSH to a Cloudflare Worker.
- Added D1 persistence for state, immutable trade rows, journals, AI reviews, provider cache, and cloud snapshots.
- Added private password login with a signed, HttpOnly, SameSite cookie.
- Added PWA manifest, service worker, icons, and Home Screen installation support.
- Moved Twelve Data, Alpha Vantage, and OpenAI keys to server-side Worker secrets.
- Preserved the existing MarketLab API routes so the v1.12 interface continues to work.
- Added JSON import/export for migration from the local SQLite-backed build.
- Removed demo quotes from the cloud backend: missing provider configuration is reported explicitly.
- Brokerage execution remains disabled.
