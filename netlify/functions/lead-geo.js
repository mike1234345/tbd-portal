/* build:1780028952622 */
const { response, corsHeaders } = require('./_quo-utils');

const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const CITY_COUNTY_FALLBACK = {
  'holiday|fl': { city: 'Holiday', state: 'FL', county: 'Pasco County', lat: 28.1878, lon: -82.7390, label: 'Holiday, Pasco County, FL', source: 'fallback' },
  'hudson|fl': { city: 'Hudson', state: 'FL', county: 'Pasco County', lat: 28.3647, lon: -82.6932, label: 'Hudson, Pasco County, FL', source: 'fallback' },
  'shadyhills|fl': { city: 'Shady Hills', state: 'FL', county: 'Pasco County', lat: 28.4294, lon: -82.5437, label: 'Shady Hills, Pasco County, FL', source: 'fallback' },
  'newportrichey|fl': { city: 'New Port Richey', state: 'FL', county: 'Pasco County', lat: 28.2442, lon: -82.7193, label: 'New Port Richey, Pasco County, FL', source: 'fallback' },
  'portrichey|fl': { city: 'Port Richey', state: 'FL', county: 'Pasco County', lat: 28.2717, lon: -82.7193, label: 'Port Richey, Pasco County, FL', source: 'fallback' },
  'trinity|fl': { city: 'Trinity', state: 'FL', county: 'Pasco County', lat: 28.1809, lon: -82.6815, label: 'Trinity, Pasco County, FL', source: 'fallback' },
  'tarponsprings|fl': { city: 'Tarpon Springs', state: 'FL', county: 'Pinellas County', lat: 28.1461, lon: -82.7568, label: 'Tarpon Springs, Pinellas County, FL', source: 'fallback' }
};

function normalizeToken(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cacheKey(query = '') {
  return normalizeToken(query);
}

function buildQuery(event) {
  const params = event.queryStringParameters || {};
  const q = String(params.q || '').trim();
  if (q) return q;
  return [params.address, params.city, params.state || 'FL', params.zip]
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean)
    .join(', ');
}

function buildFallback(params = {}) {
  const cityKey = normalizeToken(params.city || '');
  const stateKey = normalizeToken(params.state || 'FL') || 'fl';
  return CITY_COUNTY_FALLBACK[`${cityKey}|${stateKey}`] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, '', corsHeaders());
  try {
    const params = event.queryStringParameters || {};
    const query = buildQuery(event);
    const directFallback = buildFallback(params);
    const key = cacheKey(query || `${params.city || ''},${params.state || 'FL'}`);
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return response(200, cached.payload, corsHeaders());
    }

    let payload = null;
    if (query) {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&addressdetails=1&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'TBD-Agent-Portal/1.0 (lead geocode helper)',
            'Accept': 'application/json'
          }
        });
        if (res.ok) {
          const data = await res.json();
          const match = Array.isArray(data) ? data[0] : null;
          if (match) {
            payload = {
              ok: true,
              lat: Number(match.lat),
              lon: Number(match.lon),
              label: match.display_name || query,
              county: String(match.address?.county || '').trim(),
              city: String(match.address?.city || match.address?.town || match.address?.village || params.city || '').trim(),
              state: String(match.address?.state || params.state || 'FL').trim(),
              source: 'nominatim'
            };
          }
        }
      } catch (err) {
        // fall through to fallback
      }
    }

    if (!payload && directFallback) {
      payload = { ok: true, ...directFallback };
    }

    if (!payload) {
      payload = { ok: false, county: '', city: String(params.city || '').trim(), state: String(params.state || 'FL').trim() };
    }

    cache.set(key, { expiresAt: Date.now() + CACHE_MS, payload });
    return response(200, payload, corsHeaders());
  } catch (err) {
    return response(500, { ok: false, error: err.message || 'Lead geocode failed' }, corsHeaders());
  }
};
