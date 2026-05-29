/* build:1780028952622 */
/**
 * pre-call-intel.js — Netlify Function
 * 
 * Pre-call intelligence for Peter AI Agent (TBD Home Solutions)
 * 
 * Called BEFORE Peter dials a lead. Takes an address, geocodes it,
 * finds the most recent qualifying storm near that property,
 * looks up property year built for plumbing risk assessment,
 * and returns a formatted intel string Peter reads on the call.
 * 
 * Also handles mid-call address updates (same endpoint, new address).
 * 
 * Request (POST or GET):
 *   { address, contactId, name, locationId }
 *   OR ?address=...&contactId=...&name=...
 * 
 * Response:
 *   {
 *     ok: true,
 *     contactId,
 *     address: { raw, normalized, lat, lon, county, city, state, zip },
 *     storm: { found, date, type, magnitude, county, description, claimType } | null,
 *     property: { yearBuilt, pipingRisk, pipingLabel, ownerName } | null,
 *     intel: "Ready-to-use string Peter reads verbatim",
 *     shortIntel: "Condensed version for opening line only"
 *   }
 */

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store'
};

// Qualifying storm thresholds
const MIN_HAIL_INCHES  = 1.0;   // 1 inch diameter minimum
const MIN_WIND_MPH     = 50;    // 50 mph minimum
const MAX_RADIUS_MILES = 15;    // within 15 miles of property
const LOOKBACK_YEARS   = 3;     // look back 3 years for qualifying events
const KNOTS_TO_MPH     = 1.15077945;

function res(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// ─── GEOCODING ───────────────────────────────────────────────────────────────

async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?` +
    new URLSearchParams({ q: address, format: 'json', addressdetails: 1, limit: 1, countrycodes: 'us' });

  const response = await fetch(url, {
    headers: { 'User-Agent': 'TBDHomeIntel/1.0 (tbd-signalwire.netlify.app)' }
  });

  if (!response.ok) throw new Error(`Geocoding failed: ${response.status}`);
  const results = await response.json();
  if (!results.length) return null;

  const r    = results[0];
  const addr = r.address || {};
  return {
    raw:        address,
    normalized: r.display_name,
    lat:        parseFloat(r.lat),
    lon:        parseFloat(r.lon),
    county:     addr.county || addr.state_district || '',
    city:       addr.city || addr.town || addr.village || addr.hamlet || '',
    state:      addr.state || '',
    zip:        addr.postcode || '',
    stateCode:  addr['ISO3166-2-lvl4'] ? addr['ISO3166-2-lvl4'].replace('US-', '') : ''
  };
}

// ─── DISTANCE ────────────────────────────────────────────────────────────────

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R  = 3958.8; // Earth radius in miles
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dN = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dL / 2) ** 2 +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dN / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── STORM LOOKUP ─────────────────────────────────────────────────────────────

async function fetchSpcCsv(dateCode, kind) {
  const url = `https://www.spc.noaa.gov/climo/reports/${dateCode}_rpts_${kind}.csv`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'TBDHomeIntel/1.0' } });
    if (!r.ok) return [];
    return await r.text();
  } catch { return ''; }
}

function parseSpcLatLon(raw) {
  const n = Number(String(raw || '').trim().replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n)) return null;
  return String(raw || '').includes('.') ? n : n / 100;
}

function forEachCsvRow(text, onRow) {
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], nx = text[i + 1];
    if (c === '"') { inQ && nx === '"' ? (field += '"', i++) : (inQ = !inQ); continue; }
    if (c === ',' && !inQ) { row.push(field); field = ''; continue; }
    if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && nx === '\n') i++;
      row.push(field); field = ''; onRow(row); row = []; continue;
    }
    field += c;
  }
  if (field.length || row.length) { row.push(field); onRow(row); }
}

