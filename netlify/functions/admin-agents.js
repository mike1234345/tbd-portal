/* build:1780028952622 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JSON_HEADERS = {
  'Content-Type': 'application/json'
};

function response(statusCode, payload) {
  return {
    statusCode,
    headers: {
      ...JSON_HEADERS,
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(payload)
  };
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

function defaultDisplayName(email = '') {
  const local = cleanEmail(email).split('@')[0] || 'Agent';
  return local.slice(0, 1).toUpperCase() + local.slice(1);
}

function normalizeRole(role = '') {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'super_admin') return 'super_admin';
  if (value === 'admin') return 'admin';
  return 'agent';
}

function rolePriority(role = '') {
  if (role === 'super_admin') return 0;
  if (role === 'admin') return 1;
  return 2;
}

// v3.5.4: Accept any team label string (or null for Unassigned).
// Trimmed to 60 chars to keep DB rows tidy. Empty/whitespace becomes null.
function cleanTeamLabel(teamLabel = '') {
  const value = String(teamLabel == null ? '' : teamLabel).trim();
  if (!value) return null;
  if (value.toLowerCase() === 'unassigned' || value === '—') return null;
  return value.slice(0, 60);
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...JSON_HEADERS,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const err = await readJson(res);
    const message = err.error_description || err.msg || err.message || err.error || `Supabase request failed (${res.status})`;
    throw new Error(message);
  }

  return readJson(res);
}

async function verifyRequester(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok) {
    const err = await readJson(res);
    const message = err.error_description || err.msg || err.message || 'Invalid session.';
    throw new Error(message);
  }

  return readJson(res);
}

async function getRoleRow(userId) {
  const rows = await supabaseFetch(`/rest/v1/crm_user_roles?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function requirePrivileged(accessToken) {
  const requester = await verifyRequester(accessToken);
  const roleRow = await getRoleRow(requester.id);
  if (!roleRow || roleRow.role !== 'super_admin') {
    throw Object.assign(new Error('Super admin access required.'), { statusCode: 403 });
  }
  return { requester, roleRow };
}

async function listAuthUsers() {
  const perPage = 1000;
  let page = 1;
  const users = [];

  while (true) {
    const result = await supabaseFetch(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
    const batch = Array.isArray(result?.users) ? result.users : [];
    users.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
    if (page > 20) break;
  }

  return users;
}

async function listRoleRows() {
  const rows = await supabaseFetch('/rest/v1/crm_user_roles?select=*&order=created_at.desc');
  return Array.isArray(rows) ? rows : [];
}

async function upsertRoleRow({ user_id, role, display_name, email }) {
  const normalizedRole = normalizeRole(role);
  const payload = [{
    user_id,
    role: normalizedRole,
    display_name: display_name || defaultDisplayName(email),
    email: cleanEmail(email)
  }];

  const rows = await supabaseFetch('/rest/v1/crm_user_roles', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: payload
  });

  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function deleteRoleRow(userId) {
  await supabaseFetch(`/rest/v1/crm_user_roles?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: {
      Prefer: 'return=minimal'
    }
  });
}

async function handleList() {
  const [users, roles] = await Promise.all([listAuthUsers(), listRoleRows()]);
  const byId = new Map();

  users.forEach(user => {
    byId.set(user.id, {
      id: user.id,
      email: cleanEmail(user.email || ''),
      display_name: user.user_metadata?.display_name || defaultDisplayName(user.email),
      role: 'agent',
      created_at: user.created_at || null,
      last_sign_in_at: user.last_sign_in_at || null,
      team_label: null
    });
  });

  roles.forEach(roleRow => {
    const existing = byId.get(roleRow.user_id) || {
      id: roleRow.user_id,
      email: cleanEmail(roleRow.email || ''),
      display_name: roleRow.display_name || defaultDisplayName(roleRow.email),
      role: 'agent',
      created_at: roleRow.created_at || null,
      last_sign_in_at: null
    };
    existing.role = normalizeRole(roleRow.role || existing.role || 'agent');
    existing.display_name = roleRow.display_name || existing.display_name;
    existing.email = cleanEmail(roleRow.email || existing.email || '');
    existing.created_at = existing.created_at || roleRow.created_at || null;
    existing.team_label = cleanTeamLabel(roleRow.team_label);
    byId.set(roleRow.user_id, existing);
  });

  const agents = [...byId.values()].sort((a, b) => {
    const roleDiff = rolePriority(a.role) - rolePriority(b.role);
    if (roleDiff !== 0) return roleDiff;
    const aTime = new Date(a.created_at || 0).getTime();
    const bTime = new Date(b.created_at || 0).getTime();
    return bTime - aTime || String(a.email || '').localeCompare(String(b.email || ''));
  });

  return response(200, { agents });
}

async function handleCreate(body) {
  const email = cleanEmail(body.email);
  const password = String(body.password || '');
  const role = normalizeRole(body.role);
  const displayName = String(body.display_name || '').trim() || defaultDisplayName(email);

  if (!email) return response(400, { error: 'Email is required.' });
  if (password.length < 8) return response(400, { error: 'Password must be at least 8 characters.' });
  if (role === 'super_admin') return response(403, { error: 'Super admin accounts must be assigned directly in SQL for safety.' });

  const created = await supabaseFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName }
    }
  });

  const user = created.user || created;
  if (!user?.id) throw new Error('User was created but no user id was returned.');

  const roleRow = await upsertRoleRow({
    user_id: user.id,
    role,
    display_name: displayName,
    email
  });

  return response(200, {
    ok: true,
    agent: {
      id: user.id,
      email,
      display_name: roleRow?.display_name || displayName,
      role: roleRow?.role || role,
      created_at: user.created_at || roleRow?.created_at || null,
      last_sign_in_at: user.last_sign_in_at || null
    }
  });
}

async function handleSetRole(body) {
  const userId = String(body.user_id || '').trim();
  const requestedRole = normalizeRole(body.role);
  const email = cleanEmail(body.email || '');
  const displayName = String(body.display_name || '').trim() || defaultDisplayName(email);

  if (!userId) return response(400, { error: 'user_id is required.' });
  if (requestedRole === 'super_admin') return response(403, { error: 'Super admin role changes must be handled directly in SQL for safety.' });

  const existingRole = await getRoleRow(userId);
  if (existingRole?.role === 'super_admin') {
    return response(403, { error: 'The super admin account cannot be downgraded from the dashboard.' });
  }

  const roleRow = await upsertRoleRow({ user_id: userId, role: requestedRole, display_name: displayName, email });
  return response(200, { ok: true, role: roleRow?.role || requestedRole });
}

async function handleResetPassword(body) {
  const userId = String(body.user_id || '').trim();
  const password = String(body.password || '');

  if (!userId) return response(400, { error: 'user_id is required.' });
  if (password.length < 8) return response(400, { error: 'Password must be at least 8 characters.' });

  await supabaseFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: { password }
  });

  return response(200, { ok: true });
}

// v3.5.4: Assign or change an agent's team_label
async function handleSetTeam(body) {
  const userId = String(body.user_id || '').trim();
  if (!userId) return response(400, { error: 'user_id is required.' });
  const teamLabel = cleanTeamLabel(body.team_label);
  const email = cleanEmail(body.email || '');
  const displayName = String(body.display_name || '').trim() || defaultDisplayName(email);

  // Make sure the role row exists (use existing role or 'agent' as default)
  const existing = await getRoleRow(userId);
  if (existing?.role === 'super_admin') {
    // Allow team assignment for super_admin too — it's just a label
  }
  const role = existing?.role || normalizeRole(body.role || 'agent');

  // Upsert with team_label (PostgREST will respect the column)
  const payload = [{
    user_id: userId,
    role,
    display_name: displayName || existing?.display_name || defaultDisplayName(email),
    email: email || existing?.email || '',
    team_label: teamLabel
  }];
  const rows = await supabaseFetch('/rest/v1/crm_user_roles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: payload
  });
  const updated = Array.isArray(rows) ? rows[0] : rows;
  return response(200, { ok: true, team_label: updated?.team_label || teamLabel || null, user_id: userId });
}

async function handleRemove(body, requester) {
  const userId = String(body.user_id || '').trim();
  if (!userId) return response(400, { error: 'user_id is required.' });
  if (userId === requester.id) return response(400, { error: 'You cannot remove your own account from inside the dashboard.' });

  const existingRole = await getRoleRow(userId);
  if (existingRole?.role === 'super_admin') {
    return response(403, { error: 'The super admin account cannot be removed from the dashboard.' });
  }

  await deleteRoleRow(userId);
  await supabaseFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE'
  });

  return response(200, { ok: true });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return response(200, { ok: true });
  }

  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return response(500, { error: 'Missing Netlify environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.' });
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!accessToken) return response(401, { error: 'Missing bearer token.' });

    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || '').trim();
    const { requester } = await requirePrivileged(accessToken);

    if (action === 'list') return await handleList();
    if (action === 'create') return await handleCreate(body);
    if (action === 'set-role') return await handleSetRole(body);
    if (action === 'reset-password') return await handleResetPassword(body);
    if (action === 'remove-agent' || action === 'delete') return await handleRemove(body, requester);
    if (action === 'set-team') return await handleSetTeam(body);

    return response(400, { error: 'Unknown action.' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return response(statusCode, { error: error.message || 'Admin agent action failed.' });
  }
};
