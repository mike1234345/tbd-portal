(function () {
  const state = {
    loaded: false,
    loading: false,
    partnerProfiles: [],
    signedClients: [],
    crmLeads: [],
    callAttempts: [],
    financialRows: [],
    dealItems: [],
    transactions: [],
    selectedClientId: null,
    editingClientId: null,
    editingDealItemId: null,
    editingTransactionId: null
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function escape(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function canUseSignedClients() {
    return typeof window.isAdmin === 'function' && window.isAdmin();
  }

  function isSuper() {
    return typeof window.isSuperAdmin === 'function' && window.isSuperAdmin();
  }

  function signedStatus(message, type = '') {
    const el = byId('signedClientsStatus');
    if (!el) return;
    if (!message) {
      el.className = 'agent-admin-status hidden';
      el.innerHTML = '';
      return;
    }
    el.className = 'agent-admin-status' + (type ? ' ' + type : '');
    el.innerHTML = message;
  }

  function safeMoney(value) {
    if (typeof window.formatMoney === 'function') return window.formatMoney(value);
    return `$${Number(value || 0).toFixed(2)}`;
  }

  function prettyLabel(value) {
    return String(value || '—').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function statusClass(value) {
    return 'status-' + String(value || 'new').replace(/[^a-z0-9]+/gi, '');
  }

  function getRoleLabelSafe(role) {
    if (typeof window.getRoleLabel === 'function') return window.getRoleLabel(role);
    return prettyLabel(role || 'agent');
  }

  function getAgentDisplayNameSafe(userId) {
    if (typeof window.getAgentDisplayName === 'function') return window.getAgentDisplayName(userId);
    return userId ? `User ${String(userId).slice(0, 8)}` : '—';
  }

  function normalizePhone(value = '') {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  function formatCallMoment(value) {
    if (!value) return '—';
    try {
      if (typeof window.formatDateTime === 'function') return window.formatDateTime(value);
      if (typeof window.formatDate === 'function') return window.formatDate(value);
      return new Date(value).toLocaleString();
    } catch (_) {
      return String(value || '—');
    }
  }

  async function loadCallAttemptsForLeadIds(leadIds = []) {
    const uniqueLeadIds = [...new Set((leadIds || []).filter(Boolean))];
    if (!uniqueLeadIds.length) return [];
    const rows = [];
    const chunkSize = 200;
    for (let index = 0; index < uniqueLeadIds.length; index += chunkSize) {
      const chunk = uniqueLeadIds.slice(index, index + chunkSize);
      const { data, error } = await window.sb
        .from('crm_call_attempts')
        .select('*')
        .in('lead_id', chunk)
        .order('created_at', { ascending: false });
      if (error) throw error;
      rows.push(...(data || []));
    }
    return rows.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }

  function financialMap() {
    return new Map((state.financialRows || []).map((row) => [row.signed_client_id, row]));
  }

  function partnerProfileById(id) {
    return (state.partnerProfiles || []).find((row) => row.id === id) || null;
  }

  function partnerProfileByAdminId(adminId) {
    return (state.partnerProfiles || []).find((row) => row.admin_user_id === adminId) || null;
  }

  function partnerNameForAdmin(ownerAdminId) {
    const profile = partnerProfileByAdminId(ownerAdminId);
    if (profile?.display_name) return profile.display_name;
    return getAgentDisplayNameSafe(ownerAdminId) || 'Partner';
  }

  const COMPANY_CAM_START = '[[COMPANYCAM_PROJECT]]';
  const COMPANY_CAM_END = '[[/COMPANYCAM_PROJECT]]';

  function parseCompanyCamMeta(notesValue = '') {
    const raw = String(notesValue || '');
    const regex = /\[\[COMPANYCAM_PROJECT\]\]\s*([\s\S]*?)\s*\[\[\/COMPANYCAM_PROJECT\]\]/i;
    const match = raw.match(regex);
    if (!match) return { cleanNotes: raw.trim(), projectName: '', projectUrl: '', projects: [] };
    const body = String(match[1] || '').trim();
    const lines = body.split(/\r?\n/).map((line) => String(line || '').trim()).filter(Boolean);
    const projects = lines.map((line) => {
      const parts = line.split('|');
      const projectName = String(parts.shift() || '').trim();
      const projectUrl = normalizeCompanyCamUrl(parts.join('|'));
      if (!projectName || !projectUrl) return null;
      return { projectName, projectUrl };
    }).filter(Boolean);
    if (!projects.length && body) {
      const parts = body.split('|');
      const projectName = String(parts.shift() || '').trim();
      const projectUrl = normalizeCompanyCamUrl(parts.join('|'));
      if (projectName && projectUrl) projects.push({ projectName, projectUrl });
    }
    const cleanNotes = raw.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
    const firstProject = projects[0] || { projectName: '', projectUrl: '' };
    return { cleanNotes, projectName: firstProject.projectName, projectUrl: firstProject.projectUrl, projects };
  }

  function normalizeCompanyCamUrl(value = '') {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw.replace(/^\/+/, '')}`;
    try {
      const parsed = new URL(raw);
      if (!/^https?:$/i.test(parsed.protocol)) return '';
      return parsed.toString();
    } catch (_) {
      return '';
    }
  }

  function normalizeCompanyCamProjects(projects = []) {
    const seen = new Set();
    return (Array.isArray(projects) ? projects : []).map((project) => {
      const projectName = String(project?.projectName || '').trim();
      const projectUrl = normalizeCompanyCamUrl(project?.projectUrl || '');
      if (!projectName || !projectUrl) return null;
      const key = projectUrl.toLowerCase();
      if (seen.has(key)) return null;
      seen.add(key);
      return { projectName, projectUrl };
    }).filter(Boolean);
  }

  function composeNotesWithCompanyCam(notesValue = '', projects = []) {
    const cleanNotes = String(notesValue || '').trim();
    const cleanProjects = normalizeCompanyCamProjects(projects);
    const parts = [];
    if (cleanNotes) parts.push(cleanNotes);
    if (cleanProjects.length) {
      const body = cleanProjects.map((project) => `${project.projectName} | ${project.projectUrl}`).join('\n');
      parts.push(`${COMPANY_CAM_START}\n${body}\n${COMPANY_CAM_END}`);
    }
    return parts.join('\n\n') || null;
  }

  async function saveCompanyCamForSelectedClient(clientId = state.selectedClientId) {
    try {
      const row = (state.signedClients || []).find((item) => item.id === clientId) || null;
      if (!row) throw new Error('Select a signed client first.');
      const nameInput = byId('signedClientsCompanyCamName');
      const urlInput = byId('signedClientsCompanyCamUrl');
      const projectName = nameInput?.value.trim() || '';
      const projectUrlRaw = urlInput?.value.trim() || '';
      if ((projectName && !projectUrlRaw) || (!projectName && projectUrlRaw)) {
        throw new Error('Enter both a CompanyCam project name and URL.');
      }
      if (!projectName && !projectUrlRaw) {
        throw new Error('Enter a CompanyCam project name and URL first.');
      }
      const normalizedUrl = normalizeCompanyCamUrl(projectUrlRaw);
      if (projectUrlRaw && !normalizedUrl) throw new Error('Enter a valid CompanyCam URL.');
      const parsed = parseCompanyCamMeta(row.notes_private || '');
      const nextProjects = [...(parsed.projects || [])];
      const existingIndex = nextProjects.findIndex((project) => normalizeCompanyCamUrl(project.projectUrl || '') === normalizedUrl);
      if (existingIndex >= 0) nextProjects[existingIndex] = { projectName, projectUrl: normalizedUrl };
      else nextProjects.push({ projectName, projectUrl: normalizedUrl });
      const mergedNotes = composeNotesWithCompanyCam(parsed.cleanNotes, nextProjects);
      signedStatus(existingIndex >= 0 ? 'Updating CompanyCam project…' : 'Saving CompanyCam project…');
      const result = await window.sb.from('crm_signed_clients').update({ notes_private: mergedNotes }).eq('id', row.id).select('*').single();
      if (result.error) throw result.error;
      state.signedClients = (state.signedClients || []).map((item) => item.id === row.id ? { ...item, ...(result.data || {}), notes_private: mergedNotes } : item);
      renderSignedClientsTable();
      selectSignedClient(row.id, true);
      signedStatus(existingIndex >= 0 ? 'CompanyCam project updated successfully.' : 'CompanyCam project saved successfully.', 'success');
    } catch (error) {
      signedStatus('Could not save CompanyCam project: ' + escape(error.message || 'Unknown error'), 'error');
    }
  }

  async function removeCompanyCamProjectForSelectedClient(projectIndex, clientId = state.selectedClientId) {
    try {
      const row = (state.signedClients || []).find((item) => item.id === clientId) || null;
      if (!row) throw new Error('Select a signed client first.');
      const parsed = parseCompanyCamMeta(row.notes_private || '');
      const index = Number(projectIndex);
      if (!Number.isInteger(index) || index < 0 || index >= (parsed.projects || []).length) throw new Error('Project not found.');
      const nextProjects = (parsed.projects || []).filter((_, currentIndex) => currentIndex !== index);
      const mergedNotes = composeNotesWithCompanyCam(parsed.cleanNotes, nextProjects);
      signedStatus('Removing CompanyCam project…');
      const result = await window.sb.from('crm_signed_clients').update({ notes_private: mergedNotes }).eq('id', row.id).select('*').single();
      if (result.error) throw result.error;
      state.signedClients = (state.signedClients || []).map((item) => item.id === row.id ? { ...item, ...(result.data || {}), notes_private: mergedNotes } : item);
      renderSignedClientsTable();
      selectSignedClient(row.id, true);
      signedStatus('CompanyCam project removed.', 'success');
    } catch (error) {
      signedStatus('Could not remove CompanyCam project: ' + escape(error.message || 'Unknown error'), 'error');
    }
  }

  function visiblePartnerProfiles() {
    if (isSuper()) return [...(state.partnerProfiles || [])];
    return (state.partnerProfiles || []).filter((profile) => profile.admin_user_id === window.currentUser?.id || profile.user_id === window.currentUser?.id || profile.admin_user_id === (window.currentUser && window.currentUser.id));
  }

  function ownerAdminDirectory() {
    const byAdminId = new Map();

    (state.partnerProfiles || []).forEach((profile) => {
      if (!profile?.admin_user_id) return;
      byAdminId.set(profile.admin_user_id, {
        admin_user_id: profile.admin_user_id,
        display_name: profile.display_name || getAgentDisplayNameSafe(profile.admin_user_id),
        role: 'admin',
        partner_profile_id: profile.id || null,
        has_profile: true
      });
    });

    const roleRows = Array.isArray(window.roleDirectory) ? window.roleDirectory : [];
    roleRows.forEach((row) => {
      if (!row?.user_id) return;
      if (!['admin', 'super_admin'].includes(String(row.role || ''))) return;
      const existing = byAdminId.get(row.user_id) || {
        admin_user_id: row.user_id,
        display_name: '',
        role: row.role || 'admin',
        partner_profile_id: null,
        has_profile: false
      };
      existing.display_name = existing.display_name || row.display_name || row.email?.split('@')[0] || getAgentDisplayNameSafe(row.user_id);
      existing.role = row.role || existing.role || 'admin';
      byAdminId.set(row.user_id, existing);
    });

    const rows = [...byAdminId.values()].sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
    if (isSuper()) return rows;
    return rows.filter((row) => row.admin_user_id === window.currentUser?.id);
  }

  function scopedOwnerAdminId() {
    const select = byId('signedClientsPartnerFilter');
    const checkbox = byId('signedClientsSelectedOnly');
    if (!select || !checkbox) return '';
    return checkbox.checked ? String(select.value || '') : '';
  }

  function relatedDealItemsForClient(row) {
    const profile = partnerProfileByAdminId(row.owner_admin_id);
    return (state.dealItems || []).filter((item) => item.signed_client_id === row.id || (profile && item.partner_profile_id === profile.id && !item.signed_client_id));
  }

  function relatedTransactionsForClient(row) {
    const profile = partnerProfileByAdminId(row.owner_admin_id);
    return (state.transactions || []).filter((tx) => tx.signed_client_id === row.id || (profile && tx.partner_profile_id === profile.id && !tx.signed_client_id));
  }

  function relatedLeadIdsForClient(row) {
    const ids = new Set();
    if (!row) return ids;
    if (row.lead_id) ids.add(String(row.lead_id));
    const phoneKey = normalizePhone(row.phone || '');
    const emailKey = String(row.email || '').trim().toLowerCase();
    (state.crmLeads || []).forEach((lead) => {
      if (!lead?.id) return;
      const samePhone = phoneKey && normalizePhone(lead.phone || '') === phoneKey;
      const sameEmail = emailKey && String(lead.email || '').trim().toLowerCase() === emailKey;
      if (samePhone || sameEmail) ids.add(String(lead.id));
    });
    return ids;
  }

  function stripCallSessionMeta(notesValue = '') {
    return String(notesValue || '')
      .replace(/\s*\[\[CALL_SESSION:[0-9a-f-]{36}\]\]\s*/ig, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function relatedCallsForClient(row) {
    const leadIds = relatedLeadIdsForClient(row);
    if (!leadIds.size) return [];
    return (state.callAttempts || []).filter((call) => leadIds.has(String(call.lead_id || '')));
  }

  function renderClientCallHistory(calls = []) {
    if (!calls.length) {
      return '<div style="color:rgba(255,255,255,0.65);font-size:0.9rem;">No call log entries linked to this client yet.</div>';
    }
    return `<div style="display:grid;gap:10px;max-height:360px;overflow:auto;padding-right:4px;">${calls.map((call) => {
      const flags = [
        call.answered ? 'Answered' : 'No Answer',
        call.allowed_presentation ? 'Presented' : '',
        call.appointment_booked ? 'Booked' : '',
        call.duration_seconds ? `${call.duration_seconds}s` : ''
      ].filter(Boolean);
      return `
        <button type="button" data-signed-call-id="${escape(call.id)}" style="text-align:left;padding:12px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.03);display:grid;gap:8px;width:100%;cursor:pointer;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <strong style="font-size:0.92rem;">${escape(formatCallMoment(call.created_at))}</strong>
            <span class="status-pill ${statusClass(call.call_outcome || 'logged')}">${escape(prettyLabel(call.call_outcome || 'Logged'))}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${flags.map((flag) => `<span class="storm-chip">${escape(flag)}</span>`).join('')}
            <span class="storm-chip">${escape(getAgentDisplayNameSafe(call.agent_id))}</span>
            <span class="storm-chip">View Details</span>
          </div>
          ${stripCallSessionMeta(call.notes) ? `<div style="font-size:0.92rem;line-height:1.5;color:var(--text);white-space:pre-wrap;word-break:break-word;">${escape(stripCallSessionMeta(call.notes))}</div>` : '<div style="color:rgba(255,255,255,0.55);font-size:0.88rem;">No notes saved.</div>'}
        </button>`;
    }).join('')}</div>`;
  }

  function zeroFinancialSummary() {
    return {
      incoming_expected: 0,
      incoming_received: 0,
      outgoing_expected: 0,
      outgoing_paid: 0,
      net_expected: 0,
      net_actual: 0,
      outstanding_receivable: 0,
      outstanding_payable: 0,
      financial_status: 'no_items',
      active_item_count: 0,
      hasData: false
    };
  }

  function expectedAmountForDealItem(item) {
    if (item?.expected_amount != null && item.expected_amount !== '') return Number(item.expected_amount || 0);
    const calculationType = String(item?.calculation_type || '');
    if (['percent_profit', 'percent_revenue'].includes(calculationType)) return 0;
    return Number(item?.flat_amount || 0) * Number(item?.quantity || 1);
  }

  function financialStatusFromTotals(totals) {
    const incomingExpected = Number(totals.incoming_expected || 0);
    const incomingReceived = Number(totals.incoming_received || 0);
    const outgoingExpected = Number(totals.outgoing_expected || 0);
    const outgoingPaid = Number(totals.outgoing_paid || 0);
    const activeItemCount = Number(totals.active_item_count || 0);
    const outstandingReceivable = Math.max(incomingExpected - incomingReceived, 0);
    const outstandingPayable = Math.max(outgoingExpected - outgoingPaid, 0);

    if (!activeItemCount) return 'no_items';
    if (outstandingReceivable === 0 && outstandingPayable === 0) return 'settled';
    if ((incomingExpected > 0 && incomingReceived === 0 && outgoingExpected === 0)
      || (outgoingExpected > 0 && outgoingPaid === 0 && incomingExpected === 0)
      || ((incomingExpected + outgoingExpected) > 0 && (incomingReceived + outgoingPaid) === 0)) return 'due';
    if ((incomingExpected > 0 && incomingReceived > 0 && incomingReceived < incomingExpected)
      || (outgoingExpected > 0 && outgoingPaid > 0 && outgoingPaid < outgoingExpected)) return 'partial';
    if (incomingExpected > 0 && outgoingExpected > 0) return 'mixed';
    return 'due';
  }

  function currentScopePartnerProfiles() {
    const ownerFilter = scopedOwnerAdminId();
    const profiles = isSuper() ? [...(state.partnerProfiles || [])] : visiblePartnerProfiles();
    if (ownerFilter) return profiles.filter((profile) => profile.admin_user_id === ownerFilter);
    return profiles;
  }

  function currentScopePartnerLevelFinancials() {
    const ownerFilter = scopedOwnerAdminId();
    const search = String(byId('signedClientsSearch')?.value || '').trim().toLowerCase();
    const financialStatus = String(byId('signedClientsFinancialStatusFilter')?.value || '');
    const direction = String(byId('signedClientsDirectionFilter')?.value || '');
    const paymentMethod = String(byId('signedClientsPaymentMethodFilter')?.value || '');
    const scopeProfiles = currentScopePartnerProfiles();
    const profileIds = new Set(scopeProfiles.map((profile) => profile.id).filter(Boolean));
    const ownerIds = new Set(scopeProfiles.map((profile) => profile.admin_user_id).filter(Boolean));
    if (ownerFilter) ownerIds.add(ownerFilter);
    if (!ownerFilter && !isSuper() && window.currentUser?.id) ownerIds.add(window.currentUser.id);

    const itemInScope = (item) => {
      if (!item || item.signed_client_id) return false;
      if (profileIds.size && item.partner_profile_id && profileIds.has(item.partner_profile_id)) return true;
      if (ownerIds.size && item.owner_admin_id && ownerIds.has(item.owner_admin_id)) return true;
      return !ownerFilter && isSuper() && !profileIds.size;
    };

    const txInScope = (tx) => {
      if (!tx || tx.signed_client_id) return false;
      if (profileIds.size && tx.partner_profile_id && profileIds.has(tx.partner_profile_id)) return true;
      if (ownerIds.size && tx.owner_admin_id && ownerIds.has(tx.owner_admin_id)) return true;
      return !ownerFilter && isSuper() && !profileIds.size;
    };

    const partnerItems = (state.dealItems || []).filter(itemInScope);
    const partnerTransactions = (state.transactions || []).filter(txInScope);

    const totals = partnerItems.reduce((acc, item) => {
      if (!['void', 'waived'].includes(String(item.status || ''))) {
        const expected = expectedAmountForDealItem(item);
        if (String(item.direction || '') === 'incoming') acc.incoming_expected += expected;
        if (String(item.direction || '') === 'outgoing') acc.outgoing_expected += expected;
        acc.active_item_count += 1;
      }
      return acc;
    }, zeroFinancialSummary());

    partnerTransactions.forEach((tx) => {
      if (String(tx.status || '') !== 'completed') return;
      const amount = Number(tx.amount || 0);
      if (String(tx.direction || '') === 'incoming') totals.incoming_received += amount;
      if (String(tx.direction || '') === 'outgoing') totals.outgoing_paid += amount;
    });

    totals.net_expected = totals.incoming_expected - totals.outgoing_expected;
    totals.net_actual = totals.incoming_received - totals.outgoing_paid;
    totals.outstanding_receivable = Math.max(totals.incoming_expected - totals.incoming_received, 0);
    totals.outstanding_payable = Math.max(totals.outgoing_expected - totals.outgoing_paid, 0);
    totals.financial_status = financialStatusFromTotals(totals);
    totals.hasData = Boolean(totals.active_item_count || totals.incoming_received || totals.outgoing_paid);

    if (paymentMethod) {
      const hasMethod = partnerTransactions.some((tx) => tx.payment_method === paymentMethod);
      if (!hasMethod) return zeroFinancialSummary();
    }
    if (direction === 'incoming' && !(totals.incoming_expected > 0 || totals.incoming_received > 0)) return zeroFinancialSummary();
    if (direction === 'outgoing' && !(totals.outgoing_expected > 0 || totals.outgoing_paid > 0)) return zeroFinancialSummary();
    if (financialStatus && totals.financial_status !== financialStatus) return zeroFinancialSummary();

    if (search) {
      const haystack = [
        ...scopeProfiles.map((profile) => profile.display_name || ''),
        ...partnerItems.flatMap((item) => [item.item_name, item.item_type, item.notes, item.direction, item.status]),
        ...partnerTransactions.flatMap((tx) => [tx.transaction_type, tx.payment_method, tx.reference_number, tx.notes, tx.direction, tx.status])
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) return zeroFinancialSummary();
    }

    return totals;
  }

  function currentScopeSignedClients() {
    const ownerFilter = scopedOwnerAdminId();
    const search = String(byId('signedClientsSearch')?.value || '').trim().toLowerCase();
    const clientStatus = String(byId('signedClientsClientStatusFilter')?.value || '');
    const financialStatus = String(byId('signedClientsFinancialStatusFilter')?.value || '');
    const direction = String(byId('signedClientsDirectionFilter')?.value || '');
    const paymentMethod = String(byId('signedClientsPaymentMethodFilter')?.value || '');
    const sortBy = String(byId('signedClientsSortBy')?.value || 'newest');
    const fm = financialMap();

    let rows = [...(state.signedClients || [])].filter((row) => {
      if (ownerFilter && row.owner_admin_id !== ownerFilter) return false;
      if (clientStatus && row.client_status !== clientStatus) return false;

      const financial = fm.get(row.id) || {};
      if (financialStatus && String(financial.financial_status || '') !== financialStatus) return false;
      if (direction === 'incoming' && !(Number(financial.incoming_expected || 0) > 0 || Number(financial.incoming_received || 0) > 0)) return false;
      if (direction === 'outgoing' && !(Number(financial.outgoing_expected || 0) > 0 || Number(financial.outgoing_paid || 0) > 0)) return false;

      const relatedItems = relatedDealItemsForClient(row);
      const relatedTransactions = relatedTransactionsForClient(row);

      if (paymentMethod) {
        const hasMethod = relatedTransactions.some((tx) => tx.payment_method === paymentMethod);
        if (!hasMethod) return false;
      }

      if (search) {
        const haystack = [
          row.client_name,
          row.company_name,
          row.phone,
          row.email,
          row.property_address,
          row.city,
          row.state,
          row.zip,
          row.service_type,
          row.notes_private,
          row.job_status,
          row.client_status,
          partnerNameForAdmin(row.owner_admin_id),
          ...relatedItems.flatMap((item) => [item.item_name, item.item_type, item.notes, item.direction, item.status]),
          ...relatedTransactions.flatMap((tx) => [tx.transaction_type, tx.payment_method, tx.reference_number, tx.notes, tx.direction, tx.status])
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      const fa = fm.get(a.id) || {};
      const fb = fm.get(b.id) || {};
      if (sortBy === 'oldest') return String(a.signed_date || '').localeCompare(String(b.signed_date || ''));
      if (sortBy === 'client_name') return String(a.client_name || '').localeCompare(String(b.client_name || ''));
      if (sortBy === 'partner_name') return partnerNameForAdmin(a.owner_admin_id).localeCompare(partnerNameForAdmin(b.owner_admin_id));
      if (sortBy === 'highest_net') return Number(fb.net_expected || 0) - Number(fa.net_expected || 0);
      if (sortBy === 'largest_outstanding') {
        const aOut = Number(fa.outstanding_receivable || 0) + Number(fa.outstanding_payable || 0);
        const bOut = Number(fb.outstanding_receivable || 0) + Number(fb.outstanding_payable || 0);
        return bOut - aOut;
      }
      if (sortBy === 'recently_paid') return String(fb.last_transaction_date || '').localeCompare(String(fa.last_transaction_date || ''));
      return String(b.signed_date || '').localeCompare(String(a.signed_date || ''));
    });

    return rows;
  }

  function currentScopeOwnerIds() {
    const ownerFilter = scopedOwnerAdminId();
    const scopeProfiles = currentScopePartnerProfiles();
    const ownerIds = new Set(scopeProfiles.map((profile) => profile.admin_user_id).filter(Boolean));
    if (ownerFilter) ownerIds.add(ownerFilter);
    if (!ownerFilter && !isSuper() && window.currentUser?.id) ownerIds.add(window.currentUser.id);
    return ownerIds;
  }

  function currentScopeDealItems() {
    const ownerFilter = scopedOwnerAdminId();
    const search = String(byId('signedClientsSearch')?.value || '').trim().toLowerCase();
    const direction = String(byId('signedClientsDirectionFilter')?.value || '');
    const profileIds = new Set(currentScopePartnerProfiles().map((profile) => profile.id).filter(Boolean));
    const ownerIds = currentScopeOwnerIds();

    return [...(state.dealItems || [])].filter((item) => {
      const inScope = (profileIds.size && item.partner_profile_id && profileIds.has(item.partner_profile_id))
        || (ownerIds.size && item.owner_admin_id && ownerIds.has(item.owner_admin_id))
        || (!ownerFilter && isSuper() && !profileIds.size);
      if (!inScope) return false;
      if (direction && item.direction !== direction) return false;
      if (!search) return true;
      const linkedClient = (state.signedClients || []).find((client) => client.id === item.signed_client_id);
      const haystack = [
        item.item_name,
        item.item_type,
        item.notes,
        item.direction,
        item.status,
        partnerNameForAdmin(item.owner_admin_id),
        linkedClient?.client_name,
        linkedClient?.company_name
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(search);
    }).sort((a, b) => String(b.applies_on || b.created_at || '').localeCompare(String(a.applies_on || a.created_at || '')));
  }

  function currentScopeTransactions() {
    const ownerFilter = scopedOwnerAdminId();
    const search = String(byId('signedClientsSearch')?.value || '').trim().toLowerCase();
    const direction = String(byId('signedClientsDirectionFilter')?.value || '');
    const paymentMethod = String(byId('signedClientsPaymentMethodFilter')?.value || '');
    const profileIds = new Set(currentScopePartnerProfiles().map((profile) => profile.id).filter(Boolean));
    const ownerIds = currentScopeOwnerIds();

    return [...(state.transactions || [])].filter((tx) => {
      const inScope = (profileIds.size && tx.partner_profile_id && profileIds.has(tx.partner_profile_id))
        || (ownerIds.size && tx.owner_admin_id && ownerIds.has(tx.owner_admin_id))
        || (!ownerFilter && isSuper() && !profileIds.size);
      if (!inScope) return false;
      if (direction && tx.direction !== direction) return false;
      if (paymentMethod && tx.payment_method !== paymentMethod) return false;
      if (!search) return true;
      const linkedClient = (state.signedClients || []).find((client) => client.id === tx.signed_client_id);
      const linkedDealItem = (state.dealItems || []).find((item) => item.id === tx.deal_item_id);
      const haystack = [
        tx.transaction_type,
        tx.payment_method,
        tx.reference_number,
        tx.notes,
        tx.direction,
        tx.status,
        partnerNameForAdmin(tx.owner_admin_id),
        linkedClient?.client_name,
        linkedClient?.company_name,
        linkedDealItem?.item_name,
        linkedDealItem?.item_type
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(search);
    }).sort((a, b) => String(b.transaction_date || b.created_at || '').localeCompare(String(a.transaction_date || a.created_at || '')));
  }

  function combinedScopeFinancialSummary(rows = currentScopeSignedClients()) {
    const fm = financialMap();
    const partnerLevel = currentScopePartnerLevelFinancials();
    const totals = rows.reduce((acc, row) => {
      const entry = fm.get(row.id) || {};
      if (['active', 'on_hold'].includes(String(row.client_status || ''))) acc.active += 1;
      acc.incoming_expected += Number(entry.incoming_expected || 0);
      acc.incoming_received += Number(entry.incoming_received || 0);
      acc.outgoing_expected += Number(entry.outgoing_expected || 0);
      acc.outgoing_paid += Number(entry.outgoing_paid || 0);
      acc.net_expected += Number(entry.net_expected || 0);
      acc.net_actual += Number(entry.net_actual || 0);
      acc.outstanding_receivable += Number(entry.outstanding_receivable || 0);
      acc.outstanding_payable += Number(entry.outstanding_payable || 0);
      return acc;
    }, { active: 0, incoming_expected: 0, incoming_received: 0, outgoing_expected: 0, outgoing_paid: 0, net_expected: 0, net_actual: 0, outstanding_receivable: 0, outstanding_payable: 0 });

    totals.incoming_expected += Number(partnerLevel.incoming_expected || 0);
    totals.incoming_received += Number(partnerLevel.incoming_received || 0);
    totals.outgoing_expected += Number(partnerLevel.outgoing_expected || 0);
    totals.outgoing_paid += Number(partnerLevel.outgoing_paid || 0);
    totals.net_expected += Number(partnerLevel.net_expected || 0);
    totals.net_actual += Number(partnerLevel.net_actual || 0);
    totals.outstanding_receivable += Number(partnerLevel.outstanding_receivable || 0);
    totals.outstanding_payable += Number(partnerLevel.outstanding_payable || 0);
    return totals;
  }

  function currentScopeLabel() {
    const ownerId = scopedOwnerAdminId();
    if (ownerId) return partnerNameForAdmin(ownerId);
    return isSuper() ? 'All partners' : 'My partner ledger';
  }

  function renderScopeControls() {
    const wrap = byId('signedClientsScopeWrap');
    const select = byId('signedClientsPartnerFilter');
    const checkbox = byId('signedClientsSelectedOnly');
    if (!wrap || !select || !checkbox) return;

    if (isSuper()) {
      wrap.classList.remove('hidden');
      const previous = select.value;
      const owners = ownerAdminDirectory();
      select.innerHTML = '<option value="">All Partners</option>' + owners.map((owner) => `<option value="${owner.admin_user_id}">${escape(owner.display_name || 'Partner')}</option>`).join('');
      select.value = owners.some((owner) => owner.admin_user_id === previous) ? previous : '';
      checkbox.checked = Boolean(select.value);
    } else {
      wrap.classList.add('hidden');
      select.innerHTML = '';
      checkbox.checked = false;
    }
  }

  function renderKpis(rows) {
    const totals = combinedScopeFinancialSummary(rows);
    if (byId('signedClientsKpiActive')) byId('signedClientsKpiActive').textContent = String(totals.active);
    if (byId('signedClientsKpiIncoming')) byId('signedClientsKpiIncoming').textContent = safeMoney(totals.incoming_expected);
    if (byId('signedClientsKpiIncomingMeta')) byId('signedClientsKpiIncomingMeta').textContent = `Received: ${safeMoney(totals.incoming_received)}`;
    if (byId('signedClientsKpiOutgoing')) byId('signedClientsKpiOutgoing').textContent = safeMoney(totals.outgoing_expected);
    if (byId('signedClientsKpiOutgoingMeta')) byId('signedClientsKpiOutgoingMeta').textContent = `Paid: ${safeMoney(totals.outgoing_paid)}`;
    if (byId('signedClientsKpiNet')) byId('signedClientsKpiNet').textContent = safeMoney(totals.net_expected);
    if (byId('signedClientsKpiNetMeta')) byId('signedClientsKpiNetMeta').textContent = `Actual net: ${safeMoney(totals.net_actual)}`;
    if (byId('signedClientsKpiReceivable')) byId('signedClientsKpiReceivable').textContent = safeMoney(totals.outstanding_receivable);
    if (byId('signedClientsKpiPayable')) byId('signedClientsKpiPayable').textContent = safeMoney(totals.outstanding_payable);
  }

  function dealItemCountLabel(row) {
    const count = relatedDealItemsForClient(row).length;
    return `${count} item${count === 1 ? '' : 's'}`;
  }

  function renderSignedClientsTable() {
    const rows = currentScopeSignedClients();
    const tbody = byId('signedClientsTableBody');
    const count = byId('signedClientsTableCount');
    if (!tbody || !count) return;

    count.textContent = `${rows.length} client${rows.length === 1 ? '' : 's'}`;
    renderKpis(rows);

    if (!rows.length) {
      const partnerLevel = currentScopePartnerLevelFinancials();
      const emptyMessage = partnerLevel.hasData
        ? 'No signed clients match the current filters yet. Partner-level deal items and transactions are still included in the KPI totals above.'
        : 'No signed clients match the current filters yet.';
      tbody.innerHTML = `<tr><td colspan="14" class="loading-row">${emptyMessage}</td></tr>`;
      renderSignedClientsDetails(null);
      return;
    }

    const fm = financialMap();
    tbody.innerHTML = rows.map((row) => {
      const f = fm.get(row.id) || {};
      const isActive = row.id === state.selectedClientId;
      return `<tr data-signed-client-id="${row.id}" class="${isActive ? 'signed-client-row-active' : ''}">
        <td><button type="button" class="signed-client-open" data-sc-action="edit" data-sc-id="${row.id}">${escape(row.client_name || '—')}</button><br><small>${escape(row.phone || row.email || 'No contact')}</small></td>
        <td>${escape(partnerNameForAdmin(row.owner_admin_id))}</td>
        <td>${escape(row.signed_date || '—')}</td>
        <td>${escape([row.property_address, row.city, row.state, row.zip].filter(Boolean).join(', ') || '—')}</td>
        <td>${escape(row.service_type || '—')}</td>
        <td>${escape(safeMoney(row.contract_value || 0))}</td>
        <td>${escape(safeMoney(row.profit_amount || 0))}</td>
        <td><span class="storm-chip">${escape(dealItemCountLabel(row))}</span></td>
        <td>${escape(safeMoney(f.incoming_expected || 0))}</td>
        <td>${escape(safeMoney(f.outgoing_expected || 0))}</td>
        <td>${escape(safeMoney(f.net_expected || 0))}</td>
        <td><span class="status-pill ${statusClass(row.job_status)}">${escape(prettyLabel(row.job_status))}</span></td>
        <td><span class="status-pill ${statusClass(f.financial_status || 'no_items')}">${escape(prettyLabel(f.financial_status || 'no_items'))}</span></td>
        <td>
          <button class="btn-view" data-sc-action="edit" data-sc-id="${row.id}">Edit</button>
          <button class="btn-call" data-sc-action="txn" data-sc-id="${row.id}"><i class="fas fa-money-bill-transfer"></i></button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-signed-client-id]').forEach((tr) => {
      tr.addEventListener('click', () => selectSignedClient(tr.dataset.signedClientId));
    });

    tbody.querySelectorAll('button[data-sc-action]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (btn.dataset.scAction === 'edit') {
          selectSignedClient(btn.dataset.scId, true);
          openSignedClientModal(btn.dataset.scId);
        }
        if (btn.dataset.scAction === 'txn') {
          selectSignedClient(btn.dataset.scId);
          openTransactionModal();
        }
      });
    });

    if (state.selectedClientId && !rows.some((row) => row.id === state.selectedClientId)) {
      state.selectedClientId = null;
    }
    renderSignedClientsDetails(state.selectedClientId);
  }

  function selectSignedClient(clientId, silent = false) {
    state.selectedClientId = clientId || null;
    if (!silent) renderSignedClientsTable();
    renderSignedClientsDetails(state.selectedClientId);
    populateSignedClientsModalOptions();
  }

  function renderSignedClientsDetails(clientId) {
    const empty = byId('signedClientsEmptyState');
    const content = byId('signedClientsDetailContent');
    const badge = byId('signedClientsDetailBadge');
    const editBtn = byId('signedClientsEditBtn');
    const allLedgerBtn = byId('signedClientsAllTransactionsBtn');
    const info = byId('signedClientsDetailInfo');
    const summary = byId('signedClientsFinancialSummary');
    const dealItemsBody = byId('signedClientsDealItemsBody');
    const txBody = byId('signedClientsTransactionsBody');
    if (!empty || !content || !badge || !info || !summary || !dealItemsBody || !txBody) return;

    const row = (state.signedClients || []).find((item) => item.id === clientId) || null;
    const summaryRows = row ? [row] : currentScopeSignedClients();
    const detailSummary = row ? (financialMap().get(row.id) || {}) : combinedScopeFinancialSummary(summaryRows);
    const detailDealItems = row ? relatedDealItemsForClient(row) : currentScopeDealItems();
    const detailTransactions = row ? relatedTransactionsForClient(row) : currentScopeTransactions();

    empty.classList.add('hidden');
    content.classList.remove('hidden');

    if (allLedgerBtn) {
      allLedgerBtn.disabled = !row;
      allLedgerBtn.innerHTML = row
        ? '<i class="fas fa-table-list"></i> Full Ledger'
        : '<i class="fas fa-table-list"></i> Viewing Full Ledger';
    }

    if (row) {
      if (editBtn) editBtn.classList.remove('hidden');
      badge.className = `status-pill ${statusClass(detailSummary.financial_status || row.client_status)}`;
      badge.textContent = prettyLabel(detailSummary.financial_status || row.client_status || 'active');
      const companyCam = parseCompanyCamMeta(row.notes_private || '');
      const companyCamProjects = companyCam.projects || [];
      const clientCalls = relatedCallsForClient(row);
      const companyCamLinks = companyCamProjects.length
        ? companyCamProjects.map((project) => `<a href="${escape(project.projectUrl)}" target="_blank" rel="noopener noreferrer">${escape(project.projectName)}</a>`).join('<br>')
        : '—';
      const companyCamList = companyCamProjects.length
        ? `<div style="display:grid;gap:8px;">${companyCamProjects.map((project, index) => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.03);">
              <a href="${escape(project.projectUrl)}" target="_blank" rel="noopener noreferrer" style="font-weight:600;">${escape(project.projectName)}</a>
              <div class="signed-row-actions" style="margin-left:auto;">
                <a class="btn-view" href="${escape(project.projectUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
                <button type="button" class="btn-danger" data-companycam-remove-index="${index}"><i class="fas fa-trash"></i> Remove</button>
              </div>
            </div>`).join('')}</div>`
        : '<div style="color:rgba(255,255,255,0.65);font-size:0.9rem;">No CompanyCam projects saved yet.</div>';
      const callHistoryHtml = renderClientCallHistory(clientCalls);
      info.innerHTML = [
        ['Client Name', row.client_name],
        ['Company Name', row.company_name],
        ['Phone', row.phone],
        ['Email', row.email],
        ['Property Address', row.property_address],
        ['City / State / ZIP', [row.city, row.state, row.zip].filter(Boolean).join(', ')],
        ['Partner Owner', partnerNameForAdmin(row.owner_admin_id)],
        ['Signed Date', row.signed_date],
        ['Service Type', row.service_type],
        ['Job Status', prettyLabel(row.job_status)],
        ['Client Status', prettyLabel(row.client_status)],
        ['Contract Value', safeMoney(row.contract_value || 0)],
        ['Profit Amount', safeMoney(row.profit_amount || 0)],
        ['Internal Notes', companyCam.cleanNotes || '—'],
        ['CompanyCam Projects', companyCamLinks]
      ].map(([label, value]) => `<div class="signed-clients-info-row"><span>${escape(label)}</span><strong>${typeof value === 'string' ? value : escape(String(value || '—'))}</strong></div>`).join('') + `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);display:grid;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <strong style="font-size:0.95rem;">Call Log</strong>
            <span style="color:rgba(255,255,255,0.65);font-size:0.85rem;">${clientCalls.length} saved call${clientCalls.length === 1 ? '' : 's'}</span>
          </div>
          ${callHistoryHtml}
        </div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);display:grid;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <strong style="font-size:0.95rem;">CompanyCam</strong>
            <span style="color:rgba(255,255,255,0.65);font-size:0.85rem;">${companyCamProjects.length} saved project${companyCamProjects.length === 1 ? '' : 's'}</span>
          </div>
          ${companyCamList}
          <div class="form-group" style="margin:0;">
            <label style="margin-bottom:6px;display:block;">Project Name</label>
            <input type="text" id="signedClientsCompanyCamName" value="" placeholder="Example: Smith Roof Claim" />
          </div>
          <div class="form-group" style="margin:0;">
            <label style="margin-bottom:6px;display:block;">Project URL</label>
            <input type="url" id="signedClientsCompanyCamUrl" value="" placeholder="https://app.companycam.com/projects/..." />
          </div>
          <div class="signed-row-actions">
            <button type="button" class="btn-save" id="signedClientsCompanyCamSaveBtn"><i class="fas fa-camera"></i> Add Project</button>
          </div>
        </div>`;
      byId('signedClientsCompanyCamSaveBtn')?.addEventListener('click', () => saveCompanyCamForSelectedClient(row.id));
      info.querySelectorAll('[data-companycam-remove-index]').forEach((btn) => {
        btn.addEventListener('click', () => removeCompanyCamProjectForSelectedClient(btn.dataset.companycamRemoveIndex, row.id));
      });
      info.querySelectorAll('[data-signed-call-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (typeof window.openCallModal === 'function') window.openCallModal(btn.dataset.signedCallId, true);
        });
      });
    } else {
      if (editBtn) editBtn.classList.add('hidden');
      badge.className = 'status-pill status-active';
      badge.textContent = 'All transactions';
      const scopeProfiles = currentScopePartnerProfiles();
      info.innerHTML = [
        ['Viewing', currentScopeLabel()],
        ['Signed Clients In Scope', String(summaryRows.length)],
        ['Partner Profiles In Scope', String(scopeProfiles.length)],
        ['Deal Items In Scope', String(detailDealItems.length)],
        ['Transactions In Scope', String(detailTransactions.length)],
        ['Ledger Mode', 'All client-linked and partner-level transactions'],
        ['Tip', 'Click a client row anytime to switch back to a single-client ledger']
      ].map(([label, value]) => `<div class="signed-clients-info-row"><span>${escape(label)}</span><strong>${escape(String(value || '—'))}</strong></div>`).join('');
    }

    summary.innerHTML = [
      ['Incoming Expected', detailSummary.incoming_expected],
      ['Incoming Received', detailSummary.incoming_received],
      ['Outgoing Expected', detailSummary.outgoing_expected],
      ['Outgoing Paid', detailSummary.outgoing_paid],
      ['Net Expected', detailSummary.net_expected],
      ['Net Actual', detailSummary.net_actual],
      ['Outstanding Receivable', detailSummary.outstanding_receivable],
      ['Outstanding Payable', detailSummary.outstanding_payable]
    ].map(([label, value]) => `<div class="signed-summary-card"><span>${escape(label)}</span><strong>${escape(safeMoney(value || 0))}</strong></div>`).join('');

    dealItemsBody.innerHTML = detailDealItems.length ? detailDealItems.map((item) => {
      const linkedClient = (state.signedClients || []).find((client) => client.id === item.signed_client_id);
      return `
      <tr data-deal-item-id="${item.id}" class="signed-deal-item-row">
        <td>${escape(prettyLabel(item.item_type))}</td>
        <td><button type="button" class="signed-client-open" data-sc-deal-action="edit" data-sc-deal-id="${item.id}">${escape(item.item_name || '—')}</button>${!row && linkedClient?.client_name ? `<br><small>${escape(linkedClient.client_name)}</small>` : ''}</td>
        <td><span class="status-pill ${statusClass(item.direction)}">${escape(prettyLabel(item.direction))}</span></td>
        <td>${escape(prettyLabel(item.calculation_type))}</td>
        <td>${escape(item.percent_rate ? `${item.percent_rate}%` : safeMoney(item.flat_amount || 0))}</td>
        <td>${escape(String(item.quantity || 1))}</td>
        <td>${escape(safeMoney(item.expected_amount || 0))}</td>
        <td><span class="status-pill ${statusClass(item.status)}">${escape(prettyLabel(item.status))}</span></td>
        <td>${escape(item.notes || '—')}</td>
        <td>
          <div class="signed-row-actions">
            <button type="button" class="btn-view" data-sc-deal-action="edit" data-sc-deal-id="${item.id}">Edit</button>
            <button type="button" class="btn-danger" data-sc-deal-action="delete" data-sc-deal-id="${item.id}"><i class="fas fa-trash"></i> Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="10" class="loading-row">${row ? 'No deal items for this client or partner-level items yet.' : 'No deal items in the current partner scope yet.'}</td></tr>`;

    dealItemsBody.querySelectorAll('tr[data-deal-item-id]').forEach((tr) => {
      tr.addEventListener('click', () => openDealItemModal(tr.dataset.dealItemId));
    });

    dealItemsBody.querySelectorAll('button[data-sc-deal-action]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (btn.dataset.scDealAction === 'edit') openDealItemModal(btn.dataset.scDealId);
        if (btn.dataset.scDealAction === 'delete') deleteDealItem(btn.dataset.scDealId);
      });
    });

    txBody.innerHTML = detailTransactions.length ? detailTransactions.map((tx) => {
      const dealItem = (state.dealItems || []).find((item) => item.id === tx.deal_item_id);
      const txClient = (state.signedClients || []).find((item) => item.id === tx.signed_client_id);
      return `<tr data-transaction-id="${tx.id}" class="signed-transaction-row">
        <td>${escape(tx.transaction_date || '—')}</td>
        <td>${escape(partnerNameForAdmin(tx.owner_admin_id))}</td>
        <td>${escape(txClient?.client_name || 'No client / partner-level')}</td>
        <td><span class="status-pill ${statusClass(tx.direction)}">${escape(prettyLabel(tx.direction))}</span></td>
        <td>${escape(prettyLabel(tx.transaction_type))}</td>
        <td>${escape(prettyLabel(tx.payment_method))}</td>
        <td>${escape(tx.reference_number || '—')}</td>
        <td>${escape(dealItem?.item_name || 'Manual / unmatched')}</td>
        <td>${escape(safeMoney(tx.amount || 0))}</td>
        <td>${escape(getAgentDisplayNameSafe(tx.recorded_by))}</td>
        <td>${escape(tx.notes || '—')}</td>
        <td>
          <div class="signed-row-actions">
            <button type="button" class="btn-view" data-sc-tx-action="edit" data-sc-tx-id="${tx.id}">Edit</button>
            <button type="button" class="btn-danger" data-sc-tx-action="delete" data-sc-tx-id="${tx.id}"><i class="fas fa-trash"></i> Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="12" class="loading-row">${row ? 'No transactions for this client or partner-level items yet.' : 'No transactions in the current partner scope yet.'}</td></tr>`;

    txBody.querySelectorAll('tr[data-transaction-id]').forEach((tr) => {
      tr.addEventListener('click', () => openTransactionModal(tr.dataset.transactionId));
    });

    txBody.querySelectorAll('button[data-sc-tx-action]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (btn.dataset.scTxAction === 'edit') openTransactionModal(btn.dataset.scTxId);
        if (btn.dataset.scTxAction === 'delete') deleteTransaction(btn.dataset.scTxId);
      });
    });
  }

  async function loadSignedClientsViewData({ force = false } = {}) {
    if (!canUseSignedClients()) return;
    if (state.loading) return;
    if (state.loaded && !force) {
      renderScopeControls();
      renderSignedClientsTable();
      populateSignedClientsModalOptions();
      syncDealItemInputs();
      syncTransactionInputs();
      return;
    }

    state.loading = true;
    signedStatus('Loading signed clients, call logs, partner profiles, deal items, and transactions…');
    try {
      const [profilesRes, clientsRes, leadsRes, financialRes, dealItemsRes, txRes] = await Promise.all([
        window.sb.from('crm_partner_profiles').select('*').order('display_name', { ascending: true }),
        window.sb.from('crm_signed_clients').select('*').order('signed_date', { ascending: false }),
        window.sb.from('crm_leads').select('id, phone, email'),
        window.sb.from('v_signed_client_financials').select('*'),
        window.sb.from('crm_partner_deal_items').select('*').order('created_at', { ascending: false }),
        window.sb.from('crm_partner_transactions').select('*').order('transaction_date', { ascending: false })
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (clientsRes.error) throw clientsRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (financialRes.error) throw financialRes.error;
      if (dealItemsRes.error) throw dealItemsRes.error;
      if (txRes.error) throw txRes.error;

      state.partnerProfiles = profilesRes.data || [];
      state.signedClients = clientsRes.data || [];
      state.crmLeads = leadsRes.data || [];
      state.financialRows = financialRes.data || [];
      state.dealItems = dealItemsRes.data || [];
      state.transactions = txRes.data || [];

      const callLeadIds = new Set();
      (state.signedClients || []).forEach((client) => {
        relatedLeadIdsForClient(client).forEach((leadId) => callLeadIds.add(String(leadId)));
      });
      state.callAttempts = await loadCallAttemptsForLeadIds([...callLeadIds]);
      state.loaded = true;

      renderScopeControls();
      renderSignedClientsTable();
      populateSignedClientsModalOptions();
      syncDealItemInputs();
      syncTransactionInputs();
      if (!state.partnerProfiles.length) {
        signedStatus('No partner profiles were found yet. Existing admin owners will still appear in the partner owner list, and partner profiles will auto-create when a signed client is saved for them.', 'warning');
      } else {
        signedStatus('Signed Clients synced successfully.', 'success');
      }
    } catch (error) {
      signedStatus('Could not load Signed Clients data: ' + escape(error.message || 'Unknown error'), 'error');
    } finally {
      state.loading = false;
    }
  }

  function modalVisibleClients() {
    const ownerFilter = scopedOwnerAdminId();
    if (!ownerFilter) return [...(state.signedClients || [])];
    return (state.signedClients || []).filter((client) => client.owner_admin_id === ownerFilter);
  }

  function populateSignedClientsModalOptions() {
    const ownerSelect = byId('sc_owner_admin_id');
    const partnerSelects = [byId('di_partner_profile_id'), byId('tx_partner_profile_id')].filter(Boolean);
    const clientSelects = [byId('di_signed_client_id'), byId('tx_signed_client_id')].filter(Boolean);
    const dealItemSelect = byId('tx_deal_item_id');

    const partnerProfiles = isSuper() ? [...(state.partnerProfiles || [])] : visiblePartnerProfiles();
    const ownerAdmins = ownerAdminDirectory();
    const adminOptions = ownerAdmins.map((owner) => `<option value="${owner.admin_user_id}">${escape(owner.display_name || partnerNameForAdmin(owner.admin_user_id))}</option>`).join('');
    if (ownerSelect) {
      const previous = ownerSelect.value;
      ownerSelect.innerHTML = adminOptions;
      ownerSelect.value = [...ownerSelect.options].some((option) => option.value === previous) ? previous : (ownerAdmins[0]?.admin_user_id || window.currentUser?.id || '');
      ownerSelect.disabled = !isSuper();
    }

    const partnerOptions = '<option value="">Select partner</option>' + partnerProfiles.map((profile) => `<option value="${profile.id}">${escape(profile.display_name || 'Partner')}</option>`).join('');
    partnerSelects.forEach((select) => {
      const previous = select.value;
      select.innerHTML = partnerOptions;
      select.value = [...select.options].some((option) => option.value === previous) ? previous : (partnerProfiles[0]?.id || '');
      select.disabled = !isSuper() && partnerProfiles.length <= 1;
    });

    const availableClients = modalVisibleClients();
    const clientOptions = '<option value="">No client / partner-level</option>' + availableClients.map((client) => `<option value="${client.id}">${escape(client.client_name || 'Client')} · ${escape(partnerNameForAdmin(client.owner_admin_id))}</option>`).join('');
    clientSelects.forEach((select) => {
      const previous = select.value;
      select.innerHTML = clientOptions;
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    });

    if (dealItemSelect) {
      const selectedPartnerProfileId = byId('tx_partner_profile_id')?.value || '';
      const currentClientId = byId('tx_signed_client_id')?.value || state.selectedClientId || '';
      const eligibleDealItems = (state.dealItems || []).filter((item) => {
        if (selectedPartnerProfileId && item.partner_profile_id !== selectedPartnerProfileId) return false;
        if (currentClientId) return item.signed_client_id === currentClientId || !item.signed_client_id;
        return true;
      });
      const previous = dealItemSelect.value;
      const dealOptions = '<option value="">No linked deal item</option>' + eligibleDealItems.map((item) => `<option value="${item.id}">${escape(item.item_name || 'Deal Item')} · ${escape(prettyLabel(item.direction))}</option>`).join('');
      dealItemSelect.innerHTML = dealOptions;
      if ([...dealItemSelect.options].some((option) => option.value === previous)) dealItemSelect.value = previous;
    }
  }

  function resetSignedClientForm() {
    state.editingClientId = null;
    byId('sc_client_name') && (byId('sc_client_name').value = '');
    byId('sc_company_name') && (byId('sc_company_name').value = '');
    byId('sc_phone') && (byId('sc_phone').value = '');
    byId('sc_email') && (byId('sc_email').value = '');
    byId('sc_property_address') && (byId('sc_property_address').value = '');
    byId('sc_city') && (byId('sc_city').value = '');
    byId('sc_state') && (byId('sc_state').value = '');
    byId('sc_zip') && (byId('sc_zip').value = '');
    byId('sc_service_type') && (byId('sc_service_type').value = '');
    byId('sc_signed_date') && (byId('sc_signed_date').value = new Date().toISOString().slice(0, 10));
    byId('sc_job_status') && (byId('sc_job_status').value = 'signed');
    byId('sc_client_status') && (byId('sc_client_status').value = 'active');
    byId('sc_contract_value') && (byId('sc_contract_value').value = '0');
    byId('sc_profit_amount') && (byId('sc_profit_amount').value = '0');
    byId('sc_notes_private') && (byId('sc_notes_private').value = '');
  }

  function resetDealItemForm() {
    state.editingDealItemId = null;
    byId('di_item_scope') && (byId('di_item_scope').value = 'client');
    byId('di_item_name') && (byId('di_item_name').value = '');
    byId('di_item_type') && (byId('di_item_type').value = 'commission_per_signed_client');
    byId('di_direction') && (byId('di_direction').value = 'incoming');
    byId('di_calculation_type') && (byId('di_calculation_type').value = 'fixed_amount');
    byId('di_flat_amount') && (byId('di_flat_amount').value = '0');
    byId('di_percent_rate') && (byId('di_percent_rate').value = '0');
    byId('di_quantity') && (byId('di_quantity').value = '1');
    byId('di_applies_on') && (byId('di_applies_on').value = new Date().toISOString().slice(0, 10));
    byId('di_status') && (byId('di_status').value = 'due');
    byId('di_notes') && (byId('di_notes').value = '');
    syncDealItemInputs();
  }

  function resetTransactionForm() {
    state.editingTransactionId = null;
    byId('tx_direction') && (byId('tx_direction').value = 'incoming');
    byId('tx_transaction_type') && (byId('tx_transaction_type').value = 'other');
    byId('tx_transaction_date') && (byId('tx_transaction_date').value = new Date().toISOString().slice(0, 10));
    byId('tx_amount') && (byId('tx_amount').value = '0');
    byId('tx_payment_method') && (byId('tx_payment_method').value = 'zelle');
    byId('tx_reference_number') && (byId('tx_reference_number').value = '');
    byId('tx_status') && (byId('tx_status').value = 'completed');
    byId('tx_notes') && (byId('tx_notes').value = '');
    syncTransactionInputs();
  }

  function defaultTransactionTypeForDealItem(dealItem) {
    const itemType = String(dealItem?.item_type || '').toLowerCase();
    const map = {
      commission_per_signed_client: 'commission_payment',
      training_fee: 'training_payment',
      membership_fee: 'membership_fee',
      upfront_fee: 'upfront_fee',
      profit_share: 'profit_share',
      bonus: 'bonus',
      reimbursement: 'reimbursement',
      adjustment: 'adjustment'
    };
    return map[itemType] || 'other';
  }

  function syncDealItemInputs() {
    const scopeSelect = byId('di_item_scope');
    const clientSelect = byId('di_signed_client_id');
    const calcSelect = byId('di_calculation_type');
    const flatInput = byId('di_flat_amount');
    const percentInput = byId('di_percent_rate');
    if (!scopeSelect || !clientSelect || !calcSelect || !flatInput || !percentInput) return;

    const isPartner = scopeSelect.value === 'partner';
    const isPercent = ['percent_profit', 'percent_revenue'].includes(calcSelect.value);

    clientSelect.disabled = isPartner;
    if (isPartner) clientSelect.value = '';
    flatInput.disabled = isPercent;
    percentInput.disabled = !isPercent;
  }

  function syncTransactionInputs() {
    populateSignedClientsModalOptions();
    const dealItemId = byId('tx_deal_item_id')?.value || '';
    if (!dealItemId) return;

    const item = (state.dealItems || []).find((row) => row.id === dealItemId);
    if (!item) return;

    if (byId('tx_partner_profile_id') && item.partner_profile_id) byId('tx_partner_profile_id').value = item.partner_profile_id;
    if (byId('tx_signed_client_id') && item.signed_client_id) byId('tx_signed_client_id').value = item.signed_client_id;
    if (byId('tx_direction') && item.direction) byId('tx_direction').value = item.direction;
    if (byId('tx_transaction_type')) byId('tx_transaction_type').value = defaultTransactionTypeForDealItem(item);
  }

  function fillSignedClientForm(client) {
    if (!client) return;
    byId('sc_client_name') && (byId('sc_client_name').value = client.client_name || '');
    byId('sc_company_name') && (byId('sc_company_name').value = client.company_name || '');
    byId('sc_phone') && (byId('sc_phone').value = client.phone || '');
    byId('sc_email') && (byId('sc_email').value = client.email || '');
    byId('sc_property_address') && (byId('sc_property_address').value = client.property_address || '');
    byId('sc_city') && (byId('sc_city').value = client.city || '');
    byId('sc_state') && (byId('sc_state').value = client.state || '');
    byId('sc_zip') && (byId('sc_zip').value = client.zip || '');
    byId('sc_service_type') && (byId('sc_service_type').value = client.service_type || '');
    byId('sc_signed_date') && (byId('sc_signed_date').value = client.signed_date || '');
    byId('sc_job_status') && (byId('sc_job_status').value = client.job_status || 'signed');
    byId('sc_client_status') && (byId('sc_client_status').value = client.client_status || 'active');
    byId('sc_contract_value') && (byId('sc_contract_value').value = String(client.contract_value ?? 0));
    byId('sc_profit_amount') && (byId('sc_profit_amount').value = String(client.profit_amount ?? 0));
    byId('sc_notes_private') && (byId('sc_notes_private').value = client.notes_private || '');
    byId('sc_owner_admin_id') && (byId('sc_owner_admin_id').value = client.owner_admin_id || byId('sc_owner_admin_id').value || '');
  }

  function openSignedClientModal(clientId = null) {
    resetSignedClientForm();
    populateSignedClientsModalOptions();
    const client = clientId ? ((state.signedClients || []).find((item) => item.id === clientId) || null) : null;
    state.editingClientId = client?.id || null;
    if (client) {
      fillSignedClientForm(client);
      if (byId('signedClientModalTitle')) byId('signedClientModalTitle').innerHTML = '<i class="fas fa-pen-to-square"></i> Edit Signed Client';
      if (byId('signedClientModalSub')) byId('signedClientModalSub').textContent = 'Update the signed client record, ownership, and contact details.';
      if (byId('signedClientSaveBtn')) byId('signedClientSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Changes';
    } else {
      if (byId('signedClientModalTitle')) byId('signedClientModalTitle').innerHTML = '<i class="fas fa-file-signature"></i> Add Signed Client';
      if (byId('signedClientModalSub')) byId('signedClientModalSub').textContent = 'Create a signed client record and attach it to the correct partner admin.';
      if (byId('signedClientSaveBtn')) byId('signedClientSaveBtn').innerHTML = '<i class="fas fa-save"></i> Create Signed Client';
      if (byId('sc_owner_admin_id')) byId('sc_owner_admin_id').value = scopedOwnerAdminId() || byId('sc_owner_admin_id').value || window.currentUser?.id || '';
    }
    byId('signedClientModal')?.classList.remove('hidden');
  }

  function fillDealItemForm(item) {
    if (!item) return;
    byId('di_item_scope') && (byId('di_item_scope').value = item.item_scope || (item.signed_client_id ? 'client' : 'partner'));
    byId('di_partner_profile_id') && (byId('di_partner_profile_id').value = item.partner_profile_id || '');
    byId('di_signed_client_id') && (byId('di_signed_client_id').value = item.signed_client_id || '');
    byId('di_item_name') && (byId('di_item_name').value = item.item_name || '');
    byId('di_item_type') && (byId('di_item_type').value = item.item_type || 'commission_per_signed_client');
    byId('di_direction') && (byId('di_direction').value = item.direction || 'incoming');
    byId('di_calculation_type') && (byId('di_calculation_type').value = item.calculation_type || 'fixed_amount');
    byId('di_flat_amount') && (byId('di_flat_amount').value = String(item.flat_amount ?? 0));
    byId('di_percent_rate') && (byId('di_percent_rate').value = String(item.percent_rate ?? 0));
    byId('di_quantity') && (byId('di_quantity').value = String(item.quantity ?? 1));
    byId('di_applies_on') && (byId('di_applies_on').value = item.applies_on || '');
    byId('di_status') && (byId('di_status').value = item.status || 'due');
    byId('di_notes') && (byId('di_notes').value = item.notes || '');
  }

  function fillTransactionForm(tx) {
    if (!tx) return;
    byId('tx_partner_profile_id') && (byId('tx_partner_profile_id').value = tx.partner_profile_id || '');
    byId('tx_signed_client_id') && (byId('tx_signed_client_id').value = tx.signed_client_id || '');
    byId('tx_deal_item_id') && (byId('tx_deal_item_id').value = tx.deal_item_id || '');
    byId('tx_direction') && (byId('tx_direction').value = tx.direction || 'incoming');
    byId('tx_transaction_type') && (byId('tx_transaction_type').value = tx.transaction_type || 'other');
    byId('tx_transaction_date') && (byId('tx_transaction_date').value = tx.transaction_date || '');
    byId('tx_amount') && (byId('tx_amount').value = String(tx.amount ?? 0));
    byId('tx_payment_method') && (byId('tx_payment_method').value = tx.payment_method || 'zelle');
    byId('tx_reference_number') && (byId('tx_reference_number').value = tx.reference_number || '');
    byId('tx_status') && (byId('tx_status').value = tx.status || 'completed');
    byId('tx_notes') && (byId('tx_notes').value = tx.notes || '');
  }

  function openDealItemModal(dealItemId = null) {
    resetDealItemForm();
    populateSignedClientsModalOptions();
    const client = (state.signedClients || []).find((item) => item.id === state.selectedClientId) || null;
    const profile = client ? partnerProfileByAdminId(client.owner_admin_id) : currentScopePartnerProfiles()[0] || visiblePartnerProfiles()[0] || null;
    const dealItem = dealItemId ? ((state.dealItems || []).find((item) => item.id === dealItemId) || null) : null;
    state.editingDealItemId = dealItem?.id || null;
    if (dealItem) {
      fillDealItemForm(dealItem);
      if (byId('dealItemModalTitle')) byId('dealItemModalTitle').innerHTML = '<i class="fas fa-pen-to-square"></i> Edit Deal Item';
      if (byId('dealItemModalSub')) byId('dealItemModalSub').textContent = 'Update an existing deal item, payout rule, or receivable/payable entry.';
      if (byId('dealItemSaveBtn')) byId('dealItemSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Changes';
      byId('dealItemDeleteBtn')?.classList.remove('hidden');
    } else {
      if (profile && byId('di_partner_profile_id')) byId('di_partner_profile_id').value = profile.id;
      if (client && byId('di_signed_client_id')) byId('di_signed_client_id').value = client.id;
      if (byId('dealItemModalTitle')) byId('dealItemModalTitle').innerHTML = '<i class="fas fa-list-check"></i> Add Deal Item';
      if (byId('dealItemModalSub')) byId('dealItemModalSub').textContent = 'Track a partner fee, payout, or client-linked receivable/payable.';
      if (byId('dealItemSaveBtn')) byId('dealItemSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Deal Item';
      byId('dealItemDeleteBtn')?.classList.add('hidden');
    }
    syncDealItemInputs();
    byId('dealItemModal')?.classList.remove('hidden');
  }

  function openTransactionModal(transactionId = null) {
    resetTransactionForm();
    populateSignedClientsModalOptions();
    const client = (state.signedClients || []).find((item) => item.id === state.selectedClientId) || null;
    const profile = client ? partnerProfileByAdminId(client.owner_admin_id) : currentScopePartnerProfiles()[0] || visiblePartnerProfiles()[0] || null;
    const tx = transactionId ? ((state.transactions || []).find((item) => item.id === transactionId) || null) : null;
    state.editingTransactionId = tx?.id || null;
    if (tx) {
      fillTransactionForm(tx);
      if (byId('transactionModalTitle')) byId('transactionModalTitle').innerHTML = '<i class="fas fa-pen-to-square"></i> Edit Transaction';
      if (byId('transactionModalSub')) byId('transactionModalSub').textContent = 'Update the ledger entry, linked deal item, and payment details.';
      if (byId('transactionSaveBtn')) byId('transactionSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Changes';
      byId('transactionDeleteBtn')?.classList.remove('hidden');
    } else {
      if (profile && byId('tx_partner_profile_id')) byId('tx_partner_profile_id').value = profile.id;
      if (client && byId('tx_signed_client_id')) byId('tx_signed_client_id').value = client.id;
      if (byId('transactionModalTitle')) byId('transactionModalTitle').innerHTML = '<i class="fas fa-money-bill-transfer"></i> Log Transaction';
      if (byId('transactionModalSub')) byId('transactionModalSub').textContent = 'Record money in or out and tie it to the correct partner and deal item.';
      if (byId('transactionSaveBtn')) byId('transactionSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Transaction';
      byId('transactionDeleteBtn')?.classList.add('hidden');
    }
    syncTransactionInputs();
    byId('transactionModal')?.classList.remove('hidden');
  }

  async function saveSignedClient() {
    try {
      const editingId = state.editingClientId;
      const payload = {
        owner_admin_id: byId('sc_owner_admin_id')?.value || null,
        client_name: byId('sc_client_name')?.value.trim(),
        company_name: byId('sc_company_name')?.value.trim() || null,
        phone: byId('sc_phone')?.value.trim() || null,
        email: byId('sc_email')?.value.trim() || null,
        property_address: byId('sc_property_address')?.value.trim(),
        city: byId('sc_city')?.value.trim(),
        state: byId('sc_state')?.value.trim().toUpperCase(),
        zip: byId('sc_zip')?.value.trim() || null,
        service_type: byId('sc_service_type')?.value.trim() || null,
        signed_date: byId('sc_signed_date')?.value,
        job_status: byId('sc_job_status')?.value,
        client_status: byId('sc_client_status')?.value,
        contract_value: Number(byId('sc_contract_value')?.value || 0),
        profit_amount: Number(byId('sc_profit_amount')?.value || 0),
        notes_private: byId('sc_notes_private')?.value.trim() || null
      };

      if (!payload.client_name || !payload.property_address || !payload.city || !payload.state || !payload.signed_date || !payload.owner_admin_id) {
        throw new Error('Client name, address, city, state, signed date, and partner owner are required.');
      }

      signedStatus(editingId ? 'Updating signed client…' : 'Saving signed client…');
      let result;
      if (editingId) {
        result = await window.sb.from('crm_signed_clients').update(payload).eq('id', editingId).select('id').single();
      } else {
        result = await window.sb.from('crm_signed_clients').insert({ ...payload, created_by: window.currentUser.id }).select('id').single();
      }
      if (result.error) throw result.error;
      const savedId = result.data?.id || editingId || null;
      if (typeof window.closeAllModals === 'function') window.closeAllModals();
      resetSignedClientForm();
      await loadSignedClientsViewData({ force: true });
      if (savedId) selectSignedClient(savedId);
      signedStatus(editingId ? 'Signed client updated successfully.' : 'Signed client created successfully.', 'success');
    } catch (error) {
      signedStatus('Could not save signed client: ' + escape(error.message || 'Unknown error'), 'error');
    }
  }

  async function saveDealItem() {
    try {
      const editingId = state.editingDealItemId;
      const partnerProfileId = byId('di_partner_profile_id')?.value || '';
      const profile = partnerProfileById(partnerProfileId);
      const calculationType = byId('di_calculation_type')?.value;
      const payload = {
        owner_admin_id: profile?.admin_user_id || window.currentUser.id,
        signed_client_id: byId('di_item_scope')?.value === 'partner' ? null : (byId('di_signed_client_id')?.value || null),
        partner_profile_id: partnerProfileId,
        item_scope: byId('di_item_scope')?.value,
        item_name: byId('di_item_name')?.value.trim(),
        item_type: byId('di_item_type')?.value,
        direction: byId('di_direction')?.value,
        calculation_type: calculationType,
        flat_amount: ['percent_profit', 'percent_revenue'].includes(calculationType) ? null : Number(byId('di_flat_amount')?.value || 0),
        percent_rate: ['percent_profit', 'percent_revenue'].includes(calculationType) ? Number(byId('di_percent_rate')?.value || 0) : null,
        quantity: Number(byId('di_quantity')?.value || 1),
        status: byId('di_status')?.value,
        applies_on: byId('di_applies_on')?.value || null,
        notes: byId('di_notes')?.value.trim() || null
      };

      if (!payload.partner_profile_id || !payload.item_name) throw new Error('Partner and item name are required.');
      if (payload.item_scope === 'client' && !payload.signed_client_id) throw new Error('Choose a signed client for client-scoped deal items.');

      signedStatus(editingId ? 'Updating deal item…' : 'Saving deal item…');
      let result;
      if (editingId) {
        result = await window.sb.from('crm_partner_deal_items').update(payload).eq('id', editingId).select('id').single();
      } else {
        result = await window.sb.from('crm_partner_deal_items').insert({ ...payload, created_by: window.currentUser.id }).select('id').single();
      }
      if (result.error) throw result.error;
      if (typeof window.closeAllModals === 'function') window.closeAllModals();
      const savedId = result.data?.id || editingId || null;
      resetDealItemForm();
      await loadSignedClientsViewData({ force: true });
      if (savedId && state.selectedClientId) renderSignedClientsDetails(state.selectedClientId);
      signedStatus(editingId ? 'Deal item updated successfully.' : 'Deal item saved successfully.', 'success');
    } catch (error) {
      signedStatus('Could not save deal item: ' + escape(error.message || 'Unknown error'), 'error');
    }
  }

  async function deleteDealItem(dealItemId = state.editingDealItemId) {
    try {
      const itemId = dealItemId || null;
      if (!itemId) throw new Error('No deal item selected.');
      const linkedTransactions = (state.transactions || []).filter((tx) => tx.deal_item_id === itemId);
      const warning = linkedTransactions.length
        ? `This deal item has ${linkedTransactions.length} linked transaction${linkedTransactions.length === 1 ? '' : 's'}. Deleting it will keep those transactions but unlink them from this deal item. Continue?`
        : 'Delete this deal item? This cannot be undone.';
      if (typeof window.confirm === 'function' && !window.confirm(warning)) return;

      signedStatus('Deleting deal item…');
      if (linkedTransactions.length) {
        const unlinkRes = await window.sb.from('crm_partner_transactions').update({ deal_item_id: null }).eq('deal_item_id', itemId);
        if (unlinkRes.error) throw unlinkRes.error;
      }
      const deleteRes = await window.sb.from('crm_partner_deal_items').delete().eq('id', itemId);
      if (deleteRes.error) throw deleteRes.error;
      if (typeof window.closeAllModals === 'function') window.closeAllModals();
      resetDealItemForm();
      await loadSignedClientsViewData({ force: true });
      if (state.selectedClientId) renderSignedClientsDetails(state.selectedClientId);
      signedStatus('Deal item deleted successfully.', 'success');
    } catch (error) {
      signedStatus('Could not delete deal item: ' + escape(error.message || 'Unknown error'), 'error');
    }
  }

  async function saveTransaction() {
    try {
      const editingId = state.editingTransactionId;
      const partnerProfileId = byId('tx_partner_profile_id')?.value || '';
      const profile = partnerProfileById(partnerProfileId);
      const payload = {
        owner_admin_id: profile?.admin_user_id || window.currentUser.id,
        partner_profile_id: partnerProfileId,
        signed_client_id: byId('tx_signed_client_id')?.value || null,
        deal_item_id: byId('tx_deal_item_id')?.value || null,
        direction: byId('tx_direction')?.value,
        transaction_type: byId('tx_transaction_type')?.value,
        transaction_date: byId('tx_transaction_date')?.value,
        amount: Number(byId('tx_amount')?.value || 0),
        payment_method: byId('tx_payment_method')?.value,
        reference_number: byId('tx_reference_number')?.value.trim() || null,
        status: byId('tx_status')?.value,
        notes: byId('tx_notes')?.value.trim() || null
      };

      if (!payload.partner_profile_id || !payload.transaction_date || !(payload.amount > 0)) throw new Error('Partner, date, and amount greater than zero are required.');

      signedStatus(editingId ? 'Updating transaction…' : 'Saving transaction…');
      let result;
      if (editingId) {
        result = await window.sb.from('crm_partner_transactions').update(payload).eq('id', editingId).select('id').single();
      } else {
        result = await window.sb.from('crm_partner_transactions').insert({ ...payload, recorded_by: window.currentUser.id }).select('id').single();
      }
      if (result.error) throw result.error;
      if (typeof window.closeAllModals === 'function') window.closeAllModals();
      resetTransactionForm();
      await loadSignedClientsViewData({ force: true });
      if (state.selectedClientId) renderSignedClientsDetails(state.selectedClientId);
      signedStatus(editingId ? 'Transaction updated successfully.' : 'Transaction saved successfully.', 'success');
    } catch (error) {
      signedStatus('Could not save transaction: ' + escape(error.message || 'Unknown error'), 'error');
    }
  }

  async function deleteTransaction(transactionId = state.editingTransactionId) {
    try {
      const txId = transactionId || null;
      if (!txId) throw new Error('No transaction selected.');
      if (typeof window.confirm === 'function' && !window.confirm('Delete this transaction? This cannot be undone.')) return;
      signedStatus('Deleting transaction…');
      const result = await window.sb.from('crm_partner_transactions').delete().eq('id', txId);
      if (result.error) throw result.error;
      if (typeof window.closeAllModals === 'function') window.closeAllModals();
      resetTransactionForm();
      await loadSignedClientsViewData({ force: true });
      if (state.selectedClientId) renderSignedClientsDetails(state.selectedClientId);
      signedStatus('Transaction deleted successfully.', 'success');
    } catch (error) {
      signedStatus('Could not delete transaction: ' + escape(error.message || 'Unknown error'), 'error');
    }
  }

  function exportSignedClientsCsv() {
    const rows = currentScopeSignedClients();
    if (!rows.length) {
      signedStatus('No signed clients available for export under the current filters.', 'warning');
      return;
    }
    const fm = financialMap();
    const csvRows = [
      ['Client', 'Partner', 'Signed Date', 'Address', 'Service Type', 'Revenue', 'Profit', 'Incoming', 'Outgoing', 'Net', 'Job Status', 'Financial Status']
    ];
    rows.forEach((row) => {
      const f = fm.get(row.id) || {};
      csvRows.push([
        row.client_name || '',
        partnerNameForAdmin(row.owner_admin_id),
        row.signed_date || '',
        [row.property_address, row.city, row.state, row.zip].filter(Boolean).join(', '),
        row.service_type || '',
        row.contract_value || 0,
        row.profit_amount || 0,
        f.incoming_expected || 0,
        f.outgoing_expected || 0,
        f.net_expected || 0,
        row.job_status || '',
        f.financial_status || ''
      ]);
    });
    const csv = csvRows.map((cols) => cols.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'signed-clients-export.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function bindSignedClientsEvents() {
    [
      'signedClientsSearch',
      'signedClientsClientStatusFilter',
      'signedClientsFinancialStatusFilter',
      'signedClientsDirectionFilter',
      'signedClientsPaymentMethodFilter',
      'signedClientsSortBy'
    ].forEach((id) => byId(id)?.addEventListener(id === 'signedClientsSearch' ? 'input' : 'change', () => renderSignedClientsTable()));

    byId('signedClientsPartnerFilter')?.addEventListener('change', () => {
      const checkbox = byId('signedClientsSelectedOnly');
      if (checkbox) checkbox.checked = Boolean(byId('signedClientsPartnerFilter')?.value);
      renderSignedClientsTable();
      populateSignedClientsModalOptions();
    });

    byId('signedClientsSelectedOnly')?.addEventListener('change', () => {
      renderSignedClientsTable();
      populateSignedClientsModalOptions();
    });

    byId('signedClientsRefreshBtn')?.addEventListener('click', () => loadSignedClientsViewData({ force: true }));
    byId('signedClientsAddBtn')?.addEventListener('click', () => openSignedClientModal());
    byId('signedClientsEditBtn')?.addEventListener('click', () => openSignedClientModal(state.selectedClientId));
    byId('signedClientsAllTransactionsBtn')?.addEventListener('click', () => selectSignedClient(null));
    byId('signedClientsAddDealBtn')?.addEventListener('click', () => openDealItemModal());
    byId('signedClientsLogTxnBtn')?.addEventListener('click', openTransactionModal);
    byId('signedClientsAddDealInlineBtn')?.addEventListener('click', () => openDealItemModal());
    byId('signedClientsLogTxnInlineBtn')?.addEventListener('click', openTransactionModal);
    byId('signedClientsExportBtn')?.addEventListener('click', exportSignedClientsCsv);
    byId('signedClientSaveBtn')?.addEventListener('click', saveSignedClient);
    byId('dealItemSaveBtn')?.addEventListener('click', saveDealItem);
    byId('dealItemDeleteBtn')?.addEventListener('click', () => deleteDealItem());
    byId('transactionSaveBtn')?.addEventListener('click', saveTransaction);
    byId('transactionDeleteBtn')?.addEventListener('click', () => deleteTransaction());

    byId('tx_partner_profile_id')?.addEventListener('change', syncTransactionInputs);
    byId('tx_signed_client_id')?.addEventListener('change', syncTransactionInputs);
    byId('tx_deal_item_id')?.addEventListener('change', syncTransactionInputs);
    byId('di_partner_profile_id')?.addEventListener('change', populateSignedClientsModalOptions);
    byId('di_item_scope')?.addEventListener('change', syncDealItemInputs);
    byId('di_calculation_type')?.addEventListener('change', syncDealItemInputs);
  }

  bindSignedClientsEvents();
  syncDealItemInputs();
  syncTransactionInputs();
  window.addEventListener('crm-call-log-updated', () => {
    if (!state.loaded) return;
    loadSignedClientsViewData({ force: true }).catch(() => null);
  });
  window.loadSignedClientsViewData = loadSignedClientsViewData;
})();
