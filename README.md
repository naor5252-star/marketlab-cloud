# MarketLab Cloud v2.1.0

MarketLab Cloud is the Cloudflare-hosted conversion of the beginner-friendly MarketLab v1.12.0 iPhone paper-trading application.

It is an installable PWA: open the deployed `workers.dev` address in Safari and use **Share → Add to Home Screen**. No iSH process, local Python server, Mac, Xcode, or Apple Developer membership is required.

## Architecture

- **Cloudflare Worker:** authenticated API and provider proxy
- **Cloudflare Static Assets:** MarketLab interface and PWA shell
- **Cloudflare D1 (`DB` binding):** state, standalone trade rows, journals, reviews, cache, backups
- **Worker secrets:** provider keys and the private login password
- **Twelve Data:** current quotes and Refresh All
- **Alpha Vantage:** daily history and split events
- **OpenAI Responses API:** optional AI Coach and post-trade reviews

The browser never receives provider API keys. MarketLab remains simulation-only and has no brokerage-order endpoint.

## Required Worker bindings and secrets

D1 binding:

```text
Variable name: DB
Database: marketlab-db
```

Required secret:

```text
MARKETLAB_PASSWORD
```

Recommended secret:

```text
SESSION_SECRET
```

Provider secrets:

```text
TWELVE_DATA_API_KEY
ALPHA_VANTAGE_API_KEY
OPENAI_API_KEY
```

Optional plain variable:

```text
OPENAI_MODEL=gpt-5.6-luna
```

## Important routes

- `/` — MarketLab
- `/login` — private login
- `/import` — migration and backup screen
- `/api/health` — authenticated configuration check
- `/api/export` — downloadable JSON backup
- `/healthz` — public minimal deployment check

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 create marketlab-db
# Add the returned D1 binding to wrangler.jsonc for local/CLI deployment.
npm run dev
```

The Worker also creates its tables automatically with `CREATE TABLE IF NOT EXISTS`, while `schema.sql` is provided for inspection or manual initialization.


## v2.1 additions

- Every company card shows a three-month price-history sparkline after Refresh all.
- Refresh all loads both current quotes and historical candles.
- Performance includes a Close-all cash metric that estimates cash after selling longs, covering shorts, slippage, and exit commissions.
