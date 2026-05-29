// =====================================================
// TBD Marketing Solutions - Call Command (Quo edition)
// Replaces the old Telnyx WebRTC dialer with a Quo
// click-to-call workflow + live webhook-driven call log.
// =====================================================
(function () {
  const POLL_MS = 15000;       // refresh recent calls every 15s

  const state = {
    loaded: false,
    loading: false,
    activeQueue: [],
    recentCalls: [],
    selectedSessionId: null,
    selectedLeadId: null,
    pollingTimer: null,
    dailyStats: { calls: 0, answered: 0, booked: 0 },
    // Post-call modal state
    activeCall: null,        // { sessionId, leadId, leadName, phone, fromNumber, startedAt }
    activeCallPoll: null,    // setInterval handle for live status updates
    activeCallTimer: null,   // setInterval handle for the countdown
    prepVariant: 0,
    queueInfo: null
  };

  function byId(id) { return document.getElementById(id); }
  function sb() { return window.sb; }
  function currentUser() { return window.currentUser; }

  function escapeHtml(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatWhen(value) {
    if (!value) return '-';
    try {
      return typeof window.formatDateTime === 'function'
        ? window.formatDateTime(value)
        : new Date(value).toLocaleString();
    } catch { return '-'; }
  }

  function formatDuration(secs) {
    const s = Number(secs || 0);
    if (!s) return '-';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m ? `${m}m ${r}s` : `${r}s`;
  }

  function parseElapsedClock(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d+):(\d{2})$/);
    if (!match) return 0;
    return (Number(match[1]) * 60) + Number(match[2]);
  }

  function formatPhone(value) {
    const clean = String(value || '').replace(/[^0-9+]/g, '');
    if (!clean) return '-';
    const digits = clean.replace(/^\+?1?/, '');
    if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    return clean;
  }

  function setStatus(msg, kind = 'info') {
    const el = byId('callCommandStatus');
    if (!el) return;
    if (!msg) { el.textContent = ''; el.className = 'cc-status hidden'; return; }
    el.textContent = msg;
    el.className = `cc-status cc-status-${kind}`;
  }


  function prettyLabel(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\w/g, (match) => match.toUpperCase())
      .trim();
  }

  function sanitizeUuid(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const lowered = raw.toLowerCase();
    if (lowered === 'null' || lowered === 'undefined') return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
  }

  function outcomeLabelForDisposition(disposition) {
    const key = String(disposition || '').trim().toLowerCase();
    const labels = {
      booked: 'Booked',
      callback: 'Callback',
      not_interested: 'Not Interested',
      voicemail: 'Voicemail',
      no_answer: 'No Answer'
    };
    return labels[key] || prettyLabel(disposition || 'Logged');
  }

  async function fetchCallSessionById(sessionId) {
    const supa = sb();
    if (!supa || !sessionId) return null;
    try {
      const { data, error } = await supa
        .from('call_sessions')
        .select('id, lead_id, agent_id:agent_user_id, agent_email, from_number, to_number, status, answered, duration_seconds, disposition, disposition_at, disposition_notes, initiated_at, answered_at, ended_at, created_at')
        .eq('id', sessionId)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (err) {
      console.warn('[call-command] fetchCallSessionById:', err.message);
      return null;
    }
  }

  function stripCallSessionMeta(notesValue = '') {
    return String(notesValue || '')
      .replace(/\s*\[\[CALL_SESSION:[0-9a-f-]{36}\]\]\s*/ig, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function composeCallNotesWithSessionId(notesValue = '', sessionId = null) {
    const cleanNotes = stripCallSessionMeta(notesValue);
    const cleanSessionId = sanitizeUuid(sessionId);
    if (!cleanSessionId) return cleanNotes || null;
    return cleanNotes ? `${cleanNotes}\n\n[[CALL_SESSION:${cleanSessionId}]]` : `[[CALL_SESSION:${cleanSessionId}]]`;
  }

  function extractCallSessionIdFromNotes(notesValue = '') {
    const match = String(notesValue || '').match(/\[\[CALL_SESSION:([0-9a-f-]{36})\]\]/i);
    return match ? sanitizeUuid(match[1]) : null;
  }

  function buildCallAttemptPayloadFromSession(call, disposition, notes, metricOverrides = null) {
    const key = String(disposition || '').trim().toLowerCase();
    const answered = typeof metricOverrides?.answered === 'boolean'
      ? metricOverrides.answered
      : (typeof call?.answered === 'boolean' ? call.answered : !['voicemail', 'no_answer'].includes(key));
    const appointmentBooked = typeof metricOverrides?.appointment_booked === 'boolean'
      ? metricOverrides.appointment_booked
      : key === 'booked';
    const allowedPresentation = typeof metricOverrides?.allowed_presentation === 'boolean'
      ? metricOverrides.allowed_presentation
      : (appointmentBooked || key === 'callback' || key === 'not_interested' || (answered && !['voicemail', 'no_answer'].includes(key)));
    return {
      lead_id: sanitizeUuid(call?.lead_id),
      agent_id: sanitizeUuid(currentUser()?.id) || sanitizeUuid(call?.agent_id),
      answered,
      allowed_presentation: allowedPresentation,
      appointment_booked: appointmentBooked,
      call_outcome: outcomeLabelForDisposition(disposition),
      duration_seconds: Number(call?.duration_seconds || 0) || 0,
      notes: composeCallNotesWithSessionId(String(notes || '').trim() || null, call?.id),
      created_at: call?.created_at || new Date().toISOString()
    };
  }

  async function syncCallPayloadToCallLog(payload) {
    const supa = sb();
    if (!supa || !payload?.lead_id) return null;

    const explicitSessionId = extractCallSessionIdFromNotes(payload.notes);
    if (explicitSessionId) {
      let bySessionQuery = supa
        .from('crm_call_attempts')
        .select('id, notes, created_at')
        .eq('lead_id', payload.lead_id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (payload.agent_id) bySessionQuery = bySessionQuery.eq('agent_id', payload.agent_id);
      const { data: sameLeadRows, error: sameLeadErr } = await bySessionQuery;
      if (sameLeadErr) throw sameLeadErr;
      const exactSessionRow = (sameLeadRows || []).find((row) => extractCallSessionIdFromNotes(row.notes) === explicitSessionId);
      if (exactSessionRow?.id) {
        const { error } = await supa.from('crm_call_attempts').update({
          answered: payload.answered,
          allowed_presentation: payload.allowed_presentation,
          appointment_booked: payload.appointment_booked,
          call_outcome: payload.call_outcome,
          duration_seconds: payload.duration_seconds,
          notes: payload.notes
        }).eq('id', exactSessionRow.id);
        if (error) throw error;
        return exactSessionRow.id;
      }

      const { data: insertedWithSession, error: insertWithSessionErr } = await supa.from('crm_call_attempts').insert(payload).select('id').single();
      if (insertWithSessionErr) throw insertWithSessionErr;
      return insertedWithSession?.id || null;
    }

    const targetTime = new Date(payload.created_at || Date.now()).getTime();
    const windowStart = new Date(targetTime - (2 * 60 * 60 * 1000)).toISOString();

    let query = supa
      .from('crm_call_attempts')
      .select('id, created_at')
      .eq('lead_id', payload.lead_id)
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(15);

    if (payload.agent_id) query = query.eq('agent_id', payload.agent_id);

    const { data: existingRows, error: findErr } = await query;
    if (findErr) throw findErr;

    let closest = null;
    let closestDelta = Number.POSITIVE_INFINITY;
    for (const row of (existingRows || [])) {
      const rowTime = new Date(row.created_at || 0).getTime();
      const delta = Math.abs(rowTime - targetTime);
      if (Number.isFinite(delta) && delta < closestDelta) {
        closest = row;
        closestDelta = delta;
      }
    }

    if (closest && closestDelta <= (45 * 60 * 1000)) {
      const { error } = await supa.from('crm_call_attempts').update({
        answered: payload.answered,
        allowed_presentation: payload.allowed_presentation,
        appointment_booked: payload.appointment_booked,
        call_outcome: payload.call_outcome,
        duration_seconds: payload.duration_seconds,
        notes: payload.notes
      }).eq('id', closest.id);
      if (error) throw error;
      return closest.id;
    }

    const { data: inserted, error: insertErr } = await supa.from('crm_call_attempts').insert(payload).select('id').single();
    if (insertErr) throw insertErr;
    return inserted?.id || null;
  }

  function setPostCallMetricInputs(metrics = {}) {
    const answeredEl = byId('ccPcAnswered');
    const presentedEl = byId('ccPcPresented');
    const bookedEl = byId('ccPcBooked');
    if (answeredEl && typeof metrics.answered === 'boolean') answeredEl.checked = metrics.answered;
    if (presentedEl && typeof metrics.allowed_presentation === 'boolean') presentedEl.checked = metrics.allowed_presentation;
    if (bookedEl && typeof metrics.appointment_booked === 'boolean') bookedEl.checked = metrics.appointment_booked;
  }

  function metricDefaultsForDisposition(disposition) {
    const key = String(disposition || '').trim().toLowerCase();
    if (key === 'booked') return { answered: true, allowed_presentation: true, appointment_booked: true };
    if (key === 'callback') return { answered: true, allowed_presentation: false, appointment_booked: false };
    if (key === 'not_interested') return { answered: true, allowed_presentation: true, appointment_booked: false };
    if (key === 'voicemail' || key === 'no_answer') return { answered: false, allowed_presentation: false, appointment_booked: false };
    if (key === 'wrong_number' || key === 'do_not_call') return { answered: true, allowed_presentation: false, appointment_booked: false };
    return { answered: false, allowed_presentation: false, appointment_booked: false };
  }

  function readPostCallMetricInputs(disposition) {
    const fallback = metricDefaultsForDisposition(disposition);
    return {
      answered: Boolean(byId('ccPcAnswered')?.checked ?? fallback.answered),
      allowed_presentation: Boolean(byId('ccPcPresented')?.checked ?? fallback.allowed_presentation),
      appointment_booked: Boolean(byId('ccPcBooked')?.checked ?? fallback.appointment_booked)
    };
  }

  async function resolveLeadIdForCall(call = null, fallbackInfo = null) {
    const directLeadId = sanitizeUuid(call?.lead_id) || sanitizeUuid(fallbackInfo?.leadId);
    if (directLeadId) return directLeadId;

    const supa = sb();
    if (!supa) return null;

    const phoneDigits = normalizePhoneForMatch(fallbackInfo?.phone || call?.to_number || '');
    if (!phoneDigits) return null;

    try {
      const { data, error } = await supa
        .from('crm_leads')
        .select('id, phone')
        .limit(400);
      if (error) throw error;
      const matches = (data || []).filter((lead) => normalizePhoneForMatch(lead?.phone || '') === phoneDigits);
      if (matches.length === 1) return sanitizeUuid(matches[0]?.id);
      if (matches.length > 1) {
        console.warn('[call-command] resolveLeadIdForCall: multiple leads share this phone; refusing automatic client assignment');
      }
      return null;
    } catch (err) {
      console.warn('[call-command] resolveLeadIdForCall:', err.message);
      return null;
    }
  }

  async function syncCallSessionToCallLog(sessionId, disposition, notes, fallbackInfo = null, metricOverrides = null) {
    const cleanedSessionId = sanitizeUuid(sessionId);
    if (!cleanedSessionId) return null;
    const call = state.recentCalls.find((item) => item.id === cleanedSessionId) || await fetchCallSessionById(cleanedSessionId);
    const resolvedLeadId = await resolveLeadIdForCall(call, fallbackInfo);
    const payload = buildCallAttemptPayloadFromSession({
      ...(call || {}),
      lead_id: resolvedLeadId,
      agent_id: sanitizeUuid(currentUser()?.id) || sanitizeUuid(call?.agent_id)
    }, disposition, notes, metricOverrides);
    payload.notes = composeCallNotesWithSessionId(notes, cleanedSessionId);
    if (!payload.lead_id) {
      console.warn('[call-command] skipping CRM call log sync because session has no valid lead_id', call?.lead_id, fallbackInfo?.leadId);
      return null;
    }
    return syncCallPayloadToCallLog(payload);
  }

  async function ensureFallbackCallSession(info, disposition, notes, metricOverrides = null) {
    const supa = sb();
    if (!supa || !info) return null;
    const user = currentUser() || {};
    const key = String(disposition || '').trim().toLowerCase();
    const nowIso = new Date().toISOString();
    const startedAt = info.startedAt || nowIso;
    const durationSeconds = parseElapsedClock(byId('ccPcElapsed')?.textContent || '');
    const answered = typeof metricOverrides?.answered === 'boolean'
      ? metricOverrides.answered
      : !['voicemail', 'no_answer'].includes(key);
    const payload = {
      lead_id: sanitizeUuid(info.leadId),
      agent_user_id: sanitizeUuid(user.id),
      agent_email: String(user.email || '').trim() || null,
      from_number: info.fromNumber || null,
      to_number: info.phone || null,
      source_module: 'call_command',
      provider: 'quo',
      direction: 'outbound',
      status: 'completed',
      initiated_at: startedAt,
      answered_at: answered ? startedAt : null,
      ended_at: nowIso,
      answered,
      duration_seconds: durationSeconds || 0,
      disposition: disposition || null,
      disposition_at: nowIso,
      disposition_notes: String(notes || '').trim() || null
    };
    const { data, error } = await supa.from('call_sessions').insert(payload).select('id').single();
    if (error) {
      console.warn('[call-command] fallback call_sessions insert failed:', error.message);
      return null;
    }
    if (data?.id) {
      state.selectedSessionId = data.id;
      if (state.activeCall) state.activeCall.sessionId = data.id;
    }
    return data?.id || null;
  }

  async function syncFallbackCallToCallLog(info, disposition, notes, metricOverrides = null) {
    const resolvedLeadId = await resolveLeadIdForCall(null, info);
    const payload = buildCallAttemptPayloadFromSession({
      lead_id: resolvedLeadId,
      agent_id: sanitizeUuid(currentUser()?.id),
      answered: !['voicemail', 'no_answer'].includes(String(disposition || '').trim().toLowerCase()),
      duration_seconds: parseElapsedClock(byId('ccPcElapsed')?.textContent || ''),
      created_at: info?.startedAt || new Date().toISOString()
    }, disposition, notes, metricOverrides);
    if (!payload.lead_id) return null;
    return syncCallPayloadToCallLog(payload);
  }

  function pickFirst(...values) {
    for (const value of values) {
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function normalizeQueueLead(row = {}) {
    const joinedName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
    return {
      ...row,
      contact_name: pickFirst(row.contact_name, row.full_name, row.name, row.owner_name, row.customer_name, joinedName),
      city: pickFirst(row.city, row.town),
      county: pickFirst(row.county, row.parish),
      state: pickFirst(row.state, row.province),
      state_code: pickFirst(row.state_code),
      address: pickFirst(row.address, row.street_address, row.property_address),
      zip: pickFirst(row.zip, row.postal_code),
      damage_type: pickFirst(row.damage_type, row.loss_type, row.project_type),
      status: pickFirst(row.status, row.lead_status),
      last_call_at: row.last_call_at || row.last_contacted_at || row.updated_at || row.created_at || null
    };
  }

  function normalizeToken(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/county/g, '')
      .replace(/parish/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizePhoneForMatch(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  function normalizeAgentIdentity(id, email) {
    if (id != null && String(id).trim()) return `id:${String(id).trim()}`;
    if (email != null && String(email).trim()) return `email:${String(email).trim().toLowerCase()}`;
    return '';
  }

  function stableHash(value) {
    const input = String(value || '');
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function getLeadQueuePriorityMeta(lead) {
    if (lead && lead._queuePriorityMeta) return lead._queuePriorityMeta;
    const matches = getLeadStormMatches(lead);
    const latest = matches[0] || null;
    const now = Date.now();
    const latestTs = latest ? new Date(latest.beginDate || 0).getTime() : 0;
    const ageDays = latestTs ? Math.max(0, Math.floor((now - latestTs) / (24 * 60 * 60 * 1000))) : null;
    const kindWeights = { tornado: 42, wind: 28, hail: 24, storm: 16 };
    let score = 0;
    if (latest?._cityMatch) score += 170;
    else if (latest?._countyMatch) score += 120;
    else if (latest?._nearbyMatch && Number.isFinite(latest?._distanceMiles)) {
      if (latest._distanceMiles <= 5) score += 92;
      else if (latest._distanceMiles <= 15) score += 74;
      else if (latest._distanceMiles <= 35) score += 48;
      else score += 18;
    }
    if (latest?.kind) score += kindWeights[latest.kind] || kindWeights.storm;
    if (ageDays === 0) score += 44;
    else if (ageDays === 1) score += 36;
    else if (ageDays != null && ageDays <= 3) score += 26;
    else if (ageDays != null && ageDays <= 7) score += 18;
    else if (ageDays != null && ageDays <= 14) score += 10;
    score += Math.min(36, matches.length * 8);
    if (lead?.city) score += 8;
    if (lead?.county) score += 8;
    if (lead?.address) score += 6;
    if (lead?.zip) score += 4;
    const meta = {
      score,
      latest,
      matches,
      ageDays,
      locationLabel: [lead?.city, lead?.county, lead?.state].filter(Boolean).join(' · ') || 'No location',
      stormLabel: latest?.kind || 'storm'
    };
    if (lead) lead._queuePriorityMeta = meta;
    return meta;
  }

  async function loadActiveCallerRoster(supa) {
    const roster = new Map();
    const user = currentUser();
    const addRosterEntry = (id, email) => {
      const key = normalizeAgentIdentity(id, email);
      if (!key) return;
      roster.set(key, {
        key,
        id: id != null ? String(id).trim() : '',
        email: email != null ? String(email).trim().toLowerCase() : ''
      });
    };

    addRosterEntry(user?.id, user?.email);

    try {
      const { data } = await supa
        .from('agent_number_assignments')
        .select('agent_id, agent_email, is_active')
        .eq('is_active', true)
        .limit(200);
      (Array.isArray(data) ? data : []).forEach((row) => addRosterEntry(row.agent_id, row.agent_email));
    } catch (err) {
      console.warn('[call-command] active caller roster from assignments failed:', err.message);
    }

    try {
      const since = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000)).toISOString();
      const { data } = await supa
        .from('call_sessions')
        .select('agent_id:agent_user_id, agent_email, created_at')
        .eq('provider', 'quo')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500);
      (Array.isArray(data) ? data : []).forEach((row) => addRosterEntry(row.agent_id, row.agent_email));
    } catch (err) {
      console.warn('[call-command] active caller roster from sessions failed:', err.message);
    }

    const list = [...roster.values()].sort((a, b) => {
      const aLabel = a.email || a.id || a.key;
      const bLabel = b.email || b.id || b.key;
      return aLabel.localeCompare(bLabel);
    });
    const currentKey = normalizeAgentIdentity(user?.id, user?.email);
    const index = Math.max(0, list.findIndex((entry) => entry.key === currentKey));
    return { list, index, currentKey };
  }

  function splitQueueForAgent(leads, rosterInfo) {
    const list = Array.isArray(rosterInfo?.list) ? rosterInfo.list : [];
    if (list.length <= 1) {
      return {
        leads: leads.slice(0, 50),
        laneIndex: 0,
        laneCount: Math.max(1, list.length || 1)
      };
    }
    const laneCount = list.length;
    const laneIndex = Math.max(0, Number(rosterInfo?.index) || 0);
    const assigned = leads.filter((lead, idx) => (idx % laneCount) === laneIndex);
    return { leads: assigned.slice(0, 50), laneIndex, laneCount };
  }

  function getStormPrepContext(lead, matches = []) {
    const latest = [...matches].sort((a, b) => new Date(b.beginDate || 0) - new Date(a.beginDate || 0))[0] || null;
    const locationLabel = latest?.city || lead?.city || lead?.county || 'your area';
    const latestTs = latest ? new Date(latest.beginDate || 0).getTime() : 0;
    const ageDays = latestTs ? Math.max(0, Math.floor((Date.now() - latestTs) / (24 * 60 * 60 * 1000))) : null;
    const kind = latest?.kind || 'storm';
    const typeLabel = kind === 'tornado' ? 'tornado' : kind === 'wind' ? 'wind' : kind === 'hail' ? 'hail' : 'storm';
    let timingPhrase = 'after the recent weather';
    if (ageDays === 0) timingPhrase = 'after today's storm activity';
    else if (ageDays === 1) timingPhrase = 'after the storm activity yesterday';
    else if (ageDays != null && ageDays <= 3) timingPhrase = 'after the storm activity over the last few days';
    else if (ageDays != null && ageDays <= 7) timingPhrase = 'after the recent storm activity this week';
    else if (ageDays != null && ageDays <= 14) timingPhrase = 'after the recent storm activity';
    return { latest, locationLabel, ageDays, kind, typeLabel, timingPhrase };
  }

  function buildStormOpener(lead, matches = [], variant = 0) {
    const name = String(lead?.contact_name || 'there').trim();
    const firstName = name.split(/\s+/)[0] || 'there';
    const ctx = getStormPrepContext(lead, matches);
    const city = ctx.locationLabel;
    const openersByKind = {
      tornado: [
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. After the tornado activity near ${city}, we're doing free roof assessments in the neighborhood — we want to make sure your home is covered and that your insurance takes care of any repairs so you never pay a dime out of pocket. I just need two minutes to get you scheduled.`,
        `Hi ${firstName}, [Your Name] with Rapid Roofing. The tornado near ${city} left damage most people can't see from the ground. We're doing complimentary inspections nearby — it's a free peace-of-mind check and if there's damage your insurance handles it. Can we get your home on the schedule?`,
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. Because of the tornado activity near ${city} we're reaching out to make sure every home in the area gets a free assessment — it's a full roof health check, completely free, and if anything was damaged your insurance covers the repairs. Takes about 20 minutes. When's a good time?`
      ],
      wind: [
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. After the wind damage near ${city}, we're going door to door offering free roof assessments — most homeowners don't know they have damage until it becomes a bigger problem. The inspection is free, and if there's anything, your insurance covers the fix. Can I get you scheduled?`,
        `Hi ${firstName}, [Your Name] with Rapid Roofing. The recent wind near ${city} has been catching people off guard — we're doing free inspections in the area so homeowners can file before the window closes. Zero cost to you, insurance handles everything. When works for a quick 20-minute check?`,
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. Wind damage near ${city} often goes unnoticed until it turns into a leak. We're offering free assessments right now — it's a full roof health check at no cost, and if anything was affected your insurance takes care of it. I just need two minutes to lock in a time.`
      ],
      hail: [
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. After the hail near ${city}, we're doing free roof assessments in the area — hail damage is almost impossible to spot from the ground and most claims get missed. The inspection is completely free and your insurance handles any repairs. Can we get you on the schedule?`,
        `Hi ${firstName}, [Your Name] with Rapid Roofing. The hail that hit near ${city} left damage most people won't notice until it leaks. We're doing complimentary inspections nearby — it's a free peace-of-mind check, and if there's damage your insurance covers everything. Takes 20 minutes. When's a good time?`,
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. Because of the recent hail near ${city} we're reaching out to make sure homeowners get a free assessment before the insurance window closes. Zero out of pocket, full roof health check. I just need two minutes to get you scheduled.`
      ],
      storm: [
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. After the recent storm activity near ${city}, we're doing free roof assessments in the neighborhood — it's a full peace-of-mind check and if there's any damage your insurance covers the repairs so you never spend a dime. Can I get you scheduled?`,
        `Hi ${firstName}, [Your Name] with Rapid Roofing. ${ctx.timingPhrase} near ${city}, we're reaching out to make sure every home in the area gets a free inspection before the insurance window closes. Zero cost to you — if there's damage, your insurance handles it. When works for a quick 20-minute check?`,
        `Hi ${firstName}, this is [Your Name] with Rapid Roofing. Because of the recent weather near ${city} we want to make sure your home gets looked at — it's a free roof health check, completely at no cost, and if anything was affected your insurance takes care of all the repairs. I just need two minutes to lock in a time.`
      ]
    };
    const list = openersByKind[ctx.kind] || openersByKind.storm;
    return list[Math.abs(Number(variant) || 0) % list.length];
  }

  function buildPrepRotation(lead, matches = []) {
    state.prepVariant = (Number(state.prepVariant) || 0) + 1;
    const variant = state.prepVariant;
    const ctx = getStormPrepContext(lead, matches);
    const objectionHandles = [
      `If they say "I'm not interested," say: Totally understand - I'm only calling because of the recent ${ctx.typeLabel} activity near ${ctx.locationLabel}, and the inspection is free.`,
      `If they say "We already have a roofer," say: That's fair - Rapid Roofing can still give you a free second opinion so you know what the recent ${ctx.typeLabel} activity may have done.`,
      'If they say "Call me later," say: Absolutely - what time today works best for a quick 30-second follow-up so I don't keep chasing you?'
    ];
    const motivationLines = [
      `Keep it short and local - lead with the ${ctx.typeLabel} reference, then move straight into the free inspection.`,
      'Remember: the goal is not to sell the whole job on the call - it is just to earn the inspection.',
      'Stay upbeat. One strong opener and one simple question beats a long explanation every time.'
    ];
    const reassuranceLines = [
      'Reassure them that the inspection is free, quick, and gives them photos before they decide anything.',
      ctx.kind === 'hail'
        ? 'Reassure them that hail damage often is not obvious from the ground, which is why a quick check helps.'
        : ctx.kind === 'wind'
          ? 'Reassure them that wind damage can loosen shingles without being obvious from the ground.'
          : ctx.kind === 'tornado'
            ? 'Reassure them that even minor tornado-path damage can create roof issues that are easy to miss at first.'
            : 'Reassure them that many homeowners cannot see storm damage from the ground, which is why a quick check helps.',
      `Reassure them that this is just a simple next step after the recent ${ctx.typeLabel} activity - no pressure, just a clear roof check.`
    ];
    return {
      opener: buildStormOpener(lead, matches, variant),
      objection: objectionHandles[variant % objectionHandles.length],
      motivation: motivationLines[(variant + 1) % motivationLines.length],
      reassurance: reassuranceLines[(variant + 2) % reassuranceLines.length]
    };
  }

  function getLeadStormMatches(lead) {
    const reports = (typeof stormIntel !== 'undefined' && Array.isArray(stormIntel?.severeReports))
      ? stormIntel.severeReports
      : [];
    const leadState = normalizeToken(lead?.state || lead?.state_code || 'FL');
    const leadCounty = normalizeToken(lead?.county || '');
    const leadCity = normalizeToken(lead?.city || '');
    const cachedCoords = (typeof getCachedLeadCoords === 'function') ? getCachedLeadCoords(lead) : null;
    const inferredCounty = normalizeToken(cachedCoords?.county || '');
    const effectiveCounty = leadCounty || inferredCounty;
    const recentCutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);

    const mapped = reports
      .map((report) => {
        const reportState = normalizeToken(report?.state || 'FL');
        if (leadState && reportState && reportState !== leadState) return null;
        const cityMatch = Boolean(leadCity) && normalizeToken(report?.city || '') === leadCity;
        const countyMatch = Boolean(effectiveCounty) && normalizeToken(report?.county || '') === effectiveCounty;
        const ts = new Date(report?.beginDate || 0).getTime();
        const reportLat = Number(report?.lat);
        const reportLon = Number(report?.lon);
        const distanceMiles = (cachedCoords && Number.isFinite(reportLat) && Number.isFinite(reportLon) && typeof haversineMiles === 'function')
          ? haversineMiles(Number(cachedCoords.lat), Number(cachedCoords.lon), reportLat, reportLon)
          : null;
        return {
          ...report,
          _cityMatch: cityMatch,
          _countyMatch: countyMatch,
          _nearbyMatch: false,
          _distanceMiles: Number.isFinite(distanceMiles) ? distanceMiles : null,
          _isRecent: Number.isFinite(ts) && ts >= recentCutoff,
          _sortScore: (cityMatch ? 100 : 0) + (countyMatch ? 40 : 0) + ((Number.isFinite(ts) && ts >= recentCutoff) ? 15 : 0)
        };
      })
      .filter(Boolean);

    const strictMatches = mapped
      .filter((report) => report._cityMatch || report._countyMatch)
      .sort((a, b) => b._sortScore - a._sortScore || new Date(b.beginDate || 0) - new Date(a.beginDate || 0));
    if (strictMatches.length) return strictMatches;

    const nearbyMatches = mapped
      .filter((report) => Number.isFinite(report._distanceMiles))
      .sort((a, b) => a._distanceMiles - b._distanceMiles || new Date(b.beginDate || 0) - new Date(a.beginDate || 0))
      .map((report, index) => ({
        ...report,
        _nearbyMatch: true,
        _sortScore: Math.max(1, 60 - Math.round(report._distanceMiles || 0)) + (report._isRecent ? 15 : 0) - index
      }));

    const withinRadius = nearbyMatches.filter((report) => (report._distanceMiles || 0) <= 35);
    if (withinRadius.length) return withinRadius;
    return nearbyMatches.slice(0, 6);
  }


  async function ensureLeadCoordsForPreview(lead) {
    try {
      if (typeof getCachedLeadCoords === 'function') {
        const existing = getCachedLeadCoords(lead);
        if (existing && Number.isFinite(Number(existing.lat)) && Number.isFinite(Number(existing.lon))) return existing;
      }

      const query = (typeof getLeadLocationQuery === 'function')
        ? getLeadLocationQuery(lead)
        : [lead?.address, lead?.city, lead?.state || lead?.state_code || 'FL', lead?.zip].filter(Boolean).join(', ');
      if (!query) return null;

      const geoUrl = `/.netlify/functions/lead-geo?city=${encodeURIComponent(lead?.city || '')}&state=${encodeURIComponent(lead?.state || lead?.state_code || 'FL')}&zip=${encodeURIComponent(lead?.zip || '')}&address=${encodeURIComponent(lead?.address || '')}&q=${encodeURIComponent(query)}`;
      const res = await fetch(geoUrl);
      if (!res.ok) throw new Error('Lead preview geocode request failed');
      const data = await res.json();
      if (!data?.ok || !Number.isFinite(Number(data.lat)) || !Number.isFinite(Number(data.lon))) return null;

      const coords = {
        lat: Number(data.lat),
        lon: Number(data.lon),
        label: data.label || query,
        county: (typeof normalizeStormCounty === 'function') ? normalizeStormCounty(data.county || '') : String(data.county || '').trim(),
        updatedAt: new Date().toISOString(),
        inferred: data.source !== 'nominatim'
      };

      try {
        if (typeof getLeadGeoCacheKey === 'function' && typeof saveStormLeadGeoCache === 'function' && typeof stormLeadGeoCache !== 'undefined') {
          const cacheKey = getLeadGeoCacheKey(lead);
          stormLeadGeoCache[cacheKey] = {
            lat: coords.lat,
            lon: coords.lon,
            label: coords.label,
            county: coords.county,
            updatedAt: coords.updatedAt,
            inferred: false
          };
          saveStormLeadGeoCache();
        }
      } catch (_) {}

      if (!lead.county && coords.county) {
        lead.county = coords.county;
      }
      return coords;
    } catch (_) {
      return null;
    }
  }

  function renderCallPrepPanel(lead, matches = [], opts = {}) {
    const panel = byId('ccPrepPanel');
    if (!panel) return;
    const prep = buildPrepRotation(lead, matches);
    const locationBits = [lead.city, lead.county, lead.state].filter(Boolean).join(' · ');

    panel.innerHTML = `
      <h3>Call Prep</h3>
      <p><strong>${escapeHtml(lead.contact_name || 'Unnamed lead')}</strong><br/>
         ${escapeHtml(formatPhone(lead.phone))}<br/>
         ${escapeHtml(locationBits || 'No location on file')}</p>
      <div class="cc-detail-section">
        <strong>Live opener + coaching</strong>
        <p>These tips rotate with each fresh prep so the opener, objection handle, reassurance, and motivation do not stay identical all day.</p>
        <div class="cc-prep-stack">
          <div class="cc-prep-card cc-prep-opener">
            <span class="cc-prep-label">Opener</span>
            <div class="cc-opener-box" id="ccOpenerText">${escapeHtml(prep.opener)}</div>
            <div class="cc-copy-row">
              <button type="button" class="cc-btn-mini" id="ccCopyOpenerBtn"><i class="fas fa-copy"></i> Copy opener</button>
            </div>
          </div>
          <div class="cc-prep-card">
            <span class="cc-prep-label">Common objection handle</span>
            <p>${escapeHtml(prep.objection)}</p>
          </div>
          <div class="cc-prep-card">
            <span class="cc-prep-label">Reassurance</span>
            <p>${escapeHtml(prep.reassurance)}</p>
          </div>
          <div class="cc-prep-card">
            <span class="cc-prep-label">Motivation</span>
            <p>${escapeHtml(prep.motivation)}</p>
          </div>
        </div>
        <div class="cc-prep-actions">
          <button type="button" class="cc-btn-mini" id="ccRotatePrepBtn"><i class="fas fa-rotate"></i> Rotate tips</button>
          <button type="button" class="btn-primary" id="ccPreviewCallBtn"><i class="fas fa-phone"></i> Call This Lead</button>
        </div>
      </div>
    `;

    byId('ccCopyOpenerBtn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prep.opener);
        setStatus('Opener copied.', 'success');
      } catch (_) {
        setStatus('Could not copy opener on this device.', 'warn');
      }
    });
    byId('ccRotatePrepBtn')?.addEventListener('click', () => renderCallPrepPanel(lead, matches, opts));
    byId('ccPreviewCallBtn')?.addEventListener('click', () => initiateCall(lead.id, lead.phone, lead.contact_name || lead.phone));
  }

  function renderLeadStormPreview(lead, opts = {}) {
    const panel = byId('ccDetailPanel');
    if (!panel) return;
    const stormError = opts.stormError || '';
    const matches = stormError ? [] : getLeadStormMatches(lead);
    const recentMatches = matches.filter((report) => report._isRecent);
    const preview = matches.slice(0, 6);
    const kinds = {
      hail: matches.filter((r) => r.kind === 'hail').length,
      wind: matches.filter((r) => r.kind === 'wind').length,
      tornado: matches.filter((r) => r.kind === 'tornado').length
    };
    const locationBits = [lead.city, lead.county, lead.state].filter(Boolean).join(' · ');

    panel.innerHTML = `
      <h3>Lead Storm Intel</h3>
      <p><strong>${escapeHtml(lead.contact_name || 'Unnamed lead')}</strong><br/>
         ${escapeHtml(formatPhone(lead.phone))}<br/>
         ${escapeHtml(locationBits || 'No location on file')}</p>
      <div class="cc-detail-section">
        <strong>Storm Snapshot</strong>
        ${stormError ? `<p>Could not load storm feed: ${escapeHtml(stormError)}</p>` : `
          <div class="cc-storm-kpis">
            <div class="cc-storm-kpi"><span>Area matches</span><strong>${matches.length}</strong></div>
            <div class="cc-storm-kpi"><span>Last 14 days</span><strong>${recentMatches.length}</strong></div>
            <div class="cc-storm-kpi"><span>Hail</span><strong>${kinds.hail}</strong></div>
            <div class="cc-storm-kpi"><span>Wind</span><strong>${kinds.wind}</strong></div>
            <div class="cc-storm-kpi"><span>Tornado</span><strong>${kinds.tornado}</strong></div>
          </div>
          ${preview.length ? `<div class="cc-storm-list">${preview.map((report) => {
            const label = report.kind === 'wind' ? 'Wind' : report.kind === 'tornado' ? 'Tornado' : 'Hail';
            const magnitude = report.magnitudeLabel || report.eventType || label;
            const sourceUrl = report.sourceUrl || 'https://www.ncei.noaa.gov/stormevents/';
            const matchBadge = report._cityMatch
              ? 'City match'
              : report._countyMatch
                ? 'County match'
                : report._nearbyMatch && Number.isFinite(report._distanceMiles)
                  ? `Nearest · ${Math.round(report._distanceMiles)} mi`
                  : 'Nearby match';
            return `<article class="cc-storm-item">
              <div class="cc-storm-item-top">
                <span class="cc-pill ${report.kind === 'tornado' ? 'cc-pill-warn' : report.kind === 'wind' ? 'cc-pill-info' : 'cc-pill-success'}">${escapeHtml(label)}</span>
                <span class="cc-pill cc-pill-muted">${escapeHtml(matchBadge)}</span>
                ${report._isRecent ? '<span class="cc-pill cc-pill-info">Last 14 days</span>' : ''}
              </div>
              <strong>${escapeHtml(report.city || report.county || 'Nearby report')}</strong>
              <p>${escapeHtml(magnitude)} · ${escapeHtml(formatWhen(report.beginDate))}${Number.isFinite(report._distanceMiles) ? ` · ${escapeHtml(`${Math.round(report._distanceMiles)} mi away`)}` : ''}</p>
              <small>${escapeHtml(report.narrative || 'Official storm report')}</small>
              <div class="cc-storm-actions"><a class="cc-btn-mini" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">Open source ↗</a></div>
            </article>`;
          }).join('')}</div>` : '<p>No exact city/county match yet, and no nearby geocoded storm reports were found for this lead.</p>'}
        `}
      </div>
    `;

    renderCallPrepPanel(lead, matches, opts);
  }

  async function selectQueueLead(leadId) {
    const lead = state.activeQueue.find((item) => String(item.id) === String(leadId));
    if (!lead) return;
    state.selectedLeadId = lead.id;
    renderQueue();
    const panel = byId('ccDetailPanel');
    if (panel) {
      panel.innerHTML = '<div class="cc-empty">Loading storm intel for this lead…</div>';
    }
    const prepPanel = byId('ccPrepPanel');
    if (prepPanel) {
      prepPanel.innerHTML = '<div class="cc-empty">Loading rotating call prep for this lead…</div>';
    }
    try {
      if (typeof ensureStormIntelLoaded === 'function') {
        await ensureStormIntelLoaded(false);
      }
      await ensureLeadCoordsForPreview(lead);
      renderLeadStormPreview(lead);
    } catch (err) {
      renderLeadStormPreview(lead, { stormError: err?.message || 'Failed to load storm feed' });
    }
  }

  // ---------- Today's call queue ----------
  async function loadCallQueue() {
    const supa = sb();
    if (!supa) return;
    const candidates = ['crm_leads', 'leads'];
    let lastError = null;
    try {
      for (const tableName of candidates) {
        try {
          const { data, error } = await supa
            .from(tableName)
            .select('*')
            .not('phone', 'is', null)
            .limit(250);
          if (error) throw error;

          const baseRows = (Array.isArray(data) ? data : [])
            .map(normalizeQueueLead)
            .filter((lead) => lead.phone && lead.id != null);

          if (!baseRows.length) {
            console.warn(`[call-command] ${tableName} returned 0 queueable leads, trying next source if available`);
            continue;
          }

          const candidateLeadIds = [...new Set(baseRows.map((lead) => lead.id).filter(Boolean))];
          const calledLeadIds = new Set();
          const calledPhones = new Set();

          if (candidateLeadIds.length) {
            try {
              const { data: leadCalls, error: leadCallError } = await supa
                .from('call_sessions')
                .select('lead_id, to_number, status, created_at')
                .in('lead_id', candidateLeadIds)
                .limit(5000);
              if (leadCallError) throw leadCallError;
              (Array.isArray(leadCalls) ? leadCalls : []).forEach((call) => {
                if (call?.lead_id != null) calledLeadIds.add(String(call.lead_id));
                const phoneKey = normalizePhoneForMatch(call?.to_number || '');
                if (phoneKey) calledPhones.add(phoneKey);
              });
            } catch (callErr) {
              console.warn('[call-command] queue call history lookup by lead failed:', callErr.message);
            }
          }

          const uncalledRows = baseRows.filter((lead) => {
            const idKey = lead?.id != null ? String(lead.id) : '';
            const phoneKey = normalizePhoneForMatch(lead.phone);
            if (idKey && calledLeadIds.has(idKey)) return false;
            if (phoneKey && calledPhones.has(phoneKey)) return false;
            return true;
          });

          const prioritized = uncalledRows
            .map((lead) => ({ lead, meta: getLeadQueuePriorityMeta(lead) }))
            .sort((a, b) => {
              if ((b.meta?.score || 0) !== (a.meta?.score || 0)) return (b.meta?.score || 0) - (a.meta?.score || 0);
              const aRecent = a.meta?.latest ? new Date(a.meta.latest.beginDate || 0).getTime() : 0;
              const bRecent = b.meta?.latest ? new Date(b.meta.latest.beginDate || 0).getTime() : 0;
              if (bRecent !== aRecent) return bRecent - aRecent;
              return String(a.lead.contact_name || '').localeCompare(String(b.lead.contact_name || ''));
            })
            .map((entry) => entry.lead);

          const rosterInfo = await loadActiveCallerRoster(supa);
          const split = splitQueueForAgent(prioritized, rosterInfo);
          state.activeQueue = split.leads;
          state.queueInfo = {
            totalUncalled: prioritized.length,
            laneCount: split.laneCount,
            laneIndex: split.laneIndex,
            assignedCount: split.leads.length
          };
          renderQueue();
          return;
        } catch (err) {
          lastError = err;
          console.warn(`[call-command] queue load failed for ${tableName}:`, err.message);
        }
      }
      throw lastError || new Error('No compatible leads table found');
    } catch (err) {
      console.warn('[call-command] queue load:', err.message);
      const el = byId('ccCallQueue');
      if (el) el.innerHTML = `<div class="cc-empty">Could not load lead queue: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderQueue() {
    const el = byId('ccCallQueue');
    if (!el) return;
    if (!state.activeQueue.length) {
      const queueInfo = state.queueInfo?.totalUncalled
        ? `<div class="cc-muted" style="margin-bottom:10px;">All currently uncalled storm-priority leads are already assigned to other callers right now. Tap refresh in a moment.</div>`
        : '';
      el.innerHTML = `${queueInfo}<div class="cc-empty">No leads in the call queue. Add leads in the Leads tab.</div>`;
      return;
    }
    const queueInfo = state.queueInfo
      ? `<div class="cc-muted" style="margin-bottom:10px;">Showing ${escapeHtml(String(state.queueInfo.assignedCount || state.activeQueue.length))} leads from your caller lane (${escapeHtml(String((state.queueInfo.laneIndex || 0) + 1))}/${escapeHtml(String(state.queueInfo.laneCount || 1))}) · ${escapeHtml(String(state.queueInfo.totalUncalled || state.activeQueue.length))} uncalled leads prioritized by storm activity.</div>`
      : '';
    el.innerHTML = queueInfo + state.activeQueue.slice(0, 25).map((lead) => `
      <article class="cc-queue-row ${state.selectedLeadId === lead.id ? 'active' : ''}" data-lead-id="${escapeHtml(lead.id)}">
        <div class="cc-queue-main">
          <strong>${escapeHtml(lead.contact_name || 'Unnamed lead')}</strong>
          <p>${escapeHtml(formatPhone(lead.phone))}</p>
          <small>${escapeHtml([lead.city, lead.county, lead.state].filter(Boolean).join(' · ') || 'No location')}${lead.damage_type ? ' · ' + escapeHtml(lead.damage_type) : ''}</small>
        </div>
        <div class="cc-queue-actions">
          <button type="button" class="btn-primary cc-call-btn" data-lead-id="${escapeHtml(lead.id)}" data-phone="${escapeHtml(lead.phone)}" data-name="${escapeHtml(lead.contact_name || '')}">
            <i class="fas fa-phone"></i> Call
          </button>
        </div>
      </article>
    `).join('');

    el.querySelectorAll('.cc-queue-row').forEach((row) => {
      row.addEventListener('click', () => selectQueueLead(row.dataset.leadId));
    });

    el.querySelectorAll('.cc-call-btn').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        initiateCall(btn.dataset.leadId, btn.dataset.phone, btn.dataset.name);
      });
    });
  }

  // ---------- Initiate call (click-to-call via Quo app) ----------
  async function initiateCall(leadId, phone, name) {
    // Block starting a new call if there's an unlogged one in progress
    if (state.activeCall && !state.activeCall.logged) {
      const proceed = confirm(`You haven't logged your call to ${state.activeCall.leadName || state.activeCall.phone} yet.\n\nLog it now? (Cancel = discard and start new call)`);
      if (proceed) { focusActiveCallModal(); return; }
      closePostCallModal({ discarded: true });
    }

    setStatus(`Preparing call to ${name || formatPhone(phone)}…`, 'info');
    try {
      const user = currentUser();
      const res = await fetch('/.netlify/functions/quo-dial-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId,
          toNumber: phone,
          agentEmail: user?.email || '',
          agentId: user?.id || null,
          sourceModule: 'call-command'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Dial link request failed');

      // Show flagged-number warning if applicable
      if (data.fromNumberFlagged) {
        setStatus(`⚠ Heads up: ${formatPhone(data.fromNumber)} is currently FLAGGED. Calls may show "Scam Likely". Ask admin to reassign you to a clean number.`, 'warn');
      } else if (data.fromNumberSource === 'lru' || data.fromNumberSource === 'random') {
        setStatus(`You don't have a number assigned. Dialing from ${formatPhone(data.fromNumber)} (auto-picked). Ask admin to assign you a number.`, 'info');
      } else {
        setStatus(`Calling ${name || formatPhone(phone)} from ${formatPhone(data.fromNumber)}. Quo will open in a moment…`, 'success');
      }
      state.selectedSessionId = sanitizeUuid(data.sessionId);
      if (leadId) {
        const normalizedLeadId = String(leadId);
        state.activeQueue = state.activeQueue.filter((lead) => String(lead.id) !== normalizedLeadId);
        if (String(state.selectedLeadId || '') === normalizedLeadId) {
          state.selectedLeadId = state.activeQueue[0]?.id || null;
        }
        renderQueue();
        if (state.selectedLeadId) selectQueueLead(state.selectedLeadId);
        window.setTimeout(() => loadCallQueue(), 1500);
      }

      // Pop the "Log This Call" modal immediately - blocks the next call
      openPostCallModal({
        sessionId: sanitizeUuid(data.sessionId),
        leadId,
        leadName: name || formatPhone(phone),
        phone,
        fromNumber: data.fromNumber,
        startedAt: data.dialAt
      });

      // Launch the Quo desktop/mobile app via tel: link
      window.location.href = data.telUrl;

      // Refresh recent calls after a short delay (webhook will populate)
      setTimeout(() => { loadRecentCalls(); }, 2500);
    } catch (err) {
      console.error('[call-command] initiateCall:', err);
      setStatus(`Could not start call: ${err.message}`, 'error');
    }
  }

  // =================================================================
  // POST-CALL LOGGING MODAL
  // Opens immediately when a call is initiated. Forces the agent to
  // log a disposition before they can start another call.
  // =================================================================
  function openPostCallModal(info) {
    state.activeCall = { ...info, logged: false, status: 'dialing', startedTs: Date.now() };
    const modal = byId('ccPostCallModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.classList.add('cc-modal-open');

    if (byId('ccPcLeadName')) byId('ccPcLeadName').textContent = info.leadName || formatPhone(info.phone);
    if (byId('ccPcPhone')) byId('ccPcPhone').textContent = formatPhone(info.phone);
    if (byId('ccPcFromNumber')) byId('ccPcFromNumber').textContent = formatPhone(info.fromNumber);
    if (byId('ccPcCallStatus')) byId('ccPcCallStatus').innerHTML = '<span class="cc-pill cc-pill-info">Dialing…</span>';
    if (byId('ccPcSummary')) byId('ccPcSummary').textContent = 'Waiting for call to complete… the AI summary will appear here automatically when Quo finishes processing the recording.';
    if (byId('ccPcRecordingWrap')) byId('ccPcRecordingWrap').innerHTML = '';
    if (byId('ccPcTranscriptWrap')) byId('ccPcTranscriptWrap').innerHTML = '<div class="cc-empty">Transcript will appear automatically if Quo provides one.</div>';
    if (byId('ccPcDispoNotes')) byId('ccPcDispoNotes').value = '';
    document.querySelectorAll('.cc-pc-dispo-btn').forEach((b) => b.classList.remove('active'));
    setPostCallMetricInputs({ answered: false, allowed_presentation: false, appointment_booked: false });
    state.activeCall.pendingDispo = '';

    // Live countdown of call duration
    if (state.activeCallTimer) clearInterval(state.activeCallTimer);
    state.activeCallTimer = setInterval(() => {
      const el = byId('ccPcElapsed');
      if (!el) return;
      const secs = Math.floor((Date.now() - state.activeCall.startedTs) / 1000);
      const m = Math.floor(secs / 60), r = secs % 60;
      el.textContent = `${m}:${String(r).padStart(2, '0')}`;
    }, 1000);

    // Live poll of Supabase for webhook updates
    if (state.activeCallPoll) clearInterval(state.activeCallPoll);
    state.activeCallPoll = setInterval(() => refreshActiveCallStatus(), 5000);
    refreshActiveCallStatus(); // immediate first fetch in ~2s after dial
  }

  async function refreshActiveCallStatus() {
    const sessionId = sanitizeUuid(state.activeCall?.sessionId);
    if (!state.activeCall || !sessionId) return;
    const supa = sb();
    if (!supa) return;
    try {
      const { data } = await supa
        .from('call_sessions')
        .select('id, status, answered, duration_seconds, recording_url, ai_summary, ai_transcript, ended_at')
        .eq('id', sessionId)
        .maybeSingle();
      if (!data) return;

      // Update status pill
      const statusEl = byId('ccPcCallStatus');
      if (statusEl) {
        const s = (data.status || '').toLowerCase();
        let pill = '<span class="cc-pill cc-pill-info">Dialing…</span>';
        if (s === 'ringing') pill = '<span class="cc-pill cc-pill-info">Ringing…</span>';
        else if (s === 'completed' && data.answered) pill = `<span class="cc-pill cc-pill-success">Answered · ${formatDuration(data.duration_seconds)}</span>`;
        else if (s === 'completed') pill = '<span class="cc-pill cc-pill-warn">Voicemail / No answer</span>';
        statusEl.innerHTML = pill;
      }

      // Update recording player if available
      const recWrap = byId('ccPcRecordingWrap');
      if (recWrap && data.recording_url && !recWrap.innerHTML.includes('<audio')) {
        recWrap.innerHTML = `<audio controls src="${escapeHtml(data.recording_url)}" style="width:100%;margin-top:8px;"></audio>`;
      }

      // Update AI summary if available
      const sumEl = byId('ccPcSummary');
      if (sumEl && data.ai_summary) {
        sumEl.textContent = data.ai_summary;
        sumEl.classList.add('cc-pc-summary-ready');
      }

      const transcriptWrap = byId('ccPcTranscriptWrap');
      if (transcriptWrap && data.ai_transcript) {
        transcriptWrap.innerHTML = `<details class="cc-detail-section" open><summary><strong>Full transcript</strong></summary><pre class="cc-transcript">${escapeHtml(data.ai_transcript)}</pre></details>`;
      } else if (transcriptWrap && data.ended_at) {
        transcriptWrap.innerHTML = '<div class="cc-empty">No transcript available yet. Quo may still be processing it.</div>';
      }

      if (data.ended_at && state.activeCall) {
        state.activeCall.endedAt = data.ended_at;
        state.activeCall.mediaReady = Boolean(data.recording_url || data.ai_summary || data.ai_transcript);
      }

      // Once ended, suggest auto-disposition based on outcome
      if (data.ended_at && !state.activeCall.suggestedDispo) {
        state.activeCall.suggestedDispo = data.answered ? null : 'no_answer';
        if (state.activeCall.suggestedDispo) {
          const btn = document.querySelector(`.cc-pc-dispo-btn[data-dispo="${state.activeCall.suggestedDispo}"]`);
          if (btn && !document.querySelector('.cc-pc-dispo-btn.active')) {
            btn.classList.add('suggested');
          }
        }
      }
    } catch (err) {
      console.warn('[call-command] refreshActiveCallStatus:', err.message);
    }
  }

  function focusActiveCallModal() {
    const modal = byId('ccPostCallModal');
    if (modal) modal.classList.remove('hidden');
    document.body.classList.add('cc-modal-open');
  }

  function closePostCallModal({ discarded = false } = {}) {
    const modal = byId('ccPostCallModal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('cc-modal-open');
    if (state.activeCallTimer) { clearInterval(state.activeCallTimer); state.activeCallTimer = null; }
    if (state.activeCallPoll) { clearInterval(state.activeCallPoll); state.activeCallPoll = null; }
    if (state.activeCall && discarded) {
      console.log('[call-command] discarded unlogged call', state.activeCall.sessionId);
    }
    state.activeCall = null;
  }

  function findNextLeadCandidate(queue = [], activeCall = {}) {
    const currentLeadId = String(activeCall?.leadId || '');
    const currentPhone = normalizePhoneForMatch(activeCall?.phone || '');
    return (Array.isArray(queue) ? queue : []).find((lead) => {
      const sameLead = currentLeadId && String(lead?.id || '') === currentLeadId;
      const samePhone = currentPhone && normalizePhoneForMatch(lead?.phone || '') === currentPhone;
      return !sameLead && !samePhone;
    }) || null;
  }

  async function savePostCallAndAdvance(autoAdvance) {
    if (!state.activeCall) return;
    const activeCall = { ...state.activeCall };
    const dispo = activeCall.pendingDispo;
    if (!dispo) {
      setStatus('Pick a disposition before saving.', 'warn');
      const btnRow = document.querySelector('.cc-pc-dispo-row');
      if (btnRow) btnRow.classList.add('cc-pc-pulse');
      setTimeout(() => btnRow?.classList.remove('cc-pc-pulse'), 1200);
      return;
    }
    const notes = byId('ccPcDispoNotes')?.value || '';
    const metrics = readPostCallMetricInputs(dispo);
    const queueSnapshot = Array.isArray(state.activeQueue) ? [...state.activeQueue] : [];
    try {
      await saveDisposition(activeCall.sessionId, dispo, notes, activeCall, metrics);
      if (state.activeCall) state.activeCall.logged = true;

      let nextLead = null;
      if (autoAdvance) {
        nextLead = findNextLeadCandidate(queueSnapshot, activeCall);
        if (!nextLead) {
          await loadCallQueue();
          nextLead = findNextLeadCandidate(state.activeQueue, activeCall);
        }
      }

      closePostCallModal();
      setStatus(`Call logged: ${dispo.replace('_', ' ')}.`, 'success');

      if (autoAdvance) {
        if (nextLead?.phone) {
          if (nextLead?.id) state.selectedLeadId = nextLead.id;
          setTimeout(() => initiateCall(nextLead.id || null, nextLead.phone, nextLead.contact_name || nextLead.phone), 450);
        } else {
          setStatus('Call logged. No more leads in queue - add more in the Leads tab.', 'info');
        }
      }
    } catch (err) {
      setStatus(`Could not save: ${err.message}`, 'error');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.activeCall?.sessionId) refreshActiveCallStatus();
  });
  window.addEventListener('focus', () => {
    if (state.activeCall?.sessionId) refreshActiveCallStatus();
  });

  function bindPostCallModal() {
    document.querySelectorAll('.cc-pc-dispo-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!state.activeCall) return;
        state.activeCall.pendingDispo = btn.dataset.dispo;
        setPostCallMetricInputs(metricDefaultsForDisposition(btn.dataset.dispo));
        document.querySelectorAll('.cc-pc-dispo-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
    byId('ccPcAnswered')?.addEventListener('change', (event) => {
      if (!event.target.checked) {
        if (byId('ccPcPresented')) byId('ccPcPresented').checked = false;
        if (byId('ccPcBooked')) byId('ccPcBooked').checked = false;
      }
    });
    byId('ccPcPresented')?.addEventListener('change', (event) => {
      if (event.target.checked && byId('ccPcAnswered')) byId('ccPcAnswered').checked = true;
      if (!event.target.checked && byId('ccPcBooked')) byId('ccPcBooked').checked = false;
    });
    byId('ccPcBooked')?.addEventListener('change', (event) => {
      if (event.target.checked) {
        if (byId('ccPcAnswered')) byId('ccPcAnswered').checked = true;
        if (byId('ccPcPresented')) byId('ccPcPresented').checked = true;
      }
    });
    byId('ccPcSaveBtn')?.addEventListener('click', () => savePostCallAndAdvance(false));
    byId('ccPcSaveNextBtn')?.addEventListener('click', () => savePostCallAndAdvance(true));
    byId('ccPcCloseBtn')?.addEventListener('click', () => {
      if (state.activeCall && !state.activeCall.logged) {
        if (!confirm('Close without logging this call? The session row will stay in the database but won\'t have a disposition.')) return;
      }
      closePostCallModal({ discarded: true });
    });
  }

  // ---------- Recent calls (driven by webhook \u2192 Supabase) ----------
  async function loadRecentCalls() {
    const supa = sb();
    if (!supa) return;
    try {
      const { data, error } = await supa
        .from('call_sessions')
        .select('id, lead_id, agent_id:agent_user_id, agent_email, from_number, to_number, direction, status, answered, duration_seconds, recording_url, ai_summary, ai_transcript, disposition, disposition_at, disposition_notes, initiated_at, answered_at, ended_at, created_at')
        .eq('provider', 'quo')
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      state.recentCalls = Array.isArray(data) ? data : [];
      computeDailyStats();
      renderRecentCalls();
    } catch (err) {
      console.warn('[call-command] loadRecentCalls:', err.message);
    }
  }

  function computeDailyStats() {
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const today = state.recentCalls.filter((c) => new Date(c.created_at).getTime() >= todayStart.getTime());
    state.dailyStats = {
      calls: today.length,
      answered: today.filter((c) => c.answered).length,
      booked: today.filter((c) => (c.disposition || '').toLowerCase() === 'booked').length
    };
    if (byId('ccStatCalls')) byId('ccStatCalls').textContent = state.dailyStats.calls;
    if (byId('ccStatAnswered')) byId('ccStatAnswered').textContent = state.dailyStats.answered;
    if (byId('ccStatBooked')) byId('ccStatBooked').textContent = state.dailyStats.booked;
    if (byId('ccStatAnswerRate')) {
      const rate = state.dailyStats.calls ? Math.round((state.dailyStats.answered / state.dailyStats.calls) * 100) : 0;
      byId('ccStatAnswerRate').textContent = rate + '%';
    }
  }

  function statusBadge(call) {
    const s = (call.status || '').toLowerCase();
    if (call.answered === false && s !== 'ringing' && s !== 'dialing') return '<span class="cc-pill cc-pill-warn">No answer</span>';
    if (s === 'dialing') return '<span class="cc-pill cc-pill-info">Dialing</span>';
    if (s === 'ringing') return '<span class="cc-pill cc-pill-info">Ringing</span>';
    if (s === 'completed' && call.answered) return '<span class="cc-pill cc-pill-success">Answered</span>';
    if (s === 'completed') return '<span class="cc-pill cc-pill-warn">Voicemail</span>';
    return `<span class="cc-pill">${escapeHtml(s || 'unknown')}</span>`;
  }

  function dispositionBadge(call) {
    const d = (call.disposition || '').toLowerCase();
    if (!d) return '<span class="cc-pill cc-pill-muted">No disposition</span>';
    if (d === 'booked') return '<span class="cc-pill cc-pill-success">Booked</span>';
    if (d === 'callback') return '<span class="cc-pill cc-pill-info">Callback</span>';
    if (d === 'not_interested') return '<span class="cc-pill cc-pill-warn">Not interested</span>';
    if (d === 'voicemail') return '<span class="cc-pill cc-pill-muted">Voicemail</span>';
    return `<span class="cc-pill">${escapeHtml(call.disposition)}</span>`;
  }

  function recentCallAgentLabel(call) {
    const byEmail = String(call?.agent_email || '').trim();
    if (byEmail) return byEmail;
    const byId = String(call?.agent_id || '').trim();
    return byId || 'Unassigned agent';
  }

  function renderRecentCalls() {
    const el = byId('ccRecentCalls');
    if (!el) return;
    if (!state.recentCalls.length) {
      el.innerHTML = '<div class="cc-empty">No calls yet today. Click <strong>Call</strong> on a lead above to get started.</div>';
      return;
    }
    el.innerHTML = state.recentCalls.map((call) => `
      <article class="cc-call-row ${state.selectedSessionId === call.id ? 'active' : ''}" data-session-id="${escapeHtml(call.id)}">
        <div class="cc-call-main">
          <div class="cc-call-head">
            <strong>${escapeHtml(formatPhone(call.to_number))}</strong>
            ${statusBadge(call)}
            ${dispositionBadge(call)}
          </div>
          <small>${escapeHtml(recentCallAgentLabel(call))} · From ${escapeHtml(formatPhone(call.from_number))} · ${formatWhen(call.created_at)} · ${formatDuration(call.duration_seconds)}</small>
          ${call.ai_summary ? `<p class="cc-call-summary">${escapeHtml(call.ai_summary.slice(0, 220))}${call.ai_summary.length > 220 ? '…' : ''}</p>` : ''}
        </div>
        <div class="cc-call-actions">
          ${call.recording_url ? `<a class="cc-btn-mini" href="${escapeHtml(call.recording_url)}" target="_blank" rel="noopener"><i class="fas fa-play"></i> Recording</a>` : ''}
          <button type="button" class="cc-btn-mini cc-detail-btn" data-session-id="${escapeHtml(call.id)}"><i class="fas fa-eye"></i> Details</button>
        </div>
      </article>
    `).join('');

    el.querySelectorAll('.cc-detail-btn').forEach((btn) => {
      btn.addEventListener('click', () => openDetails(btn.dataset.sessionId));
    });
  }

  // ---------- Call detail panel ----------
  function openDetails(sessionId) {
    state.selectedSessionId = sessionId;
    const call = state.recentCalls.find((c) => c.id === sessionId);
    const panel = byId('ccDetailPanel');
    if (!panel) return;
    const prepPanel = byId('ccPrepPanel');
    if (prepPanel) {
      prepPanel.innerHTML = '<div class="cc-empty">Call Prep is reserved for selected leads. Click a lead in Today\'s Call Queue to load a rotating opener and live coaching tips.</div>';
    }
    if (!call) { panel.innerHTML = '<div class="cc-empty">Call not found.</div>'; return; }
    panel.innerHTML = `
      <h3>Call Detail</h3>
      <p><strong>To:</strong> ${escapeHtml(formatPhone(call.to_number))}<br/>
         <strong>From:</strong> ${escapeHtml(formatPhone(call.from_number))}<br/>
         <strong>Agent:</strong> ${escapeHtml(recentCallAgentLabel(call))}<br/>
         <strong>When:</strong> ${formatWhen(call.created_at)}<br/>
         <strong>Duration:</strong> ${formatDuration(call.duration_seconds)}<br/>
         <strong>Status:</strong> ${statusBadge(call)} ${dispositionBadge(call)}</p>
      ${call.recording_url ? `<audio controls src="${escapeHtml(call.recording_url)}" style="width:100%;margin:8px 0;"></audio>` : ''}
      ${call.ai_summary ? `<div class="cc-detail-section"><strong>AI Summary</strong><p>${escapeHtml(call.ai_summary)}</p></div>` : ''}
      ${call.ai_transcript ? `<details class="cc-detail-section"><summary><strong>Full transcript</strong></summary><pre class="cc-transcript">${escapeHtml(call.ai_transcript)}</pre></details>` : ''}
      <div class="cc-detail-section">
        <strong>Disposition</strong>
        <div class="cc-dispo-row">
          ${['booked','callback','not_interested','voicemail','no_answer'].map((d) => `
            <button type="button" class="cc-dispo-btn ${call.disposition === d ? 'active' : ''}" data-dispo="${d}">${d.replace('_',' ')}</button>
          `).join('')}
        </div>
        <textarea id="ccDispoNotes" placeholder="Notes about this call…" rows="3">${escapeHtml(call.disposition_notes || '')}</textarea>
        <button type="button" class="btn-primary" id="ccSaveDispo"><i class="fas fa-save"></i> Save</button>
      </div>
    `;

    let pendingDispo = call.disposition || '';
    panel.querySelectorAll('.cc-dispo-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingDispo = btn.dataset.dispo;
        panel.querySelectorAll('.cc-dispo-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
    byId('ccSaveDispo')?.addEventListener('click', async () => {
      const notes = byId('ccDispoNotes')?.value || '';
      await saveDisposition(sessionId, pendingDispo, notes);
    });
  }

  async function saveDisposition(sessionId, disposition, notes, fallbackInfo = null, metricOverrides = null) {
    const supa = sb();
    if (!supa) return;
    setStatus('Saving disposition…', 'info');
    try {
      let resolvedSessionId = sanitizeUuid(sessionId);
      const nowIso = new Date().toISOString();

      if (resolvedSessionId) {
        const { error } = await supa.from('call_sessions').update({
          disposition,
          disposition_at: nowIso,
          disposition_notes: notes,
          ...(typeof metricOverrides?.answered === 'boolean' ? { answered: metricOverrides.answered } : {})
        }).eq('id', resolvedSessionId);
        if (error) throw error;
      } else if (fallbackInfo) {
        resolvedSessionId = await ensureFallbackCallSession(fallbackInfo, disposition, notes, metricOverrides);
      }

      let syncedCallId = resolvedSessionId
        ? await syncCallSessionToCallLog(resolvedSessionId, disposition, notes, fallbackInfo, metricOverrides)
        : await syncFallbackCallToCallLog(fallbackInfo, disposition, notes, metricOverrides);

      const refreshedSession = resolvedSessionId ? await fetchCallSessionById(resolvedSessionId) : null;
      const refreshedLeadId = sanitizeUuid(refreshedSession?.lead_id)
        || sanitizeUuid(fallbackInfo?.leadId)
        || await resolveLeadIdForCall(refreshedSession, fallbackInfo);

      if (!syncedCallId && refreshedLeadId) {
        syncedCallId = await syncFallbackCallToCallLog({ ...(fallbackInfo || {}), leadId: refreshedLeadId }, disposition, notes, metricOverrides);
      }
      if (refreshedLeadId) {
        window.dispatchEvent(new CustomEvent('crm-call-log-updated', {
          detail: {
            leadId: refreshedLeadId,
            sessionId: resolvedSessionId || null,
            callId: syncedCallId || null
          }
        }));
      }

      setStatus('Disposition saved.', 'success');
      await loadRecentCalls();
      if (resolvedSessionId) openDetails(resolvedSessionId);
    } catch (err) {
      setStatus(`Could not save disposition: ${err.message}`, 'error');
      throw err;
    }
  }

  // ---------- Manual dial pad (fallback for non-lead calls) ----------
  function bindManualDial() {
    const input = byId('ccManualNumber');
    const btn = byId('ccManualCallBtn');
    if (!input || !btn) return;
    btn.addEventListener('click', () => {
      const num = input.value.trim();
      if (!num) { setStatus('Enter a number to dial.', 'warn'); return; }
      initiateCall(null, num, 'Manual dial');
    });
    document.querySelectorAll('.cc-keypad-btn').forEach((k) => {
      k.addEventListener('click', () => {
        input.value = (input.value || '') + (k.dataset.digit || k.textContent.trim());
      });
    });
  }

  // ---------- Init + polling ----------
  function startPolling() {
    if (state.pollingTimer) clearInterval(state.pollingTimer);
    state.pollingTimer = setInterval(() => {
      if (document.querySelector('.nav-item.active')?.dataset.view === 'dialer') {
        Promise.allSettled([loadCallQueue(), loadRecentCalls()]);
      }
    }, POLL_MS);
  }

  async function init() {
    if (state.loaded || state.loading) return;
    state.loading = true;
    try {
      await Promise.all([loadCallQueue(), loadRecentCalls()]);
      bindManualDial();
      bindPostCallModal();
      byId('ccRefreshBtn')?.addEventListener('click', async () => {
        await Promise.all([loadCallQueue(), loadRecentCalls()]);
        if (state.selectedLeadId) {
          selectQueueLead(state.selectedLeadId);
        }
      });
      startPolling();
      state.loaded = true;
    } catch (err) {
      console.error('[call-command] init:', err);
    } finally {
      state.loading = false;
    }
  }

  window.loadDialerViewData = async function (opts = {}) {
    if (opts.force) state.loaded = false;
    await init();
  };

  // Public entry point for the Leads tab to trigger a Quo call directly.
  // Called from dashboard.js -> callLeadFromLeads().
  window.callCommandInitiateCall = async function (leadId, phone, name) {
    // Make sure dialer is loaded first
    if (!state.loaded) await init();
    return initiateCall(leadId, phone, name);
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.nav-item.active')?.dataset.view === 'dialer') init();
  });
})();
