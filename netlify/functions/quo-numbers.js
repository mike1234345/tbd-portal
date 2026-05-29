/* build:1780028952622 */
// GET /.netlify/functions/quo-numbers
// Returns the list of phone numbers on the Quo account, with rotation index.
// Used by the dashboard to know which numbers exist and to round-robin them.
const { response, corsHeaders, quoApi, formatPhoneE164, getSupabase } = require('./_quo-utils');

let cache = { expiresAt: 0, payload: null };
const CACHE_MS = 5 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return response(200, '', corsHeaders());
  }

  try {
    if (cache.payload && Date.now() < cache.expiresAt) {
      return response(200, cache.payload, corsHeaders());
    }

    const data = await quoApi('/phone-numbers');
    const items = Array.isArray(data?.data) ? data.data : [];

    const numbers = items.map((pn) => ({
      id: pn.id,
      number: formatPhoneE164(pn.number || pn.phoneNumber || ''),
      name: pn.name || pn.formattedNumber || '',
      users: Array.isArray(pn.users) ? pn.users.map((u) => ({ id: u.id, email: u.email, name: u.name })) : [],
      createdAt: pn.createdAt || null
    })).filter((pn) => pn.number);

    // Build rotation suggestion: next-up by least-recently-used in Supabase calls table if available
    let nextIndex = 0;
    try {
      const sb = getSupabase();
      if (sb && numbers.length > 1) {
        const { data: rows } = await sb
          .from('call_sessions')
          .select('from_number, created_at')
          .order('created_at', { ascending: false })
          .limit(numbers.length * 3);
        if (Array.isArray(rows) && rows.length) {
          const usage = new Map(numbers.map((n) => [n.number, 0]));
          rows.forEach((r) => {
            const n = formatPhoneE164(r.from_number || '');
            if (usage.has(n)) usage.set(n, (usage.get(n) || 0) + 1);
          });
          let leastUsed = numbers[0].number;
          let minCount = Infinity;
          for (const [num, count] of usage.entries()) {
            if (count < minCount) { minCount = count; leastUsed = num; }
          }
          nextIndex = numbers.findIndex((n) => n.number === leastUsed);
          if (nextIndex < 0) nextIndex = 0;
        }
      }
    } catch (sbErr) {
      console.warn('[quo-numbers] rotation lookup failed (non-fatal):', sbErr.message);
    }

    const payload = {
      numbers,
      count: numbers.length,
      nextRotationIndex: nextIndex,
      cachedAt: new Date().toISOString()
    };

    cache = { expiresAt: Date.now() + CACHE_MS, payload };
    return response(200, payload, corsHeaders());
  } catch (err) {
    console.error('[quo-numbers] error:', err);
    return response(500, {
      error: err.message || 'Failed to load Quo numbers',
      numbers: [],
      count: 0,
      nextRotationIndex: 0
    }, corsHeaders());
  }
};
