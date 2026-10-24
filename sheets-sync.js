'use strict';

const SHEET_HEADERS = Object.freeze({
  Ongkir: ['ID Transaksi','Tanggal Input','Tanggal Transaksi','Driver','Helper','Plat Nomor','No. Kiriman','Tujuan','Nominal Nota','Realisasi','Selisih','Status Pembayaran','Keterangan','Tanggal Sinkronisasi'],
  'E-Toll': ['ID Transaksi','Tanggal Input','Tanggal Tol','Driver','Helper','Plat Nomor','No. Kiriman','Rute/Tujuan Tol','Nominal Nota','Realisasi','Selisih','Status Pembayaran','Keterangan','Tanggal Sinkronisasi'],
  'BBM-Solar': ['ID Transaksi','Tanggal Input','Tanggal Nota','Driver','Helper','Plat Nomor','Nama SPBU/Vendor','Liter','Nominal Nota','Realisasi','Selisih','No. Solar','Status Pembayaran','Keterangan','Tanggal Sinkronisasi'],
  Nota: ['ID Transaksi','Tanggal Input','Tanggal Nota','Jenis Nota','Driver','Helper','Plat Nomor','Vendor/Toko','Nomor Nota','Nominal Nota','Realisasi','Selisih','Status Pembayaran','Keterangan','Tanggal Sinkronisasi'],
  Pembayaran: ['ID Pembayaran','ID Transaksi','Tanggal Pembayaran','Jenis Transaksi','Driver','Plat Nomor','No. Kiriman/Nota','Nominal Dibayar','Metode Pembayaran','Status Data','Keterangan','Tanggal Sinkronisasi','Tanggal Perubahan']
});

const ALLOWED_SHEETS = Object.freeze(Object.keys(SHEET_HEADERS));

function asText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function dateFromEpoch(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function changedRecords(previousState, nextState) {
  const before = new Map((Array.isArray(previousState?.transactions) ? previousState.transactions : [])
    .filter(tx => tx && tx.id).map(tx => [String(tx.id), JSON.stringify(tx)]));
  const next = Array.isArray(nextState?.transactions) ? nextState.transactions : [];
  return next.filter(tx => tx && tx.id && before.get(String(tx.id)) !== JSON.stringify(tx));
}

/**
 * Conservative mapping from the currently known V8.5 transaction shape.
 * Unknown values are left blank rather than guessed.
 */
function mapTransaction(tx, syncedAt = new Date().toISOString()) {
  if (!tx || !tx.id) throw new Error('ID transaksi wajib tersedia.');
  const common = {
    id: asText(tx.id),
    created: dateFromEpoch(tx.created),
    date: asText(tx.date),
    driver: asText(tx.driver),
    helper: asText(tx.helper),
    plate: asText(tx.plate),
    status: asText(tx.status),
    note: asText(tx.note),
    syncedAt
  };

  if (tx.type === 'etoll') {
    return {
      sheet: 'E-Toll',
      row: {
        'ID Transaksi': common.id,
        'Tanggal Input': common.created,
        'Tanggal Tol': asText(tx.tollDate || tx.date),
        'Driver': common.driver,
        'Helper': common.helper,
        'Plat Nomor': common.plate,
        'No. Kiriman': asText(tx.shipment),
        'Rute/Tujuan Tol': [tx.from, tx.to].filter(Boolean).map(asText).join(' → '),
        'Nominal Nota': tx.tariff ?? '',
        'Realisasi': tx.amount ?? '',
        // Selisih intentionally blank: the current UI does not define an E-Toll difference.
        'Selisih': '',
        'Status Pembayaran': common.status,
        'Keterangan': common.note,
        'Tanggal Sinkronisasi': common.syncedAt
      }
    };
  }

  if (tx.type === 'ongkir') {
    return {
      sheet: 'Ongkir',
      row: {
        'ID Transaksi': common.id,
        'Tanggal Input': common.created,
        'Tanggal Transaksi': common.date,
        'Driver': common.driver,
        'Helper': common.helper,
        'Plat Nomor': common.plate,
        'No. Kiriman': asText(tx.shipment),
        'Tujuan': asText(tx.route || tx.city),
        'Nominal Nota': '',
        'Realisasi': tx.fuel ?? tx.amount ?? '',
        'Selisih': '',
        'Status Pembayaran': common.status,
        'Keterangan': common.note,
        'Tanggal Sinkronisasi': common.syncedAt
      }
    };
  }

  if (tx.type === 'nota') {
    return {
      sheet: 'Nota',
      row: {
        'ID Transaksi': common.id,
        'Tanggal Input': common.created,
        'Tanggal Nota': asText(tx.notaDate || tx.date),
        'Jenis Nota': asText(tx.noteType),
        'Driver': common.driver,
        'Helper': common.helper,
        'Plat Nomor': common.plate,
        'Vendor/Toko': asText(tx.vendor),
        'Nomor Nota': asText(tx.invoiceNo),
        'Nominal Nota': tx.amount ?? '',
        'Realisasi': '',
        'Selisih': '',
        'Status Pembayaran': common.status,
        'Keterangan': common.note,
        'Tanggal Sinkronisasi': common.syncedAt
      }
    };
  }

  return null;
}

function buildBatches(transactions, syncedAt = new Date().toISOString()) {
  const bySheet = new Map();
  for (const tx of transactions || []) {
    const mapped = mapTransaction(tx, syncedAt);
    if (!mapped) continue;
    if (!bySheet.has(mapped.sheet)) bySheet.set(mapped.sheet, []);
    bySheet.get(mapped.sheet).push(mapped.row);
  }
  return [...bySheet.entries()].map(([sheet, rows]) => ({ sheet, rows }));
}

async function sendBatches({ url, token, batches, fetchImpl = globalThis.fetch }) {
  if (!url || !token) return { ok: false, skipped: true, reason: 'Konfigurasi sinkronisasi belum tersedia.' };
  if (typeof fetchImpl !== 'function') throw new Error('Fetch tidak tersedia pada runtime ini.');
  if (!Array.isArray(batches) || batches.length === 0) return { ok: true, skipped: true, results: [] };

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, action: 'sync', batches })
  });
  if (!response.ok) throw new Error('Bridge Google Sheets merespons HTTP ' + response.status);
  const payload = await response.json();
  if (!payload || payload.ok !== true) throw new Error('Bridge Google Sheets menolak sinkronisasi.');
  return payload;
}

module.exports = { SHEET_HEADERS, ALLOWED_SHEETS, changedRecords, mapTransaction, buildBatches, sendBatches };
