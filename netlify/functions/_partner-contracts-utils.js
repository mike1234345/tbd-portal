/* build:1780028952622 */
const crypto = require('node:crypto');
const { getSupabase } = require('./_quo-utils');

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

function response(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  };
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

async function readJsonBody(event) {
  if (!event?.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function cleanEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

function cleanText(value = '') {
  return String(value || '').trim();
}

function parseBearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  if (!raw || !/^Bearer\s+/i.test(raw)) return '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

async function verifyRequester(accessToken) {
  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) throw new Error('Missing Supabase environment variables.');
  if (!accessToken) throw Object.assign(new Error('Missing Authorization bearer token.'), { statusCode: 401 });

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!res.ok) {
    const err = await readJson(res);
    throw Object.assign(new Error(err.error_description || err.message || 'Invalid session.'), { statusCode: 401 });
  }
  return readJson(res);
}

async function getRoleRow(userId) {
  const sb = getRequiredSupabase();
  const { data, error } = await sb
    .from('crm_user_roles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function isPrivilegedRole(role = '') {
  return ['admin', 'super_admin'].includes(String(role || '').trim().toLowerCase());
}

async function requireAdminSession(event) {
  const accessToken = parseBearerToken(event.headers || {});
  const requester = await verifyRequester(accessToken);
  const roleRow = await getRoleRow(requester.id);
  if (!roleRow || !isPrivilegedRole(roleRow.role)) {
    throw Object.assign(new Error('Admin access required.'), { statusCode: 403 });
  }
  return { requester, roleRow, accessToken };
}

function getRequiredSupabase() {
  const sb = getSupabase();
  if (!sb) throw new Error('Missing Supabase environment variables.');
  return sb;
}

function randomToken(size = 24) {
  return crypto.randomBytes(size).toString('base64url');
}

function uniqueSlug(prefix = 'pc') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requireField(value, fieldName) {
  if (value == null || String(value).trim() === '') {
    throw Object.assign(new Error(`${fieldName} is required.`), { statusCode: 400 });
  }
  return value;
}

async function fetchPartnerProfile(sb, partnerProfileId) {
  const { data, error } = await sb
    .from('crm_partner_profiles')
    .select('*')
    .eq('id', partnerProfileId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function assertPartnerScope(sb, session, partnerProfileId) {
  const profile = await fetchPartnerProfile(sb, partnerProfileId);
  if (!profile) throw Object.assign(new Error('Partner profile not found.'), { statusCode: 404 });
  const isSuper = session.roleRow.role === 'super_admin';
  if (!isSuper && profile.admin_user_id !== session.requester.id) {
    throw Object.assign(new Error('That partner is outside your access scope.'), { statusCode: 403 });
  }
  return profile;
}

async function loadOwnedRequest(sb, session, requestId) {
  const { data, error } = await sb
    .from('crm_contract_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Contract request not found.'), { statusCode: 404 });
  if (session.roleRow.role !== 'super_admin' && data.owner_admin_id !== session.requester.id) {
    throw Object.assign(new Error('That request is outside your access scope.'), { statusCode: 403 });
  }
  return data;
}

async function loadOwnedTemplate(sb, session, templateId) {
  const { data, error } = await sb
    .from('crm_contract_templates')
    .select('*')
    .eq('id', templateId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Contract template not found.'), { statusCode: 404 });
  if (session.roleRow.role !== 'super_admin' && data.owner_admin_id !== session.requester.id) {
    throw Object.assign(new Error('That template is outside your access scope.'), { statusCode: 403 });
  }
  return data;
}

async function insertContractEvent(sb, payload = {}) {
  const row = {
    owner_admin_id: payload.owner_admin_id,
    request_id: payload.request_id || null,
    signer_id: payload.signer_id || null,
    template_id: payload.template_id || null,
    event_type: payload.event_type,
    actor_user_id: payload.actor_user_id || null,
    actor_type: payload.actor_type || 'user',
    event_data: payload.event_data || {}
  };
  const { error } = await sb.from('crm_contract_events').insert(row);
  if (error) throw error;
}

module.exports = {
  response,
  corsHeaders,
  readJsonBody,
  cleanEmail,
  cleanText,
  parseBearerToken,
  verifyRequester,
  getRoleRow,
  requireAdminSession,
  getRequiredSupabase,
  randomToken,
  uniqueSlug,
  nowIso,
  asArray,
  requireField,
  fetchPartnerProfile,
  assertPartnerScope,
  loadOwnedRequest,
  loadOwnedTemplate,
  insertContractEvent
};
