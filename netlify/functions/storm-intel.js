/* build:1780028952622 */
const { gunzipSync } = require('node:zlib');

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const CSV_BASES = [
  'http://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/',
  'https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/'
];

const SPC_BASE = 'https://www.spc.noaa.gov/climo/reports/';

const FLORIDA_STATE_CODE = 'FL';
const FLORIDA_STATE_NAME = 'FLORIDA';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const KNOTS_TO_MPH = 1.15077945;
const SPC_LOOKBACK_DAYS = 21;

let stormCache = { expiresAt: 0, payload: null };
let spcCache = { expiresAt: 0, payload: null };

function response(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function rankAlert(severity = '', urgency = '') {
  const sev = String(severity || '').toLowerCase();
  const urg = String(urgency || '').toLowerCase();
  if (sev === 'extreme' || sev === 'severe' || urg === 'immediate') return 3;
  if (sev === 'moderate' || urg === 'expected') return 2;
  return 1;
}

function emptyHistoricalPayload(nowIso = new Date().toISOString()) {
  return {
    reports: [],
    summary: {
      totalReports: 0,
      hailCount: 0,
      windCount: 0,
      tornadoCount: 0,
      countyCount: 0,
      windowStart: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      windowEnd: nowIso,
      maxHail: null,
      maxWind: null,
      maxTornado: null,
      latestReport: null
    },
    countyBreakdown: [],
    monthlyBreakdown: []
  };
}

function toNumber(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCounty(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return 'Unknown County';
  return raw.toLowerCase().replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseStormDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;
  const match = raw.match(/^(\d{1,2})-([A-Z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})$/i);
  if (!match) return null;
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const day = Number(match[1]);
  const month = months[match[2].toUpperCase()];
  let year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month == null) return null;
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

function mphFromKnots(knots) { return Number(knots || 0) * KNOTS_TO_MPH; }

function latestItems(values = [], count = 6) {
  return [...values].sort((a, b) => new Date(b.beginDate || 0).getTime() - new Date(a.beginDate || 0).getTime()).slice(0, count);
}

function sortReportsNewest(values = []) {
  return [...values].sort((a, b) => new Date(b.beginDate || 0).getTime() - new Date(a.beginDate || 0).getTime());
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Request failed: ${url} (${res.status})`);
  return res.text();
}

async function fetchBuffer(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Request failed: ${url} (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function resolveStormDirectory(userAgent) {
  let lastError = null;
  for (const base of CSV_BASES) {
    try {
      const html = await fetchText(base, { 'User-Agent': userAgent });
      return { base, html };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('Could not load NOAA storm directory listing.');
}

function pickLatestDetailFiles(html, years) {
  const files = [];
  years.forEach((year) => {
    const regex = new RegExp(`StormEvents_details-ftp_v1\\.0_d${year}_c\\d{8}\\.csv\\.gz`, 'g');
    const matches = [...String(html || '').matchAll(regex)].map((match) => match[0]);
    if (!matches.length) return;
    matches.sort();
    files.push(matches[matches.length - 1]);
  });
  return [...new Set(files)];
}

function forEachCsvRow(text, onRow) {
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') { field += '"'; index += 1; }
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (char === ',' && !inQuotes) { row.push(field); field = ''; continue; }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(field); field = ''; onRow(row); row = []; continue;
    }
    field += char;
  }
  if (field.length || row.length) { row.push(field); onRow(row); }
}

function buildMonthlyBuckets(reports, sinceDate) {
  const buckets = [];
  const counts = new Map();
  reports.forEach((report) => {
    const key = String(report.beginDate || '').slice(0, 7);
    if (!counts.has(key)) counts.set(key, { hail: 0, wind: 0, tornado: 0, total: 0 });
    const bucket = counts.get(key);
    bucket.total += 1;
    if (report.kind === 'hail') bucket.hail += 1;
    if (report.kind === 'wind') bucket.wind += 1;
    if (report.kind === 'tornado') bucket.tornado += 1;
  });
  const cursor = new Date(Date.UTC(sinceDate.getUTCFullYear(), sinceDate.getUTCMonth(), 1));
  const end = new Date();
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= endCursor) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
    const existing = counts.get(key) || { hail: 0, wind: 0, tornado: 0, total: 0 };
    buckets.push({ month: key, hail: existing.hail, wind: existing.wind, tornado: existing.tornado, total: existing.total });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return buckets;
}

function buildStormEventSourceUrl(eventId) {
  const normalized = String(eventId || '').trim();
  if (/^\d+$/.test(normalized)) {
    return `https://www.ncei.noaa.gov/stormevents/eventdetails.jsp?id=${encodeURIComponent(normalized)}`;
  }
  return 'https://www.ncei.noaa.gov/stormevents/';
}

function extractFloridaReports(csvText, sinceMs, sourceDatasetUrl = '') {
  const reports = [];
  let headers = null;

  forEachCsvRow(csvText, (row) => {
    if (!headers) {
      headers = row.reduce((acc, value, index) => {
        acc[String(value || '').trim().toUpperCase()] = index;
        return acc;
      }, {});
      return;
    }

    const pick = (name) => row[headers[name]] ?? '';
    const state = String(pick('STATE') || '').trim().toUpperCase();
    if (state !== FLORIDA_STATE_NAME) return;

    const eventType = normalizeText(pick('EVENT_TYPE'));
    if (!eventType) return;

    const begin = parseStormDate(pick('BEGIN_DATE_TIME') || pick('BEGIN_DATE'));
    if (!begin) return;
    if (begin.getTime() < sinceMs || begin.getTime() > Date.now() + TWELVE_HOURS) return;

    const lowerEventType = eventType.toLowerCase();
    const magnitude = toNumber(pick('MAGNITUDE'));
    const county = formatCounty(pick('CZ_NAME'));
    const city = normalizeText(pick('BEGIN_LOCATION')) || county;
    const source = normalizeText(pick('SOURCE')) || 'NOAA Storm Events';
    const narrative = normalizeText(pick('EVENT_NARRATIVE') || pick('EPISODE_NARRATIVE'));
    const eventId = normalizeText(pick('EVENT_ID')) || `${eventType}-${begin.toISOString()}-${county}`;
    const tornadoScale = normalizeText(pick('TOR_F_SCALE'));

    if (lowerEventType === 'hail') {
      if (!(magnitude > 0)) return;
      reports.push({
        id: eventId, kind: 'hail', eventType, state: FLORIDA_STATE_CODE,
        county, city, beginDate: begin.toISOString(),
        magnitude, magnitudeLabel: `${magnitude.toFixed(2)}" hail`,
        source, sourceUrl: buildStormEventSourceUrl(eventId),
        sourceDatasetUrl: sourceDatasetUrl || '', narrative,
        lat: toNumber(pick('BEGIN_LAT')), lon: toNumber(pick('BEGIN_LON'))
      });
      return;
    }

    if (lowerEventType === 'tornado' || lowerEventType.includes('tornado') || lowerEventType.includes('funnel')) {
      reports.push({
        id: eventId, kind: 'tornado', eventType, state: FLORIDA_STATE_CODE,
        county, city, beginDate: begin.toISOString(),
        magnitude: magnitude || 0,
        tornadoScale: tornadoScale || 'EF?',
        magnitudeLabel: tornadoScale ? `${tornadoScale} tornado` : 'Tornado',
        source, sourceUrl: buildStormEventSourceUrl(eventId),
        sourceDatasetUrl: sourceDatasetUrl || '', narrative,
        lat: toNumber(pick('BEGIN_LAT')), lon: toNumber(pick('BEGIN_LON'))
      });
      return;
    }

    if (lowerEventType.includes('wind') && !lowerEventType.startsWith('marine')) {
      if (!(magnitude > 0)) return;
      const mph = mphFromKnots(magnitude);
      if (mph < 40) return;
      reports.push({
        id: eventId, kind: 'wind', eventType, state: FLORIDA_STATE_CODE,
        county, city, beginDate: begin.toISOString(),
        magnitude, magnitudeMph: Math.round(mph),
        magnitudeLabel: `${Math.round(mph)} mph wind`,
        magnitudeType: normalizeText(pick('MAGNITUDE_TYPE')) || '',
        source, sourceUrl: buildStormEventSourceUrl(eventId),
        sourceDatasetUrl: sourceDatasetUrl || '', narrative,
        lat: toNumber(pick('BEGIN_LAT')), lon: toNumber(pick('BEGIN_LON'))
      });
    }
  });

  return reports;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function buildSpcDateCodes(lookbackDays = SPC_LOOKBACK_DAYS) {
  const codes = [];
  const now = new Date();
  for (let i = 0; i <= lookbackDays; i += 1) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const yy = pad2(d.getUTCFullYear() % 100);
    const mm = pad2(d.getUTCMonth() + 1);
    const dd = pad2(d.getUTCDate());
    codes.push({ code: `${yy}${mm}${dd}`, date: d });
  }
  return codes;
}

function parseSpcLatLon(raw) {
  const cleaned = String(raw ?? '').trim();
  if (!cleaned) return null;
  if (cleaned.includes('.')) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

function parseSpcRow(row, headers, kind, dateObj, sourceUrl, datasetUrl) {
  const pick = (name) => row[headers[name]] ?? '';
  const state = String(pick('STATE') || '').trim().toUpperCase();
  if (state !== FLORIDA_STATE_CODE) return null;
  const location = normalizeText(pick('LOCATION'));
  const county = formatCounty(pick('COUNTY'));
  const time = String(pick('TIME') || '0000').padStart(4, '0');
  const hh = Number(time.slice(0, 2)) || 0;
  const mm = Number(time.slice(2, 4)) || 0;
  // SPC reports use 12Z-to-12Z convective day. Times >= 12 are same UTC day, < 12 are next day.
  const begin = new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate(), hh, mm, 0));
  if (hh < 12) begin.setUTCDate(begin.getUTCDate() + 1);

  let latRaw = parseSpcLatLon(pick('LAT'));
  let lonRaw = parseSpcLatLon(pick('LON'));
  if (lonRaw && lonRaw > 0) lonRaw = -lonRaw;

  const comments = normalizeText(pick('COMMENTS'));
  const id = `SPC-${kind}-${begin.toISOString()}-${location || county}`.replace(/\s+/g, '-');

  if (kind === 'hail') {
    const sizeRaw = String(pick('SIZE') || '').trim();
    const sizeNum = Number(sizeRaw);
    const magnitude = Number.isFinite(sizeNum) ? sizeNum / 100 : 0;
    if (!(magnitude > 0)) return null;
    return {
      id, kind: 'hail', eventType: 'Hail (SPC preliminary)', state: FLORIDA_STATE_CODE,
      county, city: location || county, beginDate: begin.toISOString(),
      magnitude, magnitudeLabel: `${magnitude.toFixed(2)}" hail`,
      source: 'NOAA SPC Storm Reports (preliminary)',
      sourceUrl, sourceDatasetUrl: datasetUrl || sourceUrl,
      narrative: comments, preliminary: true,
      lat: latRaw, lon: lonRaw
    };
  }
  if (kind === 'wind') {
    const speedRaw = String(pick('SPEED') || '').trim().toUpperCase();
    const speedNum = Number(speedRaw);
    const mph = Number.isFinite(speedNum) ? speedNum : 0;
    // SPC reports wind in mph already; include UNK damage reports too if comments present
    if (mph && mph < 40 && speedRaw !== 'UNK') return null;
    return {
      id, kind: 'wind', eventType: 'Wind (SPC preliminary)', state: FLORIDA_STATE_CODE,
      county, city: location || county, beginDate: begin.toISOString(),
      magnitude: mph, magnitudeMph: mph || 0,
      magnitudeLabel: mph ? `${mph} mph wind` : 'Wind damage',
      source: 'NOAA SPC Storm Reports (preliminary)',
      sourceUrl, sourceDatasetUrl: datasetUrl || sourceUrl,
      narrative: comments, preliminary: true,
      lat: latRaw, lon: lonRaw
    };
  }
  if (kind === 'tornado' || kind === 'torn') {
    const fScale = normalizeText(pick('F_SCALE')) || 'EF?';
    return {
      id, kind: 'tornado', eventType: 'Tornado (SPC preliminary)', state: FLORIDA_STATE_CODE,
      county, city: location || county, beginDate: begin.toISOString(),
      magnitude: 0, tornadoScale: fScale,
      magnitudeLabel: `${fScale} tornado`,
      source: 'NOAA SPC Storm Reports (preliminary)',
      sourceUrl, sourceDatasetUrl: datasetUrl || sourceUrl,
      narrative: comments, preliminary: true,
      lat: latRaw, lon: lonRaw
    };
  }
  return null;
}

