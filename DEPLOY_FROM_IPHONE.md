# Deploy MarketLab Cloud using only an iPhone

## Before starting

Revoke any Cloudflare API token that was posted in a chat or another public place. Create a replacement only when a deployment integration asks for it, and store it in Apple Passwords or GitHub Actions secrets.

## Path A — Cloudflare Git integration (recommended)

### 1. Put this project in a private GitHub repository

On GitHub in Safari:

1. Create a private repository named `marketlab-cloud`.
2. Upload the **contents** of this folder, not the outer ZIP folder.
3. Commit the files to `main`.

### 2. Create the D1 database

In Cloudflare:

1. Open **Storage & Databases → D1 SQL Database**.
2. Create a database named `marketlab-db`.

You do not need to paste `schema.sql`; the Worker creates missing tables automatically after the binding is added.

### 3. Deploy from GitHub

1. Open **Workers & Pages → Create**.
2. Choose **Import a repository**.
3. Select the private `marketlab-cloud` repository.
4. Use the default build command (`npm install` is enough) and deploy command `npx wrangler deploy` if Cloudflare asks.
5. Deploy.

### 4. Add the D1 binding

Open the new Worker:

1. **Settings → Bindings → Add binding**.
2. Type: **D1 database**.
3. Variable name: `DB`.
4. Database: `marketlab-db`.
5. Save and redeploy if Cloudflare asks.

### 5. Add encrypted secrets

Open **Settings → Variables and Secrets → Add** and add each as **Secret**:

```text
MARKETLAB_PASSWORD      a long private password used to open the app
SESSION_SECRET          a separate long random value
TWELVE_DATA_API_KEY     current quotes
ALPHA_VANTAGE_API_KEY   daily history and stock splits
OPENAI_API_KEY          optional AI Coach
```

Do not add the Cloudflare deployment token as a Worker runtime secret.

The non-secret model variable is already set in `wrangler.jsonc`:

```text
OPENAI_MODEL=gpt-5.6-luna
```

### 6. Verify

Open:

```text
https://<your-worker>.workers.dev/healthz
```

It should return `status: ok`.

Then open the root address, enter `MARKETLAB_PASSWORD`, and check **Settings** or:

```text
https://<your-worker>.workers.dev/api/health
```

### 7. Install on the iPhone Home Screen

In Safari:

1. Open the MarketLab Worker address.
2. Sign in.
3. Tap **Share**.
4. Tap **Add to Home Screen**.
5. Enable **Open as Web App** when shown.
6. Name it `MarketLab` and tap **Add**.

## Path B — GitHub Actions deployment

A workflow is included at `.github/workflows/deploy.yml`. Add these repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
D1_DATABASE_ID
```

The workflow builds a temporary Wrangler configuration with the `DB` binding, tests the project, and deploys it. Runtime provider keys still belong in Cloudflare Worker secrets, not GitHub source files.