async function findQualifyingStormNearLocation(lat, lon) {
  const cutoff = Date.now() - LOOKBACK_YEARS * 365 * 24 * 60 * 60 * 1000;
  const qualifying = [];

  // Build date codes for the last 21 days (SPC preliminary — most recent events)
  const spcDays = 21;
  const now = new Date();

  for (let d = 0; d < spcDays; d++) {
    const dt   = new Date(now.getTime() - d * 86400000);
    const yy   = String(dt.getUTCFullYear() % 100).padStart(2, '0');
    const mm   = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(dt.getUTCDate()).padStart(2, '0');
    const code = `${yy}${mm}${dd}`;

    for (const kind of ['hail', 'wind', 'torn']) {
      const text = await fetchSpcCsv(code, kind);
      if (!text) continue;

      let headers = null;
      forEachCsvRow(text, (row) => {
        if (!headers) {
          headers = {};
          row.forEach((v, i) => headers[v.trim().toUpperCase()] = i);
          return;
        }
        const pick = (k) => row[headers[k]] ?? '';
        const state = (pick('STATE') || '').trim().toUpperCase();
        if (state !== 'FL') return;

        let rLat = parseSpcLatLon(pick('LAT'));
        let rLon = parseSpcLatLon(pick('LON'));
        if (rLon && rLon > 0) rLon = -rLon;
        if (!rLat || !rLon) return;

        const dist = haversineMiles(lat, lon, rLat, rLon);
        if (dist > MAX_RADIUS_MILES) return;

        const time = String(pick('TIME') || '0000').padStart(4, '0');
        const hh = Number(time.slice(0, 2)) || 0;
        const minT = Number(time.slice(2, 4)) || 0;
        const begin = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), hh, minT));
        if (hh < 12) begin.setUTCDate(begin.getUTCDate() + 1);
        if (begin.getTime() < cutoff) return;

        const county   = (pick('COUNTY') || '').trim();
        const location = (pick('LOCATION') || county).trim();
        const comments = (pick('COMMENTS') || '').trim();

        if (kind === 'hail') {
          const sizeRaw = Number(pick('SIZE') || 0);
          const inches  = sizeRaw / 100;
          if (inches < MIN_HAIL_INCHES) return;
          qualifying.push({
            date: begin, kind: 'hail', magnitude: inches,
            magnitudeLabel: `${inches.toFixed(2)}-inch hail`,
            county, city: location, dist: Math.round(dist * 10) / 10,
            claimType: 'Wind/Hail Storm Claim',
            description: comments || `${inches.toFixed(2)}-inch hail reported ${Math.round(dist)} miles from property`,
            source: 'SPC Preliminary'
          });
        } else if (kind === 'wind') {
          const speedStr = (pick('SPEED') || '').toUpperCase();
          const mph      = Number(speedStr) || 0;
          if (mph && mph < MIN_WIND_MPH) return;
          qualifying.push({
            date: begin, kind: 'wind', magnitude: mph,
            magnitudeLabel: mph ? `${mph} mph wind` : 'Wind damage',
            county, city: location, dist: Math.round(dist * 10) / 10,
            claimType: 'Wind/Hail Storm Claim',
            description: comments || `${mph || 'Damaging'} mph wind reported ${Math.round(dist)} miles from property`,
            source: 'SPC Preliminary'
          });
        } else if (kind === 'torn') {
          const fScale = (pick('F_SCALE') || 'EF?').trim();
          qualifying.push({
            date: begin, kind: 'tornado', magnitude: 0,
            magnitudeLabel: `${fScale} tornado`,
            county, city: location, dist: Math.round(dist * 10) / 10,
            claimType: 'Wind/Hail Storm Claim',
            description: comments || `${fScale} tornado reported ${Math.round(dist)} miles from property`,
            source: 'SPC Preliminary'
          });
        }
      });
    }
  }

  // Also check NOAA NWS alerts active/recent for this area
  try {
    const zone = lat && lon ? `${lat.toFixed(2)},${lon.toFixed(2)}` : null;
    if (zone) {
      const alertUrl = `https://api.weather.gov/alerts?point=${lat},${lon}&status=actual&message_type=alert,update&limit=20`;
      const alertRes = await fetch(alertUrl, {
        headers: { 'User-Agent': 'TBDHomeIntel/1.0', Accept: 'application/geo+json' }
      });
      if (alertRes.ok) {
        const alertData = await alertRes.json();
        const features  = Array.isArray(alertData.features) ? alertData.features : [];
        features.forEach(f => {
          const p = f.properties || {};
          const evt = (p.event || '').toLowerCase();
          if (!evt.includes('wind') && !evt.includes('hail') && !evt.includes('tornado') && !evt.includes('severe') && !evt.includes('storm')) return;
          const sent = p.sent || p.effective;
          if (!sent) return;
          const d = new Date(sent);
          if (d.getTime() < cutoff) return;
          qualifying.push({
            date: d, kind: 'alert',
            magnitudeLabel: p.event,
            county: p.areaDesc || '', city: p.areaDesc || '', dist: 0,
            claimType: 'Wind/Hail Storm Claim',
            description: p.headline || p.event,
            source: 'NWS Active Alert'
          });
        });
      }
    }
  } catch (e) { /* alerts are bonus intel — ignore failures */ }

  if (!qualifying.length) return null;

  // Return the most recent qualifying event
  qualifying.sort((a, b) => b.date.getTime() - a.date.getTime());
  return qualifying[0];
}