async function fetchSpcCsvKind(dateCode, kind, userAgent) {
  const csvUrl = `${SPC_BASE}${dateCode}_rpts_${kind}.csv`;
  const htmlUrl = `${SPC_BASE}${dateCode}_rpts.html`;
  try {
    const text = await fetchText(csvUrl, { 'User-Agent': userAgent });
    const out = [];
    let headers = null;
    const dateObj = new Date(Date.UTC(
      2000 + Number(dateCode.slice(0, 2)),
      Number(dateCode.slice(2, 4)) - 1,
      Number(dateCode.slice(4, 6))
    ));
    forEachCsvRow(text, (row) => {
      if (!headers) {
        headers = row.reduce((acc, v, i) => { acc[String(v || '').trim().toUpperCase()] = i; return acc; }, {});
        return;
      }
      // pass the HTML viewer URL as sourceUrl (human-readable) and CSV as dataset URL
      const parsed = parseSpcRow(row, headers, kind, dateObj, htmlUrl, csvUrl);
      if (parsed) out.push(parsed);
    });
    return out;
  } catch (err) {
    return [];
  }
}

async function loadSpcRecentReports(userAgent) {
  if (spcCache.payload && Date.now() < spcCache.expiresAt) return spcCache.payload;
  const codes = buildSpcDateCodes(SPC_LOOKBACK_DAYS);
  const all = [];
  for (const { code } of codes) {
    const [t, h, w] = await Promise.all([
      fetchSpcCsvKind(code, 'torn', userAgent),
      fetchSpcCsvKind(code, 'hail', userAgent),
      fetchSpcCsvKind(code, 'wind', userAgent)
    ]);
    all.push(...t, ...h, ...w);
  }
  spcCache = { expiresAt: Date.now() + THIRTY_MIN, payload: all };
  return all;
}

