# Migrate existing MarketLab data from iSH

Keep the old local MarketLab server running for this one-time export.

## Save three JSON files on the iPhone

Open each address in Safari and use **Share → Save to Files**:

```text
http://127.0.0.1:8000/api/state
http://127.0.0.1:8000/api/trades?limit=100000
http://127.0.0.1:8000/api/trade-reviews
```

The exact filenames do not matter.

## Import into MarketLab Cloud

1. Sign in to the Cloud version.
2. Open `/import` or tap **Data** in the header.
3. Select all saved JSON files together.
4. Tap **Import selected files**.
5. Return to MarketLab and verify the trade count in Settings.

The import is idempotent: duplicate trade IDs are ignored. Existing cloud trades are not deleted.

## Backup from the cloud version

Open `/import` and tap **Download cloud backup**, or open `/api/export` while signed in. The downloaded JSON contains state, trades, journals, and saved AI reviews. Provider secrets are deliberately excluded.