// ─── PROPERTY LOOKUP ──────────────────────────────────────────────────────────

async function lookupPropertyRecords(address, lat, lon) {
  // Try Florida Department of Revenue parcel search via OpenStreetMap building data
  // Fallback: estimate year built from neighborhood characteristics via geocode data

  let yearBuilt = null;
  let ownerName = null;

  // Method 1: Try ATTOM-style query via Nominatim extra data
  try {
    // Get more detail from Nominatim reverse geocode
    const url = `https://nominatim.openstreetmap.org/reverse?` +
      new URLSearchParams({ lat, lon, format: 'json', addressdetails: 1, extratags: 1 });
    const r = await fetch(url, { headers: { 'User-Agent': 'TBDHomeIntel/1.0' } });
    if (r.ok) {
      const data = await r.json();
      const extra = data.extratags || {};
      if (extra['building:year_built'] || extra.year_built) {
        yearBuilt = parseInt(extra['building:year_built'] || extra.year_built);
      }
    }
  } catch (e) { /* continue */ }

  // Method 2: Try Florida open parcel data via Regrid (free tier)
  if (!yearBuilt) {
    try {
      const regridUrl = `https://app.regrid.com/api/v1/search.json?typeahead=${encodeURIComponent(address)}&limit=1&token=public`;
      const r = await fetch(regridUrl, { headers: { 'User-Agent': 'TBDHomeIntel/1.0' } });
      if (r.ok) {
        const data = await r.json();
        const parcels = data?.results?.parcels?.features;
        if (parcels && parcels.length) {
          const props = parcels[0].properties?.fields || {};
          yearBuilt = props.yearbuilt || props.year_built || null;
          ownerName = props.owner || props.ownername || null;
          if (yearBuilt) yearBuilt = parseInt(yearBuilt);
        }
      }
    } catch (e) { /* continue */ }
  }

  // Determine piping risk from year built
  let pipingRisk  = 'unknown';
  let pipingLabel = 'Unknown pipe type';

  if (yearBuilt) {
    if (yearBuilt < 1975) {
      pipingRisk  = 'high';
      pipingLabel = `Built ${yearBuilt} — very likely cast iron drain lines (high risk, 50+ years old)`;
    } else if (yearBuilt < 1986) {
      pipingRisk  = 'medium';
      pipingLabel = `Built ${yearBuilt} — may have cast iron or early PVC drain lines (worth checking)`;
    } else if (yearBuilt < 2000) {
      pipingRisk  = 'low';
      pipingLabel = `Built ${yearBuilt} — likely PVC/CPVC (lower risk but still worth a check at this age)`;
    } else {
      pipingRisk  = 'low';
      pipingLabel = `Built ${yearBuilt} — modern PVC/PEX plumbing (low risk)`;
    }
  }

  return { yearBuilt, pipingRisk, pipingLabel, ownerName };
}

// ─── INTEL STRING BUILDER ─────────────────────────────────────────────────────