function dedupeReports(reports) {
  const seen = new Map();
  reports.forEach((r) => {
    const key = `${r.kind}|${(r.county || '').toLowerCase()}|${(r.city || '').toLowerCase()}|${String(r.beginDate || '').slice(0, 13)}`;
    const existing = seen.get(key);
    if (!existing) { seen.set(key, r); return; }
    // Prefer official (non-preliminary) over preliminary
    if (existing.preliminary && !r.preliminary) seen.set(key, r);
  });
  return [...seen.values()];
}

function buildHistoricalPayload(reports, sinceDate) {
  const hailReports = reports.filter((r) => r.kind === 'hail');
  const windReports = reports.filter((r) => r.kind === 'wind');
  const tornadoReports = reports.filter((r) => r.kind === 'tornado');

  const countyMap = new Map();
  reports.forEach((report) => {
    const key = report.county || 'Unknown County';
    if (!countyMap.has(key)) countyMap.set(key, { county: key, total: 0, hail: 0, wind: 0, tornado: 0, latestDate: report.beginDate });
    const row = countyMap.get(key);
    row.total += 1;
    if (report.kind === 'hail') row.hail += 1;
    if (report.kind === 'wind') row.wind += 1;
    if (report.kind === 'tornado') row.tornado += 1;
    if (new Date(report.beginDate).getTime() > new Date(row.latestDate || 0).getTime()) row.latestDate = report.beginDate;
  });

  const countyBreakdown = [...countyMap.values()]
    .sort((a, b) => b.total - a.total || b.tornado - a.tornado || b.wind - a.wind || b.hail - a.hail || a.county.localeCompare(b.county));

  const latestReport = latestItems(reports, 1)[0] || null;
  const maxHail = [...hailReports].sort((a, b) => (b.magnitude || 0) - (a.magnitude || 0))[0] || null;
  const maxWind = [...windReports].sort((a, b) => (b.magnitudeMph || 0) - (a.magnitudeMph || 0))[0] || null;
  const maxTornado = [...tornadoReports].sort((a, b) => String(b.tornadoScale || '').localeCompare(String(a.tornadoScale || '')))[0] || null;

  return {
    reports: sortReportsNewest(reports),
    summary: {
      totalReports: reports.length,
      hailCount: hailReports.length,
      windCount: windReports.length,
      tornadoCount: tornadoReports.length,
      countyCount: countyMap.size,
      windowStart: sinceDate.toISOString(),
      windowEnd: new Date().toISOString(),
      latestReport, maxHail, maxWind, maxTornado
    },
    countyBreakdown,
    monthlyBreakdown: buildMonthlyBuckets(reports, sinceDate)
  };
}

