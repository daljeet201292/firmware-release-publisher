# Firmware Release Publisher

Solution for the **Firmware Release Publisher** coding challenge.

## Solution

The publisher lives at:

```
publisher/release-publisher.mjs
```

Run it with:

```bash
npm install
cd distribution-gateway && npm install && cd ..
node distribution-gateway/server.js &   # gateway on :7070
npm run report
```

Expected output matches `reports/publications.expected.txt` (receipt IDs are assigned by the gateway).

## What it does

1. Loads `fixtures/build_manifest.csv` into DuckDB (`releases.duckdb`)
2. Reconciles manifest rows with SQL (dedupe exact duplicates, apply withdrawals)
3. Signs each publishable bundle descriptor with OpenSSL CMS using the current key
4. POSTs signed descriptors to the distribution gateway at `http://127.0.0.1:7070`
5. Persists receipts and idempotency tokens in DuckDB for safe re-runs
6. Prints deterministic status lines ordered by `bundle_id`

## Notes

- Signing keys are generated at Docker image build time (`/app/keys/current/`). They are not committed to this repo.
- Do not modify `distribution-gateway/` — interact with it only over HTTP.