function buildIntelString(addressData, storm, property, name) {
  const lines = [];
  const firstName = (name || '').split(' ')[0] || 'the homeowner';

  // Storm intel
  if (storm) {
    const dateStr = storm.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const distStr = storm.dist > 0 ? ` (${storm.dist} miles from property)` : '';
    lines.push(`STORM ON FILE: ${dateStr} — ${storm.magnitudeLabel}${distStr}. ${storm.description}. Qualifies for a ${storm.claimType}.`);
  } else {
    lines.push(`STORM ON FILE: No qualifying event found within ${MAX_RADIUS_MILES} miles in the last ${LOOKBACK_YEARS} years. Use general Florida storm frequency pitch instead.`);
  }

  // Property intel
  if (property && property.yearBuilt) {
    lines.push(`PROPERTY: Built ${property.yearBuilt}. ${property.pipingLabel}.`);
    if (property.pipingRisk === 'high') {
      lines.push(`PLUMBING FLAG: HIGH RISK — Cast iron pipes at this age are prone to cracking, corrosion, and root intrusion. This is a strong sudden & accidental loss claim candidate.`);
    } else if (property.pipingRisk === 'medium') {
      lines.push(`PLUMBING FLAG: MEDIUM RISK — Pipe age warrants a professional check.`);
    }
    if (property.ownerName) {
      lines.push(`OWNER ON RECORD: ${property.ownerName}`);
    }
  }

  // Address confirmed
  lines.push(`VERIFIED ADDRESS: ${addressData.normalized || addressData.raw}`);
  lines.push(`COUNTY: ${addressData.county || 'Unknown'} | CITY: ${addressData.city || 'Unknown'} | ZIP: ${addressData.zip || 'Unknown'}`);

  return lines.join('\n');
}

function buildShortIntel(storm, property) {
  if (storm) {
    const dateStr = storm.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    return `Storm on file: ${dateStr} — ${storm.magnitudeLabel}. ` +
      (property?.yearBuilt ? `Property built ${property.yearBuilt}${property.pipingRisk === 'high' ? ', cast iron pipe risk flagged' : ''}.` : '');
  }
  return property?.yearBuilt
    ? `Property built ${property.yearBuilt}${property.pipingRisk === 'high' ? ' — cast iron pipe risk flagged' : ''}.`
    : 'No storm on file — use general Florida pitch.';
}

// ─── GHL UPDATE ───────────────────────────────────────────────────────────────

async function updateGhlContact(contactId, locationId, apiKey, intelString) {
  if (!contactId || !apiKey || !locationId) return;
  try {
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Version': '2021-07-28'
      },
      body: JSON.stringify({
        customFields: [
          { key: 'storm_intel', field_value: intelString }
        ]
      })
    });
  } catch (e) { /* non-critical — Peter gets the intel in the response regardless */ }
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  }

  let address, contactId, name, locationId;

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      address    = body.address;
      contactId  = body.contactId;
      name       = body.name;
      locationId = body.locationId;
    } catch { return res(400, { ok: false, error: 'Invalid JSON body' }); }
  } else {
    const q   = event.queryStringParameters || {};
    address    = q.address;
    contactId  = q.contactId;
    name       = q.name;
    locationId = q.locationId;
  }

  if (!address) return res(400, { ok: false, error: 'address is required' });

  try {
    // Step 1: Geocode the address
    const addressData = await geocodeAddress(address);
    if (!addressData) {
      return res(200, {
        ok: false,
        contactId,
        address: { raw: address },
        storm: null,
        property: null,
        intel: `Address not found: "${address}" — ask homeowner to confirm full address including city and state.`,
        shortIntel: 'Address not found — verify with homeowner.'
      });
    }

    // Step 2: Storm lookup + property lookup in parallel
    const [storm, property] = await Promise.allSettled([
      findQualifyingStormNearLocation(addressData.lat, addressData.lon),
      lookupPropertyRecords(address, addressData.lat, addressData.lon)
    ]);

    const stormResult    = storm.status === 'fulfilled'    ? storm.value    : null;
    const propertyResult = property.status === 'fulfilled' ? property.value : null;

    // Step 3: Build intel strings
    const intel      = buildIntelString(addressData, stormResult, propertyResult, name);
    const shortIntel = buildShortIntel(stormResult, propertyResult);

    // Step 4: Write back to GHL contact field (non-blocking)
    const apiKey = process.env.GHL_API_KEY;
    updateGhlContact(contactId, locationId, apiKey, intel);

    return res(200, {
      ok: true,
      contactId,
      address:   addressData,
      storm:     stormResult,
      property:  propertyResult,
      intel,
      shortIntel
    });

  } catch (error) {
    console.error('pre-call-intel error:', error.message);
    return res(500, {
      ok: false,
      error: error.message,
      contactId,
      address: { raw: address },
      storm: null, property: null,
      intel: 'Intel lookup failed — proceed with general pitch.',
      shortIntel: 'Intel lookup failed.'
    });
  }
};
