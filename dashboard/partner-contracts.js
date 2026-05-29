(function () {
  const state = {
    loaded: false,
    loading: false,
    partnerProfiles: [],
    templates: [],
    requests: [],
    recentEvents: [],
    requestDetails: new Map(),
    templateDetails: new Map(),
    selectedRequestId: null,
    selectedTemplateId: null
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

  function canUsePartnerContracts() {
    return typeof window.isAdmin === 'function' && window.isAdmin();
  }

  function statusTone(status) {
    const value = String(status || 'draft').toLowerCase();
    if (['signed', 'ready'].includes(value)) return 'status-Signed';
    if (['declined', 'voided', 'expired', 'archived'].includes(value)) return 'status-Lost';
    if (['viewed', 'partially_signed'].includes(value)) return 'status-Scheduled';
    if (['sent', 'queued'].includes(value)) return 'status-Callback';
    return 'status-New';
  }

  function prettyLabel(value) {
    return String(value || '—').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function slugify(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function formatDateTimeSafe(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function formatDateSafe(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function buildSigningUrl(token) {
    const safeToken = String(token || '').trim();
    if (!safeToken) return '';
    return `${window.location.origin}/contract-signing/index.html?token=${encodeURIComponent(safeToken)}`;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read file.'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }

  function partnerContractsStatus(message, type = '') {
    const el = byId('partnerContractsStatus');
    if (!el) return;
    if (!message) {
      el.className = 'agent-admin-status hidden';
      el.innerHTML = '';
      return;
    }
    el.className = 'agent-admin-status' + (type ? ' ' + type : '');
    el.innerHTML = message;
  }

  async function partnerContractsFetch(url, options = {}) {
    const { data: { session } } = await window.sb.auth.getSession();
    if (!session?.access_token) throw new Error('You are not signed in.');
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
        ...(options.headers || {})
      }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || 'DocuMike request failed.');
    return json;
  }

  async function fetchBootstrap(partnerProfileId = '') {
    const url = new URL('/.netlify/functions/partner-contracts', window.location.origin);
    url.searchParams.set('resource', 'bootstrap');
    if (partnerProfileId) url.searchParams.set('partner_profile_id', partnerProfileId);
    return partnerContractsFetch(url.toString());
  }

  async function fetchRequestDetails(requestId) {
    const url = new URL('/.netlify/functions/partner-contracts', window.location.origin);
    url.searchParams.set('resource', 'request');
    url.searchParams.set('id', requestId);
    return partnerContractsFetch(url.toString());
  }

  async function fetchTemplateDetails(templateId) {
    const url = new URL('/.netlify/functions/partner-contracts', window.location.origin);
    url.searchParams.set('resource', 'template');
    url.searchParams.set('id', templateId);
    return partnerContractsFetch(url.toString());
  }

  async function partnerContractsAction(action, payload = {}) {
    return partnerContractsFetch('/.netlify/functions/partner-contracts', {
      method: 'POST',
      body: JSON.stringify({ action, ...payload })
    });
  }

  function templateModal() {
    return byId('partnerContractsTemplateModal');
  }

  function resetTemplateModalForm() {
    if (byId('pct_partner_profile_id')) byId('pct_partner_profile_id').value = currentPartnerFilter() || byId('pct_partner_profile_id').value || '';
    if (byId('pct_template_name')) byId('pct_template_name').value = '';
    if (byId('pct_template_slug')) {
      byId('pct_template_slug').value = '';
      byId('pct_template_slug').dataset.manual = 'false';
    }
    if (byId('pct_template_description')) byId('pct_template_description').value = '';
    if (byId('pct_template_category')) byId('pct_template_category').value = '';
    if (byId('pct_version_label')) byId('pct_version_label').value = 'v1';
    if (byId('pct_version_status')) byId('pct_version_status').value = 'draft';
    if (byId('pct_source_file_name')) byId('pct_source_file_name').value = '';
    if (byId('pct_source_file_url')) byId('pct_source_file_url').value = '';
    if (byId('pct_source_file_mime_type')) byId('pct_source_file_mime_type').value = '';
    if (byId('pct_storage_object_path')) byId('pct_storage_object_path').value = '';
    if (byId('pct_version_notes')) byId('pct_version_notes').value = '';
    if (byId('pct_field_manifest_json')) byId('pct_field_manifest_json').value = '[]';
    if (byId('pct_merge_tokens_json')) byId('pct_merge_tokens_json').value = '[]';
    if (byId('pct_file_upload')) byId('pct_file_upload').value = '';
    if (byId('partnerContractsTemplateModalTitle')) byId('partnerContractsTemplateModalTitle').innerHTML = '<i class="fas fa-upload"></i> Create Template + Version';
    if (byId('partnerContractsTemplateSaveBtn')) {
      byId('partnerContractsTemplateSaveBtn').disabled = false;
      byId('partnerContractsTemplateSaveBtn').innerHTML = '<i class="fas fa-save"></i> Create Template + Version';
    }
  }

  function populateTemplateModalPartners() {
    const select = byId('pct_partner_profile_id');
    if (!select) return;
    const partners = visiblePartners();
    const previous = select.value;
    select.innerHTML = '<option value="">Select partner</option>' + partners.map((partner) => `<option value="${partner.id}">${escape(partner.display_name || partner.business_name || 'Partner')}</option>`).join('');
    const preferred = currentPartnerFilter() || previous || partners[0]?.id || '';
    if ([...select.options].some((option) => option.value === preferred)) select.value = preferred;
  }

  function openTemplateCreateModal() {
    populateTemplateModalPartners();
    resetTemplateModalForm();
    templateModal()?.classList.remove('hidden');
  }

  function parseJsonField(id, fallback) {
    const raw = String(byId(id)?.value || '').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  }

  async function saveTemplateAndVersion() {
    const saveBtn = byId('partnerContractsTemplateSaveBtn');
    const partnerProfileId = String(byId('pct_partner_profile_id')?.value || '').trim();
    const templateName = String(byId('pct_template_name')?.value || '').trim();
    if (!partnerProfileId) {
      partnerContractsStatus('Choose a partner before creating the template.', 'warning');
      return;
    }
    if (!templateName) {
      partnerContractsStatus('Template name is required.', 'warning');
      return;
    }

    try {
      const fieldManifest = parseJsonField('pct_field_manifest_json', []);
      const mergeTokens = parseJsonField('pct_merge_tokens_json', []);
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
      }
      partnerContractsStatus('Creating template and first version…');

      const templateRes = await partnerContractsAction('create_template', {
        partner_profile_id: partnerProfileId,
        template_name: templateName,
        template_slug: String(byId('pct_template_slug')?.value || '').trim(),
        description: String(byId('pct_template_description')?.value || '').trim(),
        category: String(byId('pct_template_category')?.value || '').trim()
      });

      const templateId = templateRes?.template?.id;
      if (!templateId) throw new Error('Template was created but no template id was returned.');

      const versionRes = await partnerContractsAction('create_template_version', {
        template_id: templateId,
        version_label: String(byId('pct_version_label')?.value || '').trim() || 'v1',
        status: String(byId('pct_version_status')?.value || '').trim() || 'draft',
        source_file_name: String(byId('pct_source_file_name')?.value || '').trim(),
        source_file_url: String(byId('pct_source_file_url')?.value || '').trim(),
        source_file_mime_type: String(byId('pct_source_file_mime_type')?.value || '').trim(),
        storage_object_path: String(byId('pct_storage_object_path')?.value || '').trim(),
        notes: String(byId('pct_version_notes')?.value || '').trim(),
        field_manifest: fieldManifest,
        merge_tokens: mergeTokens
      });

      const fileInput = byId('pct_file_upload');
      const file = fileInput?.files?.[0];
      if (file) {
        try {
          partnerContractsStatus('Uploading template file to Supabase Storage…');
          const dataUrl = await readFileAsDataUrl(file);
          await partnerContractsAction('upload_template_file', {
            template_id: templateId,
            template_version_id: versionRes?.templateVersion?.id || '',
            filename: file.name,
            data_url: dataUrl
          });
          partnerContractsStatus('Template file uploaded to Supabase Storage.', 'success');
        } catch (uploadError) {
          partnerContractsStatus('Template created, but file upload failed: ' + escape(uploadError.message), 'warning');
        }
      }

      window.closeAllModals?.();
      state.loaded = false;
      await loadPartnerContractsViewData({ force: true });
      state.selectedTemplateId = templateId;
      state.selectedRequestId = null;
      await ensureTemplateDetails(templateId).catch(() => null);
      renderAll();
      partnerContractsStatus(`Created template <strong>${escape(templateName)}</strong> with its first version.`, 'success');
    } catch (error) {
      partnerContractsStatus('Could not create template/version: ' + escape(error.message), 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Create Template + Version';
      }
    }
  }

  function currentPartnerFilter() {
    const selectedOnly = byId('partnerContractsSelectedOnly');
    const select = byId('partnerContractsPartnerFilter');
    if (!selectedOnly?.checked) return '';
    return String(select?.value || '');
  }

  function visiblePartners() {
    return [...(state.partnerProfiles || [])];
  }

  function currentTemplates() {
    const owner = currentPartnerFilter();
    return [...(state.templates || [])].filter((row) => !owner || row.partner_profile_id === owner);
  }

  function currentRequests() {
    const owner = currentPartnerFilter();
    return [...(state.requests || [])].filter((row) => !owner || row.partner_profile_id === owner);
  }

  function expiringSoonCount(rows) {
    const inSevenDays = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return rows.filter((row) => row.expires_at && new Date(row.expires_at).getTime() <= inSevenDays && !['signed', 'declined', 'voided', 'expired'].includes(String(row.status || ''))).length;
  }

  function renderScopeControls() {
    const wrap = byId('partnerContractsScopeWrap');
    const select = byId('partnerContractsPartnerFilter');
    const checkbox = byId('partnerContractsSelectedOnly');
    if (!wrap || !select || !checkbox) return;
    const partners = visiblePartners();
    const previous = select.value;
    select.innerHTML = '<option value="">All partners</option>' + partners.map((partner) => `<option value="${partner.id}">${escape(partner.display_name || partner.business_name || 'Partner')}</option>`).join('');
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    wrap.classList.toggle('hidden', !partners.length);
    if (partners.length === 1 && !checkbox.checked) {
      select.value = partners[0].id;
      checkbox.checked = true;
    }
  }

  function renderKpis() {
    const templates = currentTemplates();
    const requests = currentRequests();
    const awaiting = requests.filter((row) => ['sent', 'viewed', 'partially_signed'].includes(String(row.status || ''))).length;
    const signed = requests.filter((row) => String(row.status || '') === 'signed').length;
    const declined = requests.filter((row) => ['declined', 'voided', 'expired'].includes(String(row.status || ''))).length;
    if (byId('pcKpiTemplates')) byId('pcKpiTemplates').textContent = String(templates.length || 0);
    if (byId('pcKpiDraft')) byId('pcKpiDraft').textContent = String(requests.filter((row) => String(row.status || '') === 'draft').length || 0);
    if (byId('pcKpiAwaiting')) byId('pcKpiAwaiting').textContent = String(awaiting || 0);
    if (byId('pcKpiSigned')) byId('pcKpiSigned').textContent = String(signed || 0);
    if (byId('pcKpiDeclined')) byId('pcKpiDeclined').textContent = String(declined || 0);
    if (byId('pcKpiExpiring')) byId('pcKpiExpiring').textContent = String(expiringSoonCount(requests) || 0);
  }

  function renderTemplatesTable() {
    const tbody = byId('partnerContractsTemplatesBody');
    const count = byId('partnerContractsTemplatesCount');
    if (!tbody || !count) return;
    const rows = currentTemplates();
    count.textContent = `${rows.length} template${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="loading-row">No DocuMike templates yet. Use <strong>Add Template</strong> to create the first template and version for a partner.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((row) => `
      <tr class="partner-contracts-row ${state.selectedTemplateId === row.id ? 'partner-contracts-row-active' : ''}" data-template-id="${escape(row.id)}">
        <td><button type="button" class="partner-contracts-link-btn" data-template-open="${escape(row.id)}">${escape(row.template_name || 'Untitled Template')}</button></td>
        <td>${escape((state.partnerProfiles.find((partner) => partner.id === row.partner_profile_id) || {}).display_name || 'Partner')}</td>
        <td>${escape(String(row.latest_version_number || 0))}</td>
        <td><span class="status-pill ${statusTone(row.is_active ? 'ready' : 'archived')}">${escape(row.is_active ? 'Active' : 'Inactive')}</span></td>
        <td>${escape(formatDateTimeSafe(row.updated_at))}</td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-template-open]').forEach((btn) => {
      btn.addEventListener('click', () => selectTemplate(btn.dataset.templateOpen));
    });
  }

  function renderRequestsTable() {
    const tbody = byId('partnerContractsRequestsBody');
    const count = byId('partnerContractsRequestsCount');
    if (!tbody || !count) return;
    const rows = currentRequests();
    count.textContent = `${rows.length} request${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No contract requests yet. The scaffold is ready for request creation in the next small build step.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((row) => `
      <tr class="partner-contracts-row ${state.selectedRequestId === row.id ? 'partner-contracts-row-active' : ''}" data-request-id="${escape(row.id)}">
        <td><button type="button" class="partner-contracts-link-btn" data-request-open="${escape(row.id)}">${escape(row.request_title || 'Untitled Request')}</button></td>
        <td>${escape(row.partner_name || 'Partner')}</td>
        <td>${escape(row.client_name || row.client_email || '—')}</td>
        <td><span class="status-pill ${statusTone(row.status)}">${escape(prettyLabel(row.status || 'draft'))}</span></td>
        <td>${escape(`${Number(row.signed_count || 0)}/${Number(row.signer_count || 0)}`)}</td>
        <td>${escape(row.next_signer_name || '—')}</td>
        <td>${escape(formatDateSafe(row.updated_at || row.created_at))}</td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-request-open]').forEach((btn) => {
      btn.addEventListener('click', () => selectRequest(btn.dataset.requestOpen));
    });
  }

  async function ensureTemplateDetails(templateId) {
    if (!templateId) return null;
    if (state.templateDetails.has(templateId)) return state.templateDetails.get(templateId);
    const result = await fetchTemplateDetails(templateId);
    state.templateDetails.set(templateId, result);
    return result;
  }

  async function ensureRequestDetails(requestId) {
    if (!requestId) return null;
    if (state.requestDetails.has(requestId)) return state.requestDetails.get(requestId);
    const result = await fetchRequestDetails(requestId);
    state.requestDetails.set(requestId, result);
    return result;
  }

  function renderRequestDetail(detail) {
    const title = byId('partnerContractsDetailTitle');
    const badge = byId('partnerContractsDetailBadge');
    const body = byId('partnerContractsDetailBody');
    if (!title || !badge || !body) return;
    const request = detail?.request || null;
    const signers = detail?.signers || [];
    const events = detail?.events || [];
    if (!request) {
      title.innerHTML = '<i class="fas fa-rectangle-list"></i> Details';
      badge.className = 'status-pill status-New';
      badge.textContent = 'Select a request';
      body.innerHTML = '<div class="empty-state"><i class="fas fa-file-contract"></i><p>Select a contract request to inspect signer order, timeline, and latest activity.</p></div>';
      return;
    }
    title.innerHTML = `<i class="fas fa-paper-plane"></i> ${escape(request.request_title || 'Contract Request')}`;
    badge.className = `status-pill ${statusTone(request.status)}`;
    badge.textContent = prettyLabel(request.status || 'draft');
    const isClosed = ['voided', 'expired', 'signed', 'declined'].includes(String(request.status || ''));
    const isSigned = String(request.status || '') === 'signed';
    const hasSignedPdf = Boolean(request.signed_pdf_path);
    const hasAuditPdf = Boolean(request.audit_pdf_path);
    body.innerHTML = `
      <div class="partner-contracts-detail-actions">
        <button class="btn-secondary" type="button" data-request-action="open-launchpad"><i class="fas fa-envelope-open-text"></i> Email Launchpad</button>
        <button class="btn-secondary" type="button" data-request-action="resend-emails" ${isClosed ? 'disabled' : ''}><i class="fas fa-paper-plane"></i> Resend Emails</button>
        <button class="btn-secondary" type="button" data-request-action="copy-all-links"><i class="fas fa-link"></i> Copy All Links</button>
        <button class="btn-secondary" type="button" data-request-action="generate-pdf" ${isSigned ? '' : 'disabled'}><i class="fas fa-file-pdf"></i> ${hasSignedPdf ? 'Regenerate Signed PDF' : 'Generate Signed PDF'}</button>
        <button class="btn-secondary" type="button" data-request-action="download-signed-pdf" ${hasSignedPdf ? '' : 'disabled'}><i class="fas fa-download"></i> Download Signed PDF</button>
        <button class="btn-secondary" type="button" data-request-action="download-audit-pdf" ${hasAuditPdf ? '' : 'disabled'}><i class="fas fa-file-lines"></i> Download Audit PDF</button>
        <button class="btn-secondary" type="button" data-request-action="regenerate-rendered"><i class="fas fa-magic-wand-sparkles"></i> ${request.rendered_pdf_path ? 'Regenerate' : 'Generate'} Rendered Contract</button>
        <button class="btn-secondary" type="button" data-request-action="download-rendered-pdf" ${request.rendered_pdf_path ? '' : 'disabled'}><i class="fas fa-file-contract"></i> Download Rendered Contract</button>
        <button class="btn-secondary" type="button" data-request-action="cancel-request" ${(isClosed || String(request.status || '') === 'cancelled') ? 'disabled' : ''} title="Mark this request as cancelled. Signing links stop working. Audit history is kept."><i class="fas fa-ban"></i> Cancel Request</button>
        <button class="btn-danger" type="button" data-request-action="delete-request" title="Permanently delete this request from the database. This cannot be undone."><i class="fas fa-trash"></i> Delete Request</button>
      </div>
      <div class="partner-contracts-detail-grid">
        <div class="settings-card partner-contracts-mini-card">
          <h3>Request Snapshot</h3>
          <div class="partner-contracts-info-list">
            <div class="partner-contracts-info-row"><span>Partner</span><strong>${escape(request.partner_name || request.partner_profile_id || '—')}</strong></div>
            <div class="partner-contracts-info-row"><span>Client</span><strong>${escape(request.client_name || request.client_email || '—')}</strong></div>
            <div class="partner-contracts-info-row"><span>Template</span><strong>${escape(request.template_name || '—')}</strong></div>
            <div class="partner-contracts-info-row"><span>Updated</span><strong>${escape(formatDateTimeSafe(request.updated_at || request.created_at))}</strong></div>
          </div>
        </div>
        <div class="settings-card partner-contracts-mini-card">
          <h3>Signer Order</h3>
          <div class="partner-contracts-signer-stack">
            ${signers.length ? signers.map((signer) => {
              const signingUrl = buildSigningUrl(signer.signing_token);
              const canAct = ['sent', 'viewed', 'queued', 'draft'].includes(String(signer.status || ''));
              return `
              <div class="partner-contracts-signer-chip" data-signer-id="${escape(signer.id)}">
                <div>
                  <strong>${escape(signer.signer_name || 'Signer')}</strong>
                  <small>${escape(prettyLabel(signer.signer_role || 'client'))} · ${escape(signer.signer_email || '—')}</small>
                  ${signer.signing_token ? `<small><a class="partner-contracts-inline-link" href="${escape(signingUrl)}" target="_blank" rel="noopener noreferrer">Open signing page ↗</a></small>` : ''}
                  <div class="partner-contracts-signer-actions-inline">
                    <button type="button" class="btn-secondary btn-inline" data-signer-action="copy-link" data-signer-id="${escape(signer.id)}" data-signing-url="${encodeURIComponent(signingUrl)}" ${signingUrl ? '' : 'disabled'}><i class="fas fa-link"></i> Copy Link</button>
                    <button type="button" class="btn-secondary btn-inline" data-signer-action="open-draft" data-signer-id="${escape(signer.id)}" ${canAct && signer.signer_email ? '' : 'disabled'}><i class="fas fa-envelope"></i> Email Draft</button>
                    <button type="button" class="btn-secondary btn-inline" data-signer-action="sign-in-person" data-signer-id="${escape(signer.id)}" ${isClosed || ['signed','declined'].includes(String(signer.status || '')) ? 'disabled' : ''}><i class="fas fa-mobile-screen"></i> Sign In Person</button>
                  </div>
                </div>
                <span class="status-pill ${statusTone(signer.status)}">${escape(prettyLabel(signer.status || 'draft'))}</span>
              </div>
            `;
            }).join('') : '<div class="empty-state small"><p>No signers attached yet.</p></div>'}
          </div>
        </div>
      </div>
      <div class="settings-card partner-contracts-mini-card">
        <div class="partner-contracts-section-head"><h3><i class="fas fa-timeline"></i> Recent Activity</h3></div>
        <div class="partner-contracts-event-list">
          ${events.length ? events.slice(0, 12).map((event) => {
            const data = event.event_data || {};
            const note = data.error ? ` · ${escape(String(data.error))}` : data.signer_name ? ` · ${escape(String(data.signer_name))}` : '';
            return `
              <div class="partner-contracts-event-item">
                <strong>${escape(prettyLabel(event.event_type || 'event'))}</strong>
                <p>${escape(formatDateTimeSafe(event.created_at))}${note}</p>
              </div>
            `;
          }).join('') : '<div class="empty-state small"><p>No events logged yet.</p></div>'}
        </div>
      </div>
    `;
  }

  function renderTemplateDetail(detail) {
    const title = byId('partnerContractsDetailTitle');
    const badge = byId('partnerContractsDetailBadge');
    const body = byId('partnerContractsDetailBody');
    if (!title || !badge || !body) return;
    const template = detail?.template || null;
    const versions = detail?.versions || [];
    if (!template) {
      renderRequestDetail(null);
      return;
    }
    title.innerHTML = `<i class="fas fa-layer-group"></i> ${escape(template.template_name || 'Template')}`;
    badge.className = `status-pill ${statusTone(template.is_active ? 'ready' : 'archived')}`;
    badge.textContent = template.is_active ? 'Active' : 'Inactive';
    body.innerHTML = `
      <div class="partner-contracts-detail-actions">
        <button class="btn-secondary" type="button" data-template-action="edit" data-template-id="${escape(template.id)}"><i class="fas fa-pen-to-square"></i> Edit Template</button>
        <button class="btn-secondary" type="button" data-template-action="toggle-active" data-template-id="${escape(template.id)}" data-current-active="${template.is_active ? '1' : '0'}"><i class="fas fa-${template.is_active ? 'box-archive' : 'box-open'}"></i> ${template.is_active ? 'Archive' : 'Reactivate'} Template</button>
        <button class="btn-danger" type="button" data-template-action="delete" data-template-id="${escape(template.id)}"><i class="fas fa-trash"></i> Delete Template</button>
      </div>
      <div class="partner-contracts-detail-grid">
        <div class="settings-card partner-contracts-mini-card">
          <h3>Template Snapshot</h3>
          <div class="partner-contracts-info-list">
            <div class="partner-contracts-info-row"><span>Partner</span><strong>${escape((state.partnerProfiles.find((partner) => partner.id === template.partner_profile_id) || {}).display_name || '—')}</strong></div>
            <div class="partner-contracts-info-row"><span>Slug</span><strong>${escape(template.template_slug || '—')}</strong></div>
            <div class="partner-contracts-info-row"><span>Versions</span><strong>${escape(String(template.latest_version_number || 0))}</strong></div>
            <div class="partner-contracts-info-row"><span>Updated</span><strong>${escape(formatDateTimeSafe(template.updated_at || template.created_at))}</strong></div>
          </div>
        </div>
        <div class="settings-card partner-contracts-mini-card">
          <h3>Version Stack</h3>
          <div class="partner-contracts-event-list">
            ${versions.length ? versions.map((version) => `
              <div class="partner-contracts-event-item partner-contracts-version-item">
                <div>
                  <strong>${escape(version.version_label || `v${version.version_number || 0}`)}</strong>
                  <p>${escape(prettyLabel(version.status || 'draft'))} · ${escape(version.source_file_name || 'No file attached yet')} · ${Array.isArray(version.merge_fields) && version.merge_fields.length ? `${version.merge_fields.length} field(s) mapped` : 'No fields mapped yet'}</p>
                </div>
                <button type="button" class="btn-secondary btn-inline" data-map-fields-version="${escape(version.id)}"><i class="fas fa-object-group"></i> Map Fields</button>
              </div>
            `).join('') : '<div class="empty-state small"><p>No template versions yet.</p></div>'}
          </div>
        </div>
      </div>
      <div class="settings-card partner-contracts-mini-card">
        <h3>Phase 2B Status</h3>
        <p class="partner-contracts-helper-copy">Template library and the Create Template + Version modal are now live. Next small steps can add direct file upload, request composition, signer routing controls, and email delivery polish.</p>
      </div>
    `;
  }

  function renderDetails() {
    if (state.selectedRequestId && state.requestDetails.has(state.selectedRequestId)) {
      renderRequestDetail(state.requestDetails.get(state.selectedRequestId));
      return;
    }
    if (state.selectedTemplateId && state.templateDetails.has(state.selectedTemplateId)) {
      renderTemplateDetail(state.templateDetails.get(state.selectedTemplateId));
      return;
    }
    renderRequestDetail(null);
  }

  function renderAll() {
    renderScopeControls();
    renderKpis();
    renderTemplatesTable();
    renderRequestsTable();
    renderDetails();
  }

  async function selectTemplate(templateId) {
    state.selectedTemplateId = templateId || null;
    state.selectedRequestId = null;
    renderAll();
    if (!templateId) return;
    try {
      partnerContractsStatus('Loading template details…');
      await ensureTemplateDetails(templateId);
      renderAll();
      partnerContractsStatus('Template details loaded.', 'success');
    } catch (error) {
      partnerContractsStatus('Could not load template details: ' + escape(error.message), 'error');
    }
  }

  async function selectRequest(requestId) {
    state.selectedRequestId = requestId || null;
    state.selectedTemplateId = null;
    renderAll();
    if (!requestId) return;
    try {
      partnerContractsStatus('Loading request details…');
      await ensureRequestDetails(requestId);
      renderAll();
      partnerContractsStatus('Request details loaded.', 'success');
    } catch (error) {
      partnerContractsStatus('Could not load request details: ' + escape(error.message), 'error');
    }
  }

  async function loadPartnerContractsViewData({ force = false } = {}) {
    if (!canUsePartnerContracts()) return;
    if (state.loading) return;
    if (state.loaded && !force) {
      renderAll();
      return;
    }
    state.loading = true;
    partnerContractsStatus('Loading DocuMike, templates, requests, and recent activity…');
    try {
      const partnerProfileId = currentPartnerFilter();
      const data = await fetchBootstrap(partnerProfileId);
      state.partnerProfiles = data.partnerProfiles || [];
      state.templates = data.templates || [];
      state.requests = data.requests || [];
      state.recentEvents = data.recentEvents || [];
      state.requestDetails.clear();
      state.templateDetails.clear();
      state.loaded = true;
      if (!state.selectedRequestId && state.requests.length) state.selectedRequestId = state.requests[0].id;
      renderAll();
      if (state.selectedRequestId) await ensureRequestDetails(state.selectedRequestId).catch(() => null);
      renderAll();
      partnerContractsStatus('DocuMike is connected. Template library and Create Template + Version are live; request builder is the next small build step.', 'success');
    } catch (error) {
      renderAll();
      partnerContractsStatus('Could not load DocuMike data: ' + escape(error.message) + '<br><small>Make sure the DocuMike schema is installed in Supabase and the latest deploy is live.</small>', 'error');
    } finally {
      state.loading = false;
    }
  }

  function bindEvents() {
    byId('partnerContractsRefreshBtn')?.addEventListener('click', () => loadPartnerContractsViewData({ force: true }));
    byId('partnerContractsSettingsBtn')?.addEventListener('click', () => {
      // Open the DocuMike Settings modal (wraps the old Contracts Setup view)
      const modal = byId('documikeSettingsModal');
      if (!modal) {
        // Fallback: switch to the legacy view if the modal isn't present
        if (typeof window.showView === 'function') window.showView('contracts-setup');
        return;
      }
      // Move the live setup view body into the modal slot (once)
      const slot = byId('documikeSettingsSlot');
      const setupBody = byId('contractsSetupBody');
      const setupStatus = byId('contractsSetupStatus');
      if (slot && setupBody && !slot.contains(setupBody)) {
        if (setupStatus) slot.appendChild(setupStatus);
        slot.appendChild(setupBody);
      }
      modal.classList.remove('hidden');
      // Kick a fresh status load every time the modal opens
      window.loadContractsSetupView?.({ force: true });
    });
    document.addEventListener('click', (event) => {
      const mapBtn = event.target.closest('[data-map-fields-version]');
      if (mapBtn) {
        const templateVersionId = mapBtn.dataset.mapFieldsVersion;
        const templateName = state.templateDetails.get(state.selectedTemplateId)?.template?.template_name || 'Template';
        if (typeof window.openPartnerContractsFieldEditor === 'function') {
          window.openPartnerContractsFieldEditor({ templateVersionId, templateName });
        } else {
          partnerContractsStatus('Field editor script is not loaded yet.', 'warning');
        }
        return;
      }
      const templateBtn = event.target.closest('[data-template-action]');
      if (templateBtn) {
        handleTemplateAction(templateBtn);
      }
    });
  }

  async function handleTemplateAction(btn) {
    const action = btn.dataset.templateAction;
    const templateId = btn.dataset.templateId;
    if (!templateId) return;
    const detail = state.templateDetails.get(templateId);
    const template = detail?.template;
    if (action === 'edit' && template) {
      openEditTemplateModal(template);
      return;
    }
    if (action === 'toggle-active') {
      const currentlyActive = btn.dataset.currentActive === '1';
      try {
        partnerContractsStatus(currentlyActive ? 'Archiving template…' : 'Reactivating template…');
        await partnerContractsAction('update_template', { template_id: templateId, is_active: !currentlyActive });
        state.loaded = false;
        state.templateDetails.delete(templateId);
        await loadPartnerContractsViewData({ force: true });
        await selectTemplate(templateId);
        partnerContractsStatus(currentlyActive ? 'Template archived.' : 'Template reactivated.', 'success');
      } catch (error) {
        partnerContractsStatus('Could not update template: ' + escape(error.message), 'error');
      }
      return;
    }
    if (action === 'delete') {
      const name = template?.template_name || 'this template';
      if (!window.confirm(`Delete template "${name}"? This is permanent. If any signature requests exist for it, the delete will fail and you should archive instead.`)) return;
      try {
        partnerContractsStatus('Deleting template…');
        await partnerContractsAction('delete_template', { template_id: templateId });
        state.loaded = false;
        state.templateDetails.delete(templateId);
        state.selectedTemplateId = null;
        await loadPartnerContractsViewData({ force: true });
        partnerContractsStatus(`Template "${escape(name)}" deleted.`, 'success');
      } catch (error) {
        partnerContractsStatus('Could not delete template: ' + escape(error.message), 'error');
      }
    }
  }

  function openEditTemplateModal(template) {
    const modal = byId('partnerContractsEditTemplateModal');
    if (!modal) {
      partnerContractsStatus('Edit Template modal not available in this build.', 'error');
      return;
    }
    if (byId('pcet_template_id')) byId('pcet_template_id').value = template.id;
    if (byId('pcet_template_name')) byId('pcet_template_name').value = template.template_name || '';
    if (byId('pcet_description')) byId('pcet_description').value = template.description || '';
    if (byId('pcet_category')) byId('pcet_category').value = template.category || '';
    modal.classList.remove('hidden');
  }

  async function saveEditTemplate() {
    const templateId = byId('pcet_template_id')?.value;
    const templateName = String(byId('pcet_template_name')?.value || '').trim();
    if (!templateId || !templateName) {
      partnerContractsStatus('Template name is required.', 'warning');
      return;
    }
    try {
      partnerContractsStatus('Saving template changes…');
      await partnerContractsAction('update_template', {
        template_id: templateId,
        template_name: templateName,
        description: String(byId('pcet_description')?.value || '').trim(),
        category: String(byId('pcet_category')?.value || '').trim()
      });
      window.closeAllModals?.();
      state.loaded = false;
      state.templateDetails.delete(templateId);
      await loadPartnerContractsViewData({ force: true });
      await selectTemplate(templateId);
      partnerContractsStatus('Template updated.', 'success');
    } catch (error) {
      partnerContractsStatus('Could not save template: ' + escape(error.message), 'error');
    }
  }

  function bindAdditionalEvents() {
    byId('partnerContractsAddTemplateBtn')?.addEventListener('click', openTemplateCreateModal);
    byId('partnerContractsTemplateSaveBtn')?.addEventListener('click', saveTemplateAndVersion);
    byId('partnerContractsEditTemplateSaveBtn')?.addEventListener('click', saveEditTemplate);
    byId('partnerContractsCreateRequestBtn')?.addEventListener('click', () => {
      if (typeof window.openPartnerContractsRequestBuilder === 'function') {
        window.openPartnerContractsRequestBuilder();
        return;
      }
      partnerContractsStatus('Template creation is live. Request builder UI is loading in the next script block.', 'warning');
    });
    byId('pct_template_name')?.addEventListener('input', () => {
      const slugInput = byId('pct_template_slug');
      if (!slugInput) return;
      if (slugInput.dataset.manual === 'true') return;
      slugInput.value = slugify(byId('pct_template_name')?.value || '');
    });
    byId('pct_template_slug')?.addEventListener('input', () => {
      const slugInput = byId('pct_template_slug');
      if (!slugInput) return;
      slugInput.dataset.manual = slugInput.value.trim() ? 'true' : 'false';
    });
    byId('partnerContractsPartnerFilter')?.addEventListener('change', () => {
      const checkbox = byId('partnerContractsSelectedOnly');
      if (checkbox && byId('partnerContractsPartnerFilter')?.value) checkbox.checked = true;
      state.selectedRequestId = null;
      state.selectedTemplateId = null;
      renderAll();
    });
    byId('partnerContractsSelectedOnly')?.addEventListener('change', () => {
      state.selectedRequestId = null;
      state.selectedTemplateId = null;
      renderAll();
    });
    byId('partnerContractsDetailBody')?.addEventListener('click', handleDetailClick);
  }

  async function copyToClipboard(value, successMessage) {
    try {
      await navigator.clipboard.writeText(value);
      partnerContractsStatus(successMessage || 'Copied to clipboard.', 'success');
      return true;
    } catch {
      partnerContractsStatus('Clipboard copy failed. You may need to copy manually.', 'warning');
      return false;
    }
  }

  async function handleDetailClick(event) {
    const requestBtn = event.target.closest('[data-request-action]');
    const signerBtn = event.target.closest('[data-signer-action]');
    const requestId = state.selectedRequestId;
    if (!requestId) return;
    if (requestBtn) {
      const action = requestBtn.dataset.requestAction;
      const detail = state.requestDetails.get(requestId);
      if (action === 'open-launchpad') {
        if (typeof window.showPartnerContractsDispatchModal === 'function' && detail) {
          window.showPartnerContractsDispatchModal(detail);
        }
        return;
      }
      if (action === 'resend-emails') {
        try {
          partnerContractsStatus('Resending signature emails for the active signer group…');
          const updated = await partnerContractsAction('resend_emails', { request_id: requestId });
          state.requestDetails.set(requestId, updated);
          renderAll();
          if (typeof window.showPartnerContractsDispatchModal === 'function') {
            window.showPartnerContractsDispatchModal(updated);
          }
          const delivery = updated?.delivery || {};
          if (delivery.skipped) {
            partnerContractsStatus('Postmark is not configured yet, so no automated emails were sent. Use the launchpad to open drafts manually.', 'warning');
          } else if (delivery.sent > 0) {
            partnerContractsStatus(`Sent ${delivery.sent} of ${delivery.attempted} signature email(s) via Postmark.`, 'success');
          } else {
            // Look for a pending-approval hint in any of the failed deliveries
            const events = updated?.events || [];
            const pendingEvent = events.find((row) => row.event_type === 'email_failed' && /pending approval/i.test(String(row.event_data?.error || '')));
            if (pendingEvent) {
              partnerContractsStatus('Postmark is in pending-approval mode and rejected the recipients. While pending, you can only send to addresses on the same domain as your From address. Use the Email Launchpad to open mailto drafts, or request approval in Postmark.', 'warning');
            } else {
              partnerContractsStatus('Postmark could not send the emails. Use the launchpad to open drafts manually.', 'warning');
            }
          }
        } catch (error) {
          partnerContractsStatus('Could not resend emails: ' + escape(error.message), 'error');
        }
        return;
      }
      if (action === 'copy-all-links') {
        const signers = detail?.signers || [];
        const text = signers
          .filter((row) => row.signing_token)
          .map((row) => `${row.signer_name || row.signer_email || 'Signer'}: ${buildSigningUrl(row.signing_token)}`)
          .join('\n');
        if (!text) {
          partnerContractsStatus('No signing links available to copy yet.', 'warning');
          return;
        }
        await copyToClipboard(text, `Copied ${text.split('\n').length} signing link(s) to clipboard.`);
      }
      if (action === 'generate-pdf') {
        try {
          partnerContractsStatus('Generating signed PDF and audit trail…');
          const updated = await partnerContractsAction('generate_signed_pdf', { request_id: requestId });
          state.requestDetails.set(requestId, updated);
          renderAll();
          partnerContractsStatus('Signed PDF and audit PDF generated. Use the download buttons to open them.', 'success');
        } catch (error) {
          partnerContractsStatus('Could not generate signed PDF: ' + escape(error.message), 'error');
        }
      }
      if (action === 'regenerate-rendered') {
        try {
          partnerContractsStatus('Rendering signed contract PDF…');
          const updated = await partnerContractsAction('regenerate_rendered_pdf', { request_id: requestId });
          state.requestDetails.set(requestId, updated);
          renderAll();
          partnerContractsStatus('Rendered contract PDF generated. Use the download button next to it.', 'success');
        } catch (error) {
          partnerContractsStatus('Could not render contract: ' + escape(error.message), 'error');
        }
        return;
      }
      if (action === 'download-rendered-pdf') {
        const path = detail?.request?.rendered_pdf_path;
        const bucket = detail?.request?.rendered_pdf_storage_bucket || 'partner-contracts';
        if (!path) {
          partnerContractsStatus('Rendered contract not generated yet. Click Generate Rendered Contract first.', 'warning');
          return;
        }
        try {
          partnerContractsStatus('Preparing secure download link…');
          const signed = await partnerContractsAction('sign_object_url', { path, bucket, expires_in_seconds: 600 });
          if (signed?.url) {
            window.open(signed.url, '_blank', 'noopener,noreferrer');
            partnerContractsStatus('Rendered contract opened in a new tab.', 'success');
          } else {
            partnerContractsStatus('Could not generate a download link.', 'error');
          }
        } catch (error) {
          partnerContractsStatus('Could not generate download link: ' + escape(error.message), 'error');
        }
        return;
      }
      if (action === 'download-signed-pdf' || action === 'download-audit-pdf') {
        const path = action === 'download-signed-pdf' ? detail?.request?.signed_pdf_path : detail?.request?.audit_pdf_path;
        const bucket = action === 'download-signed-pdf' ? detail?.request?.signed_pdf_storage_bucket : detail?.request?.audit_pdf_storage_bucket;
        if (!path) {
          partnerContractsStatus('Document has not been generated yet.', 'warning');
          return;
        }
        try {
          partnerContractsStatus('Preparing secure download link…');
          const signed = await partnerContractsAction('sign_object_url', { path, bucket: bucket || 'partner-contracts', expires_in_seconds: 600 });
          if (signed?.url) {
            window.open(signed.url, '_blank', 'noopener,noreferrer');
            partnerContractsStatus('Download opened in a new tab. The signed URL expires in 10 minutes.', 'success');
          } else {
            partnerContractsStatus('Could not generate a download link.', 'error');
          }
        } catch (error) {
          partnerContractsStatus('Could not generate download link: ' + escape(error.message), 'error');
        }
      }
      if (action === 'cancel-request') {
        const requestSnap = detail?.request || {};
        const title = requestSnap.request_title || 'this request';
        if (!confirm(`Cancel "${title}"?\n\nThis will:\n• Mark the request as Cancelled\n• Stop the signing links from working\n• Keep full audit history\n\nThe request can NOT be reactivated. To send again, create a new request.`)) {
          return;
        }
        try {
          partnerContractsStatus('Cancelling request…');
          await partnerContractsAction('cancel_request', { request_id: requestId });
          state.requestDetails.delete(requestId);
          await loadPartnerContractsViewData({ force: true });
          renderAll();
          partnerContractsStatus('Request cancelled. Signing links are now disabled.', 'success');
        } catch (error) {
          partnerContractsStatus('Could not cancel request: ' + escape(error.message), 'error');
        }
        return;
      }
      if (action === 'delete-request') {
        const requestSnap = detail?.request || {};
        const title = requestSnap.request_title || 'this request';
        if (!confirm(`⚠️ PERMANENTLY DELETE "${title}"?\n\nThis will:\n• Remove the request from the database forever\n• Delete all signer records, events, and rendered PDFs\n• Cannot be undone\n\nIf you just want to stop signing, use "Cancel Request" instead.\n\nType OK in the next prompt to confirm.`)) {
          return;
        }
        const confirmText = prompt('Type DELETE to confirm permanent deletion:');
        if (String(confirmText || '').trim().toUpperCase() !== 'DELETE') {
          partnerContractsStatus('Delete cancelled — confirmation text did not match.', 'warning');
          return;
        }
        try {
          partnerContractsStatus('Deleting request…');
          await partnerContractsAction('delete_request', { request_id: requestId });
          state.requestDetails.delete(requestId);
          state.selectedRequestId = null;
          await loadPartnerContractsViewData({ force: true });
          renderAll();
          partnerContractsStatus('Request permanently deleted.', 'success');
        } catch (error) {
          partnerContractsStatus('Could not delete request: ' + escape(error.message), 'error');
        }
        return;
      }
      return;
    }
    if (signerBtn) {
      const action = signerBtn.dataset.signerAction;
      const signerId = signerBtn.dataset.signerId;
      const detail = state.requestDetails.get(requestId);
      const signer = (detail?.signers || []).find((row) => row.id === signerId);
      if (!signer) return;
      if (action === 'copy-link') {
        const url = decodeURIComponent(signerBtn.dataset.signingUrl || '');
        if (!url) {
          partnerContractsStatus('Signing link unavailable for this signer.', 'warning');
          return;
        }
        await copyToClipboard(url, 'Signing link copied to clipboard.');
        return;
      }
      if (action === 'open-draft') {
        const url = buildMailtoForSigner(detail?.request || {}, signer);
        if (!url) return;
        window.location.href = url;
        return;
      }
      if (action === 'sign-in-person') {
        await launchInPersonSigning(requestId, signer);
      }
    }
  }

  function buildMailtoForSigner(request, signer) {
    const signingUrl = buildSigningUrl(signer.signing_token);
    const subject = request.email_subject || `Please sign: ${request.request_title || 'Contract'}`;
    const messageRaw = request.email_message || `Hello ${signer.signer_name || 'there'},\n\nPlease review and sign your contract:\n${signingUrl}`;
    const replaced = String(messageRaw)
      .replace(/\{\{\s*signer_name\s*\}\}/gi, signer.signer_name || '')
      .replace(/\{\{\s*signer_email\s*\}\}/gi, signer.signer_email || '')
      .replace(/\{\{\s*client_name\s*\}\}/gi, request.client_name || '')
      .replace(/\{\{\s*request_title\s*\}\}/gi, request.request_title || '')
      .replace(/\{\{\s*signing_url\s*\}\}/gi, signingUrl);
    const params = new URLSearchParams();
    params.set('subject', subject);
    params.set('body', replaced);
    if (Array.isArray(request.cc_emails) && request.cc_emails.length) params.set('cc', request.cc_emails.join(','));
    return `mailto:${encodeURIComponent(signer.signer_email || '')}?${params.toString()}`;
  }

  async function launchInPersonSigning(requestId, signer) {
    try {
      partnerContractsStatus(`Preparing in-person signing for ${escape(signer.signer_name || signer.signer_email || 'this signer')}…`);
      const updated = await partnerContractsAction('mark_in_person', { request_id: requestId, signer_id: signer.id });
      state.requestDetails.set(requestId, updated);
      renderAll();
      const token = updated?.in_person?.signing_token || signer.signing_token;
      if (!token) {
        partnerContractsStatus('Signer is activated, but no signing link is available yet.', 'warning');
        return;
      }
      const signingUrl = `${window.location.origin}/contract-signing/index.html?token=${encodeURIComponent(token)}&mode=in_person`;
      window.open(signingUrl, '_blank', 'noopener,noreferrer');
      partnerContractsStatus(`In-person signing window opened for ${escape(signer.signer_name || signer.signer_email || 'signer')}.`, 'success');
    } catch (error) {
      partnerContractsStatus('Could not launch in-person signing: ' + escape(error.message), 'error');
    }
  }

  bindEvents();
  bindAdditionalEvents();
  window.loadPartnerContractsViewData = loadPartnerContractsViewData;
  window.partnerContractsBridge = {
    getState: () => state,
    byId,
    escape,
    prettyLabel,
    statusTone,
    formatDateSafe,
    formatDateTimeSafe,
    buildSigningUrl,
    visiblePartners,
    currentTemplates,
    currentRequests,
    currentPartnerFilter,
    ensureTemplateDetails,
    ensureRequestDetails,
    partnerContractsAction,
    setStatus: partnerContractsStatus,
    reload: async () => loadPartnerContractsViewData({ force: true }),
    selectRequest,
    selectTemplate,
    renderAll
  };
})();
