'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SHEET_HEADERS, changedRecords, buildBatches, mapTransaction } = require('../sheets-sync');

test('defines exactly the five requested tabs and headers', () => {
  assert.deepEqual(Object.keys(SHEET_HEADERS), ['Ongkir', 'E-Toll', 'BBM Solar', 'Nota', 'Pembayaran']);
  for (const headers of Object.values(SHEET_HEADERS)) assert.ok(headers.length > 10);
});

test('detects only new or changed transactions by stable ID', () => {
  const oldState = { transactions: [{ id: 'A', amount: 10 }, { id: 'B', amount: 20 }] };
  const newState = { transactions: [{ id: 'A', amount: 10 }, { id: 'B', amount: 25 }, { id: 'C', amount: 30 }] };
  assert.deepEqual(changedRecords(oldState, newState).map(tx => tx.id), ['B', 'C']);
});

test('maps E-Toll with tariff and realization, without calculating difference', () => {
  const mapped = mapTransaction({ id: 'T1', type: 'etoll', date: '2026-10-24', tollDate: '2026-10-23', tariff: 50000, amount: 48000 });
  assert.equal(mapped.sheet, 'E-Toll');
  assert.equal(mapped.row['Nominal Nota'], 50000);
  assert.equal(mapped.row['Realisasi'], 48000);
  assert.equal(mapped.row['Selisih'], '');
});

test('maps ongkir to Ongkir and BBM Solar; paid transaction also maps to Pembayaran', () => {
  const batches = buildBatches([{
    id: 'TRX-1', type: 'ongkir', date: '2026-10-24', created: 1792828800000,
    fuel: 150000, amount: 150000, nota1: 50000, nota2: 30000, nota3: 0,
    noSol: 20000, gabung: 0, status: 'paid', paidAt: '2026-10-24',
    shipment: 'SJ-1', driver: 'Driver A', plate: 'L 1234 XX'
  }], '2026-10-24T00:00:00.000Z');
  const names = batches.map(b => b.sheet);
  assert.deepEqual(names, ['Ongkir', 'BBM Solar', 'Pembayaran']);
  assert.equal(batches.find(b => b.sheet === 'BBM Solar').rows[0]['Nominal Nota'], 100000);
  assert.equal(batches.find(b => b.sheet === 'Pembayaran').rows[0]['ID Pembayaran'], 'PAY-TRX-1');
});

test('ignores unknown transaction types instead of guessing a sheet', () => {
  assert.deepEqual(buildBatches([{ id: 'X', type: 'unknown' }]), []);
});


test('never includes rejected transactions in any Google Sheets batch', () => {
  const batches = buildBatches([
    { id: 'OK-1', type: 'etoll', status: 'pending', tariff: 50000, amount: 48000 },
    { id: 'NO-1', type: 'etoll', status: 'rejected', tariff: 50000, amount: 48000 },
    { id: 'NO-2', type: 'etoll', status: 'Ditolak', tariff: 50000, amount: 48000 },
    { id: 'OK-2', type: 'etoll', status: 'draft', tariff: 40000, amount: 40000 }
  ]);
  const ids = batches.flatMap(batch => batch.rows.map(row => row['ID Transaksi'])).filter(Boolean);
  assert.ok(ids.includes('OK-1'));
  assert.ok(ids.includes('OK-2'));
  assert.ok(!ids.includes('NO-1'));
  assert.ok(!ids.includes('NO-2'));
});

test('retries transient Google Sheets failures and succeeds without real network calls', async () => {
  const { sendBatches } = require('../sheets-sync');
  let calls = 0;
  const result = await sendBatches({
    url: 'https://example.invalid/exec',
    token: 'test-token',
    batches: [{ sheet: 'E-Toll', rows: [{ 'ID Transaksi': 'TEST-1' }] }],
    maxAttempts: 3,
    retryDelayMs: 0,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ ok: true, results: [{ sheet: 'E-Toll', count: 1 }] }) };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test('does not retry a permanent client error', async () => {
  const { sendBatches } = require('../sheets-sync');
  let calls = 0;
  await assert.rejects(() => sendBatches({
    url: 'https://example.invalid/exec',
    token: 'test-token',
    batches: [{ sheet: 'E-Toll', rows: [] }],
    maxAttempts: 3,
    retryDelayMs: 0,
    sleep: async () => {},
    fetchImpl: async () => { calls += 1; return { ok: false, status: 400 }; }
  }), /HTTP 400/);
  assert.equal(calls, 1);
});

test('does not call Google Sheets when configuration is missing', async () => {
  const { sendBatches } = require('../sheets-sync');
  let calls = 0;
  const result = await sendBatches({
    url: '',
    token: '',
    batches: [{ sheet: 'E-Toll', rows: [{ 'ID Transaksi': 'TEST-2' }] }],
    fetchImpl: async () => { calls += 1; }
  });
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});
