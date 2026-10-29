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

test('maps Ready Ongkir to the actual 14-column sheet headers and preserves BBM allocation fields', () => {
  const paidBatches = buildBatches([{
    id: 'TRX-PAID', type: 'ongkir', date: '2026-10-24', created: 1792828800000,
    fuel: 150000, amount: 150000, status: 'paid', paidAt: '2026-10-24',
    shipment: 'SJ-1', driver: 'Driver A', helper: 'Helper A', plate: 'L 1234 XX'
  }], '2026-10-24T00:00:00.000Z');
  assert.deepEqual(paidBatches.map(b => b.sheet), ['Pembayaran']);
  assert.equal(paidBatches[0].rows[0]['ID Pembayaran'], 'PAY-TRX-PAID');

  const batches = buildBatches([{
    id: 'TRX-1', type: 'ongkir', date: '2026-10-24', created: 1792828800000,
    fuel: 150000, amount: 150000, status: 'ready',
    shipment: 'SJ-1', driver: 'Driver A', helper: 'Helper A', plate: 'L 1234 XX',
    route: 'Pasuruan', nota1: 50000, nota2: 30000, nota3: 10000, noSol: 20000, gabung: 5000
  }], '2026-10-24T00:00:00.000Z');
  assert.deepEqual(batches.map(b => b.sheet), ['Ongkir']);
  const ongkir = batches[0].rows[0];
  assert.deepEqual(Object.keys(ongkir), SHEET_HEADERS.Ongkir);
  assert.equal(ongkir['ID Transaksi'], 'TRX-1');
  assert.equal(ongkir['Tanggal'], '2026-10-24');
  assert.equal(ongkir['Driver'], 'Driver A');
  assert.equal(ongkir['Helper'], 'Helper A');
  assert.equal(ongkir['Plat'], 'L 1234 XX');
  assert.equal(ongkir['Kiriman'], 'SJ-1');
  assert.equal(ongkir['Nominal BBM'], 150000);
  assert.equal(ongkir['Nota 1'], 50000);
  assert.equal(ongkir['Nota 2'], 30000);
  assert.equal(ongkir['Nota 3'], 10000);
  assert.equal(ongkir['No Sol'], 20000);
  assert.equal(ongkir['Nominal Gabung'], 5000);
  assert.equal(ongkir['Sisa BBM'], 45000);
  assert.equal(ongkir['Status'], 'Sebagian');
});
test('requires exact Ready status for Ongkir rows but includes saved E-Toll and Nota rows regardless of Pending/Draft labels', () => {
  const batches = buildBatches([
    { id: 'ONG-DRAFT', type: 'ongkir', status: 'draft', date: '2026-10-27', fuel: 100000, nota1: 25000 },
    { id: 'ONG-PAID', type: 'ongkir', status: 'paid', date: '2026-10-27', fuel: 100000, nota1: 25000 },
    { id: 'ONG-EMPTY', type: 'ongkir', date: '2026-10-27', fuel: 100000, nota1: 25000 },
    { id: 'ONG-INVALID', type: 'ongkir', status: 'complete', date: '2026-10-27', fuel: 100000, nota1: 25000 },
    { id: 'ONG-READY', type: 'ongkir', status: 'ready', date: '2026-10-27', fuel: 100000, nota1: 25000 },
    { id: 'ETOLL-PENDING', type: 'etoll', status: 'pending', tariff: 50000, amount: 48000 },
    { id: 'NOTA-DRAFT', type: 'nota', status: 'draft', amount: 10000 },
    { id: 'ETOLL-REJECTED', type: 'etoll', status: 'rejected', tariff: 50000, amount: 48000 }
  ]);
  assert.deepEqual(batches.map(batch => batch.sheet), ['Pembayaran', 'Ongkir', 'E-Toll', 'Nota']);
  assert.deepEqual(batches.find(b => b.sheet === 'Ongkir').rows.map(r => r['ID Transaksi']), ['ONG-READY']);
  assert.deepEqual(batches.find(b => b.sheet === 'E-Toll').rows.map(r => r['ID Transaksi']), ['ETOLL-PENDING']);
  assert.deepEqual(batches.find(b => b.sheet === 'Nota').rows.map(r => r['ID Transaksi']), ['NOTA-DRAFT']);
});

test('ignores unknown transaction types instead of guessing a sheet', () => {
  assert.deepEqual(buildBatches([{ id: 'X', type: 'unknown' }]), []);
});


test('excludes rejected records, while saved Pending/Draft E-Toll and Nota remain report-eligible', () => {
  const batches = buildBatches([
    { id: 'OK-1', type: 'etoll', status: 'pending', tariff: 50000, amount: 48000 },
    { id: 'NO-1', type: 'etoll', status: 'rejected', tariff: 50000, amount: 48000 },
    { id: 'NO-2', type: 'nota', status: 'Ditolak', amount: 10000 },
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


test('keeps the exact existing Ongkir headers and stable transaction ID first', () => {
  assert.deepEqual(SHEET_HEADERS.Ongkir, [
    'ID Transaksi','Tanggal','Driver','Helper','Plat','Kiriman','Nominal BBM',
    'Nota 1','Nota 2','Nota 3','No Sol','Nominal Gabung','Sisa BBM','Status'
  ]);
  const mapped = mapTransaction({ id: 'ONG-KEY-1', type: 'ongkir', date: '2026-10-27', fuel: 100000 });
  assert.equal(mapped.row['ID Transaksi'], 'ONG-KEY-1');
  assert.equal(Object.keys(mapped.row)[0], 'ID Transaksi');
  assert.deepEqual(Object.keys(mapped.row), SHEET_HEADERS.Ongkir);
  assert.equal(Object.keys(mapped.row).length, 14);
});
