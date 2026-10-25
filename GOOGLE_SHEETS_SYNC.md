# Google Sheets sync branch (review only)

This branch adds a server-side mapping helper and an authenticated, admin-only endpoint. It does not alter PostgreSQL schema, Environment Variables, Google Sheets, `main`, or any deployment.

## What is included
- `sheets-sync.js`: exact-header mapping for the five requested tabs and an ID-based batch builder.
- `POST /api/sheets/sync`: requires an authenticated admin and an explicit `ids` array of 1–200 transaction IDs. It only submits the selected IDs; it does not automatically upload the historical transaction list.
- `test/sheets-sync.test.js`: focused mapping tests.

## Configuration expected later (not set by this branch)
- `SHEETS_WEB_APP_URL`: deployed Apps Script web-app endpoint.
- `SHEETS_BRIDGE_TOKEN`: token matching the Apps Script Script Property `BRIDGE_TOKEN`.

If these are missing, the endpoint returns a configuration error and sends no data. No environment values were added or changed.

## Mapping notes and limitations
- E-Toll maps `tariff` to `Nominal Nota` and `amount` to `Realisasi`; `Selisih` is left blank, not calculated.
- Ongkir maps to `Ongkir`; its existing BBM allocation fields (`nota1`, `nota2`, `nota3`, `noSol`, `gabung`) are summarized in `BBM Solar` under `Nominal Nota`, and `No. Solar` maps from `noSol`. Liter/vendor/realisasi remain blank because the current transaction model does not supply those values reliably.
- A transaction with status `paid` also maps to one stable `PAY-<transaction ID>` row in `Pembayaran`. The current app stores payment status/date on the transaction; it does not provide a separate payment ID or payment method, so method remains blank and this is not suitable for representing multiple partial payments.
- Nota maps known fields where available; missing vendor, invoice number, or note type are left blank rather than inferred.
- The helper uses the actual spreadsheet tab name `BBM Solar` (with a space). The Apps Script `ALLOWED_SHEETS` list must also be changed from `BBM-Solar` to `BBM Solar` before use; otherwise BBM batches will be rejected or fail to find the tab.
- Rejected / Ditolak transactions are filtered out before batches are built. Pending, Draft, and paid transactions are retained when selected from saved `state.transactions`.
- Upserts depend on the Apps Script bridge's first-column ID matching `ID Transaksi` or `ID Pembayaran`. The Apps Script endpoint is not called unless the admin explicitly invokes the new endpoint and configuration exists.

## Still required before enabling automatic sync
1. Review the mappings against the actual spreadsheet and business meanings, especially BBM Solar and Pembayaran.
2. Add durable retry/outbox tracking so a transient bridge failure cannot lose a sync attempt.
3. Define how deleted or later-rejected transactions should be represented in existing sheet rows; the bridge does not delete existing rows.
4. Add a UI to select IDs and show per-tab result/status, or define an automatic policy.
5. Run tests and review this branch; do not merge or deploy without explicit approval.