async function loadFloridaHistoricalStorms(userAgent) {
  if (stormCache.payload && Date.now() < stormCache.expiresAt) return stormCache.payload;

  const now = new Date();
  const sinceDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const years = [...new Set([sinceDate.getUTCFullYear(), now.getUTCFullYear()])];

  let bulkReports = [];
  try {
    const { base, html } = await resolveStormDirectory(userAgent);
    const files = pickLatestDetailFiles(html, years);
    if (files.length) {
      for (const file of files) {
        const sourceDatasetUrl = base + file;
        try {
          const gzBuffer = await fetchBuffer(sourceDatasetUrl, { 'User-Agent': userAgent });
          const csvText = gunzipSync(gzBuffer).toString('utf8');
          bulkReports = bulkReports.concat(extractFloridaReports(csvText, sinceDate.getTime(), sourceDatasetUrl));
        } catch (fileErr) {
          console.warn('Bulk file skipped:', file, fileErr.message);
        }
      }
    }
  } catch (dirErr) {
    console.warn('NOAA bulk dir unavailable:', dirErr.message);
  }

  // Always merge in SPC preliminary reports for the last few weeks
  let spcReports = [];
  try {
    spcReports = await loadSpcRecentReports(userAgent);
  } catch (spcErr) {
    console.warn('SPC fetch failed:', spcErr.message);
  }

  const merged = dedupeReports([...bulkReports, ...spcReports]);
  merged.sort((a, b) => new Date(b.beginDate || 0).getTime() - new Date(a.beginDate || 0).getTime());
  const payload = buildHistoricalPayload(merged, sinceDate);
  stormCache = { expiresAt: Date.now() + SIX_HOURS, payload };
  return payload;
}

