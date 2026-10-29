'use strict';

const SHEET_HEADERS = Object.freeze({
  Ongkir: ['ID Transaksi','Tanggal','Driver','Helper','Plat','Kiriman','Nominal BBM','Nota 1','Nota 2','Nota 3','No Sol','Nominal Gabung','Sisa BBM','Status'],
  'E-Toll': ['ID Transaksi','Tanggal Input','Tanggal Tol','Driver','Helper','Plat Nomor','No. Kiriman','Rute/Tujuan Tol','Nominal Nota','Realisasi','Selisih','Status Pembayaran','Keterangan','Tanggal Sinkronisasi'],
  'BBM Solar': ['ID Transaksi','Tanggal Input','Tanggal Nota','Driver','Helper','Plat Nomor','Nama SPBU/Vendor','Liter','Nominal Nota','Realisasi','Selisih','No. Solar','Status Pembayaran','Keterangan','Tanggal Sinkronisasi'],
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
    const bbmKeys = ['fuel', 'nota1', 'nota2', 'nota3', 'noSol', 'gabung'];
    const hasBbmData = bbmKeys.some(key => tx[key] !== null && tx[key] !== undefined && tx[key] !== '');
    const fuel = tx.fuel ?? tx.amount ?? '';
    const nota1 = tx.nota1 ?? '';
    const nota2 = tx.nota2 ?? '';
    const nota3 = tx.nota3 ?? '';
    const noSol = tx.noSol ?? '';
    const gabung = tx.gabung ?? '';
    const spent = ['nota1', 'nota2', 'nota3', 'noSol']
      .reduce((sum, key) => sum + Number(tx[key] || 0), 0) - Number(tx.gabung || 0);
    const remaining = hasBbmData && fuel !== '' ? Number(fuel) - spent : '';
    const bbmStatus = !hasBbmData
      ? common.status
      : spent === 0 ? 'Belum Terbeli'
      : spent < Number(fuel || 0) ? 'Sebagian'
      : spent === Number(fuel || 0) ? 'Terbeli'
      : 'Lebih';

    return {
      sheet: 'Ongkir',
      row: {
        // Header mengikuti tab Ongkir yang sudah ada; ID Transaksi tetap kolom pertama untuk upsert.
        'ID Transaksi': common.id,
        'Tanggal': common.date,
        'Driver': common.driver,
        'Helper': common.helper,
        'Plat': common.plate,
        'Kiriman': asText(tx.route || tx.shipment),
        'Nominal BBM': fuel,
        'Nota 1': nota1,
        'Nota 2': nota2,
        'Nota 3': nota3,
        'No Sol': noSol,
        'Nominal Gabung': gabung,
        'Sisa BBM': remaining,
        'Status': bbmStatus
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

function mapAdditionalRows(tx, syncedAt = new Date().toISOString()) {
  if (!tx || !tx.id) return [];
  const rows = [];
  if (tx.status === 'paid') {
    rows.push({
      sheet: 'Pembayaran',
      row: {
        'ID Pembayaran': 'PAY-' + asText(tx.id),
        'ID Transaksi': asText(tx.id),
        'Tanggal Pembayaran': asText(tx.paidAt || tx.date),
        'Jenis Transaksi': asText(tx.type),
        'Driver': asText(tx.driver),
        'Plat Nomor': asText(tx.plate),
        'No. Kiriman/Nota': asText(tx.shipment || tx.invoiceNo || tx.note),
        'Nominal Dibayar': tx.amount ?? tx.fuel ?? '',
        'Metode Pembayaran': '',
        'Status Data': asText(tx.status),
        'Keterangan': asText(tx.note),
        'Tanggal Sinkronisasi': syncedAt,
        'Tanggal Perubahan': asText(tx.paidAt || tx.date)
      }
    });
  }
  return rows;
}

function isExcludedFromSheets(tx) {
  const status = String(tx?.status || '').trim().toLowerCase();
  // The source of truth is a saved transaction selected from the reports.
  // Exclude only explicitly rejected records; Pending/Draft labels alone do not
  // decide whether an already-saved E-Toll or Nota appears in its report tab.
  return ['rejected', 'ditolak'].includes(status);
}

function buildBatches(transactions, syncedAt = new Date().toISOString()) {
  const bySheet = new Map();
  for (const tx of transactions || []) {
    // The caller supplies saved/report records; temporary input batches are separate.
    // Explicitly rejected records are never sent.
    if (!tx || isExcludedFromSheets(tx)) continue;

    // Ongkir has a stricter business rule: only Ready records belong in the Ongkir
    // report tab. A paid record can still map to Pembayaran independently.
    const mapped = tx.type === 'ongkir'
      ? (String(tx.status || '').trim().toLowerCase() === 'ready' ? mapTransaction(tx, syncedAt) : null)
      : mapTransaction(tx, syncedAt);
    const allMapped = [...(mapped ? [mapped] : []), ...mapAdditionalRows(tx, syncedAt)];
    for (const item of allMapped) {
      if (!bySheet.has(item.sheet)) bySheet.set(item.sheet, []);
      bySheet.get(item.sheet).push(item.row);
    }
  }
  return [...bySheet.entries()].map(([sheet, rows]) => ({ sheet, rows }));
}

async function sendBatches({
  url, token, batches, fetchImpl = globalThis.fetch,
  maxAttempts = 3, retryDelayMs = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  if (!url || !token) return { ok: false, skipped: true, reason: 'Konfigurasi sinkronisasi belum tersedia.' };
  if (typeof fetchImpl !== 'function') throw new Error('Fetch tidak tersedia pada runtime ini.');
  if (!Array.isArray(batches) || batches.length === 0) return { ok: true, skipped: true, results: [] };

  let lastError;
  const attempts = Math.max(1, Math.min(3, Number(maxAttempts) || 1));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, action: 'sync', batches })
      });
      if (!response.ok) {
        const error = new Error('Bridge Google Sheets merespons HTTP ' + response.status);
        // Retry transient server/rate-limit responses, but do not retry ordinary client errors.
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const payload = await response.json();
      if (!payload || payload.ok !== true) {
        const error = new Error('Bridge Google Sheets menolak sinkronisasi.');
        error.retryable = false;
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      if (!retryable || attempt === attempts) break;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

module.exports = { SHEET_HEADERS, ALLOWED_SHEETS, changedRecords, mapTransaction, mapAdditionalRows, isExcludedFromSheets, buildBatches, sendBatches };
