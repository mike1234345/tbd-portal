/* build:1780028952622 */
// POST /.netlify/functions/quo-webhook
// Receives events from Quo for: call.ringing, call.completed, call.recording.completed,
// call.summary.completed, call.transcript.completed
// Verifies HMAC signature and upserts into Supabase call_sessions + call_events tables.
const {
  response,
  corsHeaders,
  verifyWebhookSignature,
  getSupabase,
  formatPhoneE164,
  safeDate
} = require('./_quo-utils');

function pickHeader(headers = {}, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return v;
  }
  return '';
}

async function findOrCreateSession(sb, call) {
  if (!sb) return null;
  const from = formatPhoneE164(call.from || '');
  const to = formatPhoneE164(call.to || '');
  const quoCallId = call.id;

  // 1. Try to find an existing session by quo_call_id
  const { data: existingByCallId } = await sb
    .from('call_sessions')
    .select('id')
    .eq('quo_call_id', quoCallId)
    .maybeSingle();
  if (existingByCallId?.id) return existingByCallId.id;

  // 2. Try by from + to + recent dial window (pre-created via quo-dial-link)
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: pending } = await sb
    .from('call_sessions')
    .select('id, created_at, initiated_at')
    .eq('from_number', from)
    .eq('to_number', to)
    .gte('created_at', cutoff)
    .in('status', ['dialing', 'ringing'])
    .order('created_at', { ascending: false })
    .limit(8);
  if (Array.isArray(pending) && pending.length) {
    const callTs = new Date(safeDate(call.createdAt) || Date.now()).getTime();
    let best = pending[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    pending.forEach((row) => {
      const rowTs = new Date(row.initiated_at || row.created_at || 0).getTime();
      const delta = Math.abs(callTs - rowTs);
      if (Number.isFinite(delta) && delta < bestDelta) {
        best = row;
        bestDelta = delta;
      }
    });
    if (best?.id) {
      await sb.from('call_sessions').update({ quo_call_id: quoCallId }).eq('id', best.id);
      return best.id;
    }
  }

  // 3. Create a fresh session (inbound call or untracked outbound)
  const { data: inserted, error } = await sb
    .from('call_sessions')
    .insert({
      from_number: from,
      to_number: to,
      direction: call.direction || 'unknown',
      quo_call_id: quoCallId,
      status: call.status || 'ringing',
      provider: 'quo',
      initiated_at: safeDate(call.createdAt)
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[quo-webhook] insert session error:', error.message);
    return null;
  }
  return inserted?.id || null;
}

async function logEvent(sb, sessionId, eventType, payload) {
  if (!sb || !sessionId) return;
  try {
    await sb.from('call_events').insert({
      call_session_id: sessionId,
      event_type: eventType,
      provider: 'quo',
      payload: payload
    });
  } catch (err) {
    console.warn('[quo-webhook] logEvent error:', err.message);
  }
}

async function handleCallRinging(sb, call) {
  const sessionId = await findOrCreateSession(sb, call);
  if (!sessionId) return;
  await sb.from('call_sessions').update({
    status: 'ringing',
    ringing_at: safeDate(call.createdAt),
    direction: call.direction || undefined
  }).eq('id', sessionId);
  await logEvent(sb, sessionId, 'ringing', call);
}

async function handleCallCompleted(sb, call) {
  const sessionId = await findOrCreateSession(sb, call);
  if (!sessionId) return;
  const answered = !!call.answeredAt;
  const startedAt = safeDate(call.answeredAt || call.createdAt);
  const endedAt = safeDate(call.completedAt);
  const duration = (startedAt && endedAt)
    ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000))
    : null;
  const voicemailUrl = call.voicemail?.url || null;
  await sb.from('call_sessions').update({
    status: call.status || 'completed',
    answered: answered,
    answered_at: safeDate(call.answeredAt),
    ended_at: endedAt,
    duration_seconds: duration,
    voicemail_url: voicemailUrl,
    quo_user_id: call.userId || null,
    quo_phone_number_id: call.phoneNumberId || null,
    quo_conversation_id: call.conversationId || null
  }).eq('id', sessionId);
  await logEvent(sb, sessionId, 'completed', call);
}

async function handleRecordingCompleted(sb, call) {
  const sessionId = await findOrCreateSession(sb, call);
  if (!sessionId) return;
  const recordingUrl = (Array.isArray(call.media) && call.media[0]?.url) || null;
  const recordingDuration = (Array.isArray(call.media) && call.media[0]?.duration) || null;
  await sb.from('call_sessions').update({
    recording_url: recordingUrl,
    recording_duration_seconds: recordingDuration
  }).eq('id', sessionId);
  await logEvent(sb, sessionId, 'recording.completed', call);
}

async function handleSummaryCompleted(sb, call) {
  const sessionId = await findOrCreateSession(sb, call);
  if (!sessionId) return;
  // Quo's payload puts summary text inside call.summary (string) or .summary.text (object)
  const summary = typeof call.summary === 'string'
    ? call.summary
    : (call.summary?.text || call.summary?.summary || JSON.stringify(call.summary || {}));
  await sb.from('call_sessions').update({
    ai_summary: summary,
    ai_summary_at: new Date().toISOString()
  }).eq('id', sessionId);
  await logEvent(sb, sessionId, 'summary.completed', call);
}

async function handleTranscriptCompleted(sb, call) {
  const sessionId = await findOrCreateSession(sb, call);
  if (!sessionId) return;
  const transcript = call.transcript || call.dialog || null;
  const transcriptText = typeof transcript === 'string'
    ? transcript
    : (Array.isArray(transcript)
        ? transcript.map((t) => `${t.speaker || 'spk'}: ${t.text || ''}`).join('\n')
        : JSON.stringify(transcript || {}));
  await sb.from('call_sessions').update({
    ai_transcript: transcriptText,
    ai_transcript_at: new Date().toISOString()
  }).eq('id', sessionId);
  await logEvent(sb, sessionId, 'transcript.completed', call);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, '', corsHeaders());
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed' }, corsHeaders());
  }

  const rawBody = event.body || '';
  const sig = pickHeader(event.headers, 'openphone-signature')
    || pickHeader(event.headers, 'quo-signature')
    || pickHeader(event.headers, 'x-quo-signature');
  const sigCheck = verifyWebhookSignature(rawBody, sig);
  if (!sigCheck.ok && !sigCheck.skipped) {
    console.warn('[quo-webhook] signature failed:', sigCheck.reason);
    return response(401, { error: 'Invalid signature', reason: sigCheck.reason });
  }

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return response(400, { error: 'Invalid JSON' }); }

  const type = body.type || body.event || '';
  const call = body.data?.object || body.data || {};
  console.log(`[quo-webhook] ${type} for call ${call?.id || '(no id)'}`);

  const sb = getSupabase();
  if (!sb) {
    console.warn('[quo-webhook] Supabase not configured, acknowledging event without persistence');
    return response(200, { received: true, persisted: false });
  }

  try {
    switch (type) {
      case 'call.ringing':              await handleCallRinging(sb, call); break;
      case 'call.completed':            await handleCallCompleted(sb, call); break;
      case 'call.recording.completed':  await handleRecordingCompleted(sb, call); break;
      case 'call.summary.completed':    await handleSummaryCompleted(sb, call); break;
      case 'call.transcript.completed': await handleTranscriptCompleted(sb, call); break;
      default:
        console.log('[quo-webhook] unknown event type:', type);
    }
  } catch (err) {
    console.error('[quo-webhook] handler error:', err);
    return response(500, { error: err.message || 'Webhook handler failed', received: true });
  }

  return response(200, { received: true, type });
};