async function loadFloridaAlerts(userAgent) {
  const res = await fetch(`https://api.weather.gov/alerts/active?area=${encodeURIComponent(FLORIDA_STATE_CODE)}`, {
    headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' }
  });
  if (!res.ok) return [];
  const data = await res.json();
  const features = Array.isArray(data.features) ? data.features : [];
  return features.map((feature) => {
    const props = feature.properties || {};
    return {
      id: feature.id || props.id || `${FLORIDA_STATE_CODE}-${props.event || 'alert'}-${props.sent || ''}`,
      state: FLORIDA_STATE_CODE,
      event: props.event || 'Weather alert',
      severity: props.severity || 'Unknown',
      urgency: props.urgency || 'Expected',
      certainty: props.certainty || 'Observed',
      areaDesc: props.areaDesc || '',
      sent: props.sent || props.effective || null,
      effective: props.effective || null,
      headline: props.headline || ''
    };
  }).sort((a, b) => {
    const rankDiff = rankAlert(b.severity, b.urgency) - rankAlert(a.severity, a.urgency);
    if (rankDiff) return rankDiff;
    return new Date(b.sent || 0).getTime() - new Date(a.sent || 0).getTime();
  }).slice(0, 12);
}

async function loadRadarMeta() {
  try {
    const radarRes = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!radarRes.ok) return { radarUpdatedAt: null, radarFrames: 0 };
    const radarData = await radarRes.json();
    return {
      radarUpdatedAt: radarData.generated ? new Date(Number(radarData.generated) * 1000).toISOString() : null,
      radarFrames: Array.isArray(radarData?.radar?.past) ? radarData.radar.past.length : 0
    };
  } catch (error) {
    return { radarUpdatedAt: null, radarFrames: 0 };
  }
}

exports.handler = async () => {
  const userAgent = 'TBDStormPortal/2.1 (https://tbdmarketingsolutions.netlify.app)';
  const loadedAt = new Date().toISOString();

  try {
    const [alertsResult, radarResult, historicalResult] = await Promise.allSettled([
      loadFloridaAlerts(userAgent),
      loadRadarMeta(),
      loadFloridaHistoricalStorms(userAgent)
    ]);

    const alerts = alertsResult.status === 'fulfilled' ? alertsResult.value : [];
    const radar = radarResult.status === 'fulfilled' ? radarResult.value : { radarUpdatedAt: null, radarFrames: 0 };
    const historical = historicalResult.status === 'fulfilled' ? historicalResult.value : emptyHistoricalPayload(loadedAt);

    return response(200, {
      states: [FLORIDA_STATE_CODE],
      loadedAt,
      radarUpdatedAt: radar.radarUpdatedAt,
      radarFrames: radar.radarFrames,
      alerts,
      severeReports: historical.reports,
      summary: historical.summary,
      countyBreakdown: historical.countyBreakdown,
      monthlyBreakdown: historical.monthlyBreakdown,
      sources: [
        { name: 'NOAA Storm Events Database', url: 'https://www.ncei.noaa.gov/stormevents/' },
        { name: 'NOAA SPC Storm Reports (preliminary, real-time)', url: 'https://www.spc.noaa.gov/climo/reports/' },
        { name: 'NOAA Storm Events Bulk CSV', url: 'https://www.ncei.noaa.gov/stormevents/ftp.jsp' },
        { name: 'NWS Alerts API', url: 'https://www.weather.gov/documentation/services-web-api' }
      ]
    });
  } catch (error) {
    return response(500, {
      error: error.message || 'Could not load Florida storm intelligence.',
      states: [FLORIDA_STATE_CODE],
      loadedAt, alerts: [], severeReports: [],
      summary: emptyHistoricalPayload(loadedAt).summary,
      countyBreakdown: [], monthlyBreakdown: []
    });
  }
};
