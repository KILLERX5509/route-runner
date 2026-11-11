// Reading spreadsheets and turning rows into stops.

const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';

export const FIELDS = [
  { key: 'name', label: 'Stop name' },
  { key: 'address', label: 'Street address' },
  { key: 'address2', label: 'Suite / unit' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'lat', label: 'Latitude' },
  { key: 'lng', label: 'Longitude' },
  { key: 'notes', label: 'Notes' },
  { key: 'phone', label: 'Phone' },
];

// Header patterns, checked in this order. Each column is used once.
const HEADER_PATTERNS = [
  ['lat', /^(lat|latitude|lat\.)$/i],
  ['lng', /^(lng|lon|long|longitude|lon\.)$/i],
  ['zip', /(zip|postal|post\s*code)/i],
  ['state', /^(state|st|province)$/i],
  ['city', /^(city|town|municipality)$/i],
  ['phone', /(phone|tel\b|telephone|mobile|cell)/i],
  ['address2', /(address\s*(line\s*)?2|suite|apt|apartment|unit)/i],
  ['address', /(address|addr\b|street|destination|location)/i],
  ['notes', /(note|comment|instruction|memo|detail|description)/i],
  ['name', /(name|stop|business|customer|client|company|place|store|account|title|site|venue|contact)/i],
];

let sheetJsPromise = null;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHEETJS_URL;
      s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('The Excel reader did not load.')));
      s.onerror = () => {
        sheetJsPromise = null;
        reject(new Error("Couldn't load the Excel reader. Connect to the internet once, or save the sheet as CSV."));
      };
      document.head.appendChild(s);
    });
  }
  return sheetJsPromise;
}

// Returns { sheets: [{ name, rows: string[][] }] }
export async function parseFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['csv', 'tsv', 'txt'].includes(ext) || file.type === 'text/csv') {
    return { sheets: [{ name: file.name, rows: parseDelimited(await file.text()) }] };
  }
  const XLSX = await loadSheetJS();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: cleanRows(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
      .map((r) => r.map(cellToString))),
  })).filter((s) => s.rows.length);
  if (!sheets.length) throw new Error('That file has no rows in it.');
  return { sheets };
}

function cellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(12));
  return String(v);
}

// CSV / TSV / pasted-from-Excel text. Handles quotes and line breaks inside quotes.
export function parseDelimited(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  let delim = ',', best = 0;
  for (const d of ['\t', ',', ';', '|']) {
    const c = countOutsideQuotes(firstLine, d);
    if (c > best) { best = c; delim = d; }
  }
  if (best === 0) delim = '\u0000'; // one value per line

  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"' && field.trim() === '') {
      inQ = true; field = '';
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return cleanRows(rows);
}

function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

function cleanRows(rows) {
  const out = rows
    .map((r) => r.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()))
    .filter((r) => r.some((c) => c !== ''));
  const width = Math.min(60, Math.max(0, ...out.map((r) => r.length)));
  return out.map((r) => {
    const x = r.slice(0, width);
    while (x.length < width) x.push('');
    return x;
  });
}

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(s);
const looksLikeStreet = (s) => /^\d+[a-z]?\s+\S+/i.test(s) && /[a-z]{2,}/i.test(s);
const colName = (i) => {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return `Column ${s}`;
};

// Work out whether row 1 is headers, and which column holds what.
export function detectLayout(rows) {
  const first = rows[0] || [];
  const filled = first.filter(Boolean);
  const hasHeader = filled.length > 0
    && !filled.some((c) => isNum(c) || looksLikeStreet(c))
    && filled.every((c) => c.length <= 40);
  const headers = first.map((c, i) => (hasHeader && c ? c : colName(i)));
  const data = hasHeader ? rows.slice(1) : rows;
  return { hasHeader, headers, mapping: detectColumns(hasHeader ? first : [], data, first.length) };
}

export function detectColumns(headerRow, data, width) {
  const map = Object.fromEntries(FIELDS.map((f) => [f.key, -1]));
  const used = new Set();
  for (const [key, re] of HEADER_PATTERNS) {
    for (let i = 0; i < headerRow.length; i++) {
      if (used.has(i) || map[key] >= 0) continue;
      if (re.test(headerRow[i] || '')) { map[key] = i; used.add(i); }
    }
  }

  // Fill gaps by looking at the values themselves.
  const sample = data.slice(0, 40);
  const score = (i, fn) => sample.filter((r) => r[i] && fn(r[i])).length / Math.max(1, sample.filter((r) => r[i]).length);
  const free = () => [...Array(width).keys()].filter((i) => !used.has(i));

  if (map.lat < 0 || map.lng < 0) {
    const latCol = free().find((i) => score(i, (v) => isNum(v) && v.includes('.') && Math.abs(+v) <= 90 && Math.abs(+v) > 15) > 0.9);
    if (latCol != null) {
      const lngCol = free().find((i) => i !== latCol && score(i, (v) => isNum(v) && v.includes('.') && Math.abs(+v) > 60 && Math.abs(+v) <= 180) > 0.9);
      if (lngCol != null) { map.lat = latCol; map.lng = lngCol; used.add(latCol); used.add(lngCol); }
    }
  }
  if (map.address < 0) {
    let bestI = -1, bestS = 0;
    for (const i of free()) {
      const s = score(i, looksLikeStreet);
      if (s > bestS) { bestS = s; bestI = i; }
    }
    if (bestI >= 0 && bestS >= 0.5) { map.address = bestI; used.add(bestI); }
  }
  if (map.name < 0) {
    const nameCol = free().find((i) => score(i, (v) => !isNum(v) && /[a-z]/i.test(v)) > 0.8);
    if (nameCol != null) { map.name = nameCol; used.add(nameCol); }
  }
  return map;
}

export function parseCoord(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export const validLatLng = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// Turn data rows into stop objects (without ids/status yet).
export function buildStops(rows, mapping, { hasHeader, headers, areaHint }) {
  const data = hasHeader ? rows.slice(1) : rows;
  const usedCols = new Set(Object.values(mapping).filter((i) => i >= 0));
  const stops = [];
  data.forEach((r, idx) => {
    const get = (k) => (mapping[k] >= 0 ? (r[mapping[k]] || '').trim() : '');
    let lat = parseCoord(get('lat'));
    let lng = parseCoord(get('lng'));
    const street = get('address');

    const pair = street.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
    if (pair && !validLatLng(lat, lng)) { lat = +pair[1]; lng = +pair[2]; }

    const stateZip = [get('state'), get('zip')].filter(Boolean).join(' ');
    const cityLine = [get('city'), stateZip].filter(Boolean).join(', ');
    const streetLine = pair ? '' : [street, get('address2')].filter(Boolean).join(' ');
    let address = [streetLine, cityLine].filter(Boolean).join(', ');
    if (areaHint && address && needsArea(address)) address += `, ${areaHint.trim()}`;

    const hasLL = validLatLng(lat, lng);
    if (!address && !hasLL) return;

    const extra = {};
    r.forEach((v, i) => { if (v && !usedCols.has(i)) extra[headers[i] || colName(i)] = v; });

    stops.push({
      name: get('name') || streetLine.split(',')[0] || `Stop ${idx + 1}`,
      address,
      lat: hasLL ? lat : null,
      lng: hasLL ? lng : null,
      notes: get('notes'),
      phone: get('phone'),
      extra,
    });
  });
  return stops;
}

// True if an address has no city/state/ZIP part.
export function needsArea(address) {
  return !address.includes(',') && !/\b\d{5}\b/.test(address);
}
