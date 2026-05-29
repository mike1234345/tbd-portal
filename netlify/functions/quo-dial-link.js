/* build:1780028952622 */
// POST /.netlify/functions/quo-dial-link
// Body: { leadId?, toNumber, agentEmail? }
// Returns: { telUrl, fromNumber, leadId, dialAt }
// Pre-creates a call_session row in Supabase BEFORE the agent clicks tel:
// so the Quo webhook has something to update when the call finishes.
const { response, corsHeaders, formatPhoneE164, getSupabase, quoApi } = require('./_quo-utils');

let numbersCache = { expiresAt: 0, list: [] };
const NUMBERS_CACHE_MS = 5 * 60 * 1000;

async function loadNumbers() {
  if (numbersCache.list.length && Date.now() < numbersCache.expiresAt) return numbersCache.list;
  const data = await quoApi('/phone-numbers');
  const items = Array.isArray(data?.data) ? data.data : [];
  const list = items
    .map((pn) => formatPhoneE164(pn.number || pn.phoneNumber || ''))
    .filter(Boolean);
  numbersCache = { expiresAt: Date.now() + NUMBERS_CACHE_MS, list };
  return list;
}

async function pickFromNumber(numbers, agentEmail = '', agentId = null) {
  if (!numbers.length) return { number: '', source: 'none', flagged: false };
  const sb = getSupabase();

  // 1. PRIMARY: look up the agent's assigned number (1-to-1 mapping)
  if (sb && (agentEmail || agentId)) {
    try {
      let q = sb.from('agent_number_assignments').select('quo_phone_number, is_active').eq('is_active', true);
      if (agentId) q = q.eq('agent_id', agentId);
      else q = q.eq('agent_email', agentEmail);
      const { data: assignRows } = await q.limit(1);
      const assigned = assignRows && assignRows[0]?.quo_phone_number;
      if (assigned) {
        const matched = numbers.find((n) => formatPhoneE164(n) === formatPhoneE164(assigned));
        if (matched) {
          // Check if this number is flagged in reputation table
          let flagged = false;
          try {
            const { data: repRows } = await sb
              .from('quo_number_reputation')
              .select('flagged_status, paused')
              .eq('phone_number', matched)
              .maybeSingle();
            flagged = Boolean(repRows && (repRows.paused || (repRows.flagged_status && repRows.flagged_status !== 'ok')));
          } catch (_) {}
          return { number: matched, source: 'assigned', flagged };
        }
        console.warn(`[quo-dial-link] Agent assigned to ${assigned} but that number is not on the Quo account. Falling back to LRU.`);
      }
    } catch (err) {
      console.warn('[quo-dial-link] assignment lookup failed:', err.message);
    }
  }

  // 2. FALLBACK: least-recently-used in last 24h
  if (!sb) return { number: numbers[Math.floor(Math.random() * numbers.length)], source: 'random', flagged: false };
  try {
    const { data: rows } = await sb
      .from('call_sessions')
      .select('from_number, created_at')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(200);
    const counts = new Map(numbers.map((n) => [n, 0]));
    (rows || []).forEach((r) => {
      const n = formatPhoneE164(r.from_number || '');
      if (counts.has(n)) counts.set(n, (counts.get(n) || 0) + 1);
    });
    let chosen = numbers[0];
    let minCount = Infinity;
    for (const [n, c] of counts.entries()) {
      if (c < minCount) { minCount = c; chosen = n; }
    }
    return { number: chosen, source: 'lru', flagged: false };
  } catch (err) {
    console.warn('[quo-dial-link] LRU lookup failed, falling back to random:', err.message);
    return { number: numbers[Math.floor(Math.random() * numbers.length)], source: 'random', flagged: false };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, '', corsHeaders());
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed' }, corsHeaders());
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'Invalid JSON body' }, corsHeaders()); }

  const toRaw = String(body.toNumber || body.to || '').trim();
  const to = formatPhoneE164(toRaw);
  if (!to) return response(400, { error: 'toNumber is required (E.164 or 10/11 digit US)' }, corsHeaders());

  const leadId = body.leadId || body.lead_id || null;
  const agentEmail = String(body.agentEmail || body.agent_email || '').trim();
  const agentId = body.agentId || body.agent_id || null;
  const sourceModule = body.sourceModule || 'call-command';

  try {
    const numbers = await loadNumbers();
    if (!numbers.length) {
      return response(409, { error: 'No phone numbers found on your Quo account. Buy at least one number in Quo first.' }, corsHeaders());
    }
    const picked = await pickFromNumber(numbers, agentEmail, agentId);
    const fromNumber = picked.number;
    const fromNumberSource = picked.source;
    const fromNumberFlagged = picked.flagged;
    const dialAt = new Date().toISOString();

    // Pre-create a call_session row so webhook can find/update it later
    let sessionId = null;
    const sb = getSupabase();
    if (sb) {
      try {
        const { data: inserted, error: insErr } = await sb
          .from('call_sessions')
          .insert({
            lead_id: leadId,
            agent_user_id: agentId,
            agent_email: agentEmail || null,
            from_number: fromNumber,
            to_number: to,
            source_module: sourceModule,
            status: 'dialing',
            provider: 'quo',
            initiated_at: dialAt
          })
          .select('id')
          .single();
        if (insErr) console.warn('[quo-dial-link] session insert error:', insErr.message);
        else if (inserted?.id) sessionId = inserted.id;
      } catch (sbErr) {
        console.warn('[quo-dial-link] session insert failed:', sbErr.message);
      }
    }

    const telUrl = `tel:${to}`;

    return response(200, {
      telUrl,
      fromNumber,
      fromNumberSource,         // 'assigned' | 'lru' | 'random' | 'none'
      fromNumberFlagged,        // true if this number is currently spam-flagged
      toNumber: to,
      leadId,
      sessionId,
      dialAt,
      message: 'Click telUrl to launch Quo with the call pre-filled.'
    }, corsHeaders());
  } catch (err) {
    console.error('[quo-dial-link] error:', err);
    return response(500, { error: err.message || 'Failed to build dial link' }, corsHeaders());
  }
};
