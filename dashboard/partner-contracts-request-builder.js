(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function escape(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function bridge() {
    return window.partnerContractsBridge || null;
  }

  function getState() {
    return bridge()?.getState?.() || {};
  }

  function requestModal() {
    return byId('partnerContractsRequestModal');
  }

  function dispatchModal() {
    return byId('partnerContractsDispatchModal');
  }

  function signerList() {
    return byId('partnerContractsSignerList');
  }

  function requestStatus(message, type) {
    bridge()?.setStatus?.(message, type);
  }

  function toLocalDatetimeInputValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const offset = date.getTimezoneOffset();
    const local = new Date(date.getTime() - offset * 60000);
    return local.toISOString().slice(0, 16);
  }

  function toIsoOrBlank(localValue) {
    if (!localValue) return '';
    const date = new Date(localValue);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
  }

  function visiblePartners() {
    return bridge()?.visiblePartners?.() || [];
  }

  function allTemplates() {
    return [...(getState().templates || [])];
  }

  function selectedPartnerId() {
    return String(byId('pcr_partner_profile_id')?.value || '');
  }

  function selectedTemplateId() {
    return String(byId('pcr_template_id')?.value || '');
  }

  function templatesForPartner(partnerProfileId) {
    return allTemplates().filter((row) => !partnerProfileId || row.partner_profile_id === partnerProfileId);
  }

  function findPartner(partnerProfileId) {
    return visiblePartners().find((row) => row.id === partnerProfileId) || null;
  }

  function findTemplate(templateId) {
    return allTemplates().find((row) => row.id === templateId) || null;
  }

  function parseJsonField(id, fallback) {
    const raw = String(byId(id)?.value || '').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  }

  function splitEmails(raw) {
    return String(raw || '')
      .split(/[;,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function mailtoUrl(to, subject, body, cc) {
    const params = new URLSearchParams();
    if (subject) params.set('subject', subject);
    if (body) params.set('body', body);
    if (cc) params.set('cc', cc);
    const query = params.toString();
    return `mailto:${encodeURIComponent(to || '')}${query ? `?${query}` : ''}`;
  }

  function replaceTokens(template, context) {
    const tokenMap = {
      signer_name: context.signer_name || '',
      signer_email: context.signer_email || '',
      client_name: context.client_name || '',
      client_email: context.client_email || '',
      partner_name: context.partner_name || '',
      request_title: context.request_title || '',
      template_name: context.template_name || '',
      signing_url: context.signing_url || ''
    };
    return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => tokenMap[key] || '');
  }

  function defaultEmailSubject() {
    const template = findTemplate(selectedTemplateId());
    const partner = findPartner(selectedPartnerId());
    const templateName = template?.template_name || 'Contract';
    const partnerName = partner?.display_name || partner?.business_name || 'Partner';
    return `Please sign: ${templateName} for ${partnerName}`;
  }

  function defaultEmailMessage() {
    const partner = findPartner(selectedPartnerId());
    const partnerName = partner?.display_name || partner?.business_name || 'our team';
    return [
      'Hello {{signer_name}},',
      '',
      `${partnerName} has prepared a signature request for {{request_title}}.`,
      'Please review and sign using the secure link below:',
      '{{signing_url}}',
      '',
      'If you have any questions, reply to this email before signing.',
      '',
      'Thank you'
    ].join('\n');
  }

  function resetRequestBuilderForm() {
    const partners = visiblePartners();
    const state = getState();
    const preferredPartnerId = bridge()?.currentPartnerFilter?.() || state.selectedPartnerId || partners[0]?.id || '';
    if (byId('pcr_request_title')) byId('pcr_request_title').value = '';
    if (byId('pcr_client_name')) byId('pcr_client_name').value = '';
    if (byId('pcr_client_email')) byId('pcr_client_email').value = '';
    if (byId('pcr_cc_emails')) byId('pcr_cc_emails').value = '';
    if (byId('pcr_request_payload')) byId('pcr_request_payload').value = '{}';
    if (byId('pcr_email_subject')) {
      byId('pcr_email_subject').value = '';
      byId('pcr_email_subject').dataset.manual = 'false';
    }
    if (byId('pcr_email_message')) {
      byId('pcr_email_message').value = '';
      byId('pcr_email_message').dataset.manual = 'false';
    }
    if (byId('pcr_expires_at')) {
      const date = new Date();
      date.setDate(date.getDate() + 7);
      byId('pcr_expires_at').value = toLocalDatetimeInputValue(date.toISOString());
    }
    populatePartnerOptions(preferredPartnerId);
    signerList().innerHTML = '';
    addSignerRow({ signer_role: 'client' });
  }

  function populatePartnerOptions(preferredId) {
    const select = byId('pcr_partner_profile_id');
    if (!select) return;
    const partners = visiblePartners();
    select.innerHTML = '<option value="">Select partner</option>' + partners
      .map((partner) => `<option value="${partner.id}">${escape(partner.display_name || partner.business_name || 'Partner')}</option>`)
      .join('');
    const resolved = preferredId || partners[0]?.id || '';
    if ([...select.options].some((option) => option.value === resolved)) select.value = resolved;
  }

  async function populateTemplateOptions(preferredTemplateId, preferredVersionId) {
    const templateSelect = byId('pcr_template_id');
    const versionSelect = byId('pcr_template_version_id');
    if (!templateSelect || !versionSelect) return;
    const partnerProfileId = selectedPartnerId();
    const rows = templatesForPartner(partnerProfileId);
    templateSelect.innerHTML = '<option value="">Select template</option>' + rows
      .map((row) => `<option value="${row.id}">${escape(row.template_name || 'Untitled Template')}</option>`)
      .join('');
    const selected = preferredTemplateId || getState().selectedTemplateId || rows[0]?.id || '';
    if ([...templateSelect.options].some((option) => option.value === selected)) templateSelect.value = selected;

    versionSelect.innerHTML = '<option value="">Load a template first</option>';
    const templateId = String(templateSelect.value || '');
    if (!templateId) return;

    const detail = await bridge()?.ensureTemplateDetails?.(templateId);
    const versions = [...(detail?.versions || [])];
    versionSelect.innerHTML = '<option value="">Select version</option>' + versions
      .map((version) => `<option value="${version.id}">${escape(version.version_label || `v${version.version_number || 0}`)} · ${escape(bridge()?.prettyLabel?.(version.status || 'draft') || version.status || 'draft')}${version.source_file_name ? ` · ${escape(version.source_file_name)}` : ''}</option>`)
      .join('');
    const resolvedVersion = preferredVersionId || detail?.template?.active_version_id || versions[0]?.id || '';
    if ([...versionSelect.options].some((option) => option.value === resolvedVersion)) versionSelect.value = resolvedVersion;
    applyTemplateDefaults();
  }

  function addSignerRow(data = {}) {
    const list = signerList();
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'partner-contracts-signer-row';
    row.innerHTML = `
      <div class="partner-contracts-signer-row-top">
        <span class="partner-contracts-signer-order-badge">Signer 1</span>
        <div class="partner-contracts-signer-actions">
          <button type="button" class="btn-secondary btn-inline" data-signer-move="up"><i class="fas fa-arrow-up"></i></button>
          <button type="button" class="btn-secondary btn-inline" data-signer-move="down"><i class="fas fa-arrow-down"></i></button>
          <button type="button" class="btn-danger btn-inline" data-signer-remove="1"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>Role</label>
          <select data-signer-field="signer_role">
            <option value="client">Client</option>
            <option value="co_signer">Co-signer</option>
            <option value="partner">Partner</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label>Name</label>
          <input type="text" data-signer-field="signer_name" placeholder="Signer name" />
        </div>
        <div class="form-group">
          <label>Email</label>
          <input type="email" data-signer-field="signer_email" placeholder="signer@example.com" />
        </div>
        <div class="form-group">
          <label>Phone</label>
          <input type="text" data-signer-field="signer_phone" placeholder="Optional phone" />
        </div>
      </div>
    `;
    list.appendChild(row);
    row.querySelector('[data-signer-field="signer_role"]').value = data.signer_role || 'client';
    row.querySelector('[data-signer-field="signer_name"]').value = data.signer_name || '';
    row.querySelector('[data-signer-field="signer_email"]').value = data.signer_email || '';
    row.querySelector('[data-signer-field="signer_phone"]').value = data.signer_phone || '';
    renumberSignerRows();
  }

  function renumberSignerRows() {
    signerList()?.querySelectorAll('.partner-contracts-signer-row').forEach((row, index) => {
      const badge = row.querySelector('.partner-contracts-signer-order-badge');
      if (badge) badge.textContent = `Signer ${index + 1}`;
    });
  }

  function applyTemplateDefaults() {
    const template = findTemplate(selectedTemplateId());
    const partner = findPartner(selectedPartnerId());
    if (byId('pcr_request_title') && !String(byId('pcr_request_title').value || '').trim()) {
      byId('pcr_request_title').value = template?.template_name ? `${template.template_name} Request` : 'Signature Request';
    }
    if (byId('pcr_email_subject') && byId('pcr_email_subject').dataset.manual !== 'true') {
      byId('pcr_email_subject').value = defaultEmailSubject();
    }
    if (byId('pcr_email_message') && byId('pcr_email_message').dataset.manual !== 'true') {
      const message = defaultEmailMessage();
      byId('pcr_email_message').value = message;
    }
    if (partner && signerList()?.children.length === 1) {
      const clientName = String(byId('pcr_client_name')?.value || '').trim();
      const clientEmail = String(byId('pcr_client_email')?.value || '').trim();
      if (clientName && !signerList().querySelector('[data-signer-field="signer_name"]').value) {
        signerList().querySelector('[data-signer-field="signer_name"]').value = clientName;
      }
      if (clientEmail && !signerList().querySelector('[data-signer-field="signer_email"]').value) {
        signerList().querySelector('[data-signer-field="signer_email"]').value = clientEmail;
      }
    }
  }

  function collectSignerRows() {
    return [...(signerList()?.querySelectorAll('.partner-contracts-signer-row') || [])].map((row, index) => ({
      signer_role: String(row.querySelector('[data-signer-field="signer_role"]')?.value || 'client').trim(),
      signer_name: String(row.querySelector('[data-signer-field="signer_name"]')?.value || '').trim(),
      signer_email: String(row.querySelector('[data-signer-field="signer_email"]')?.value || '').trim(),
      signer_phone: String(row.querySelector('[data-signer-field="signer_phone"]')?.value || '').trim(),
      routing_order: index + 1
    }));
  }

  function buildRequestPayload() {
    const partnerProfileId = selectedPartnerId();
    const templateId = selectedTemplateId();
    const templateVersionId = String(byId('pcr_template_version_id')?.value || '').trim();
    const requestTitle = String(byId('pcr_request_title')?.value || '').trim();
    const clientName = String(byId('pcr_client_name')?.value || '').trim();
    const clientEmail = String(byId('pcr_client_email')?.value || '').trim();
    const emailSubject = String(byId('pcr_email_subject')?.value || '').trim();
    const emailMessage = String(byId('pcr_email_message')?.value || '').trim();
    const signers = collectSignerRows().filter((row) => row.signer_name && row.signer_email);
    if (!partnerProfileId) throw new Error('Choose a partner.');
    if (!templateId) throw new Error('Choose a template.');
    if (!templateVersionId) throw new Error('Choose a template version.');
    if (!requestTitle) throw new Error('Request title is required.');
    if (!signers.length) throw new Error('Add at least one signer with a name and email.');

    return {
      partner_profile_id: partnerProfileId,
      template_id: templateId,
      template_version_id: templateVersionId,
      request_title: requestTitle,
      client_name: clientName,
      client_email: clientEmail,
      cc_emails: splitEmails(byId('pcr_cc_emails')?.value || ''),
      expires_at: toIsoOrBlank(byId('pcr_expires_at')?.value || ''),
      email_subject: emailSubject || defaultEmailSubject(),
      email_message: emailMessage || defaultEmailMessage(),
      request_payload: parseJsonField('pcr_request_payload', {}),
      signers
    };
  }

  async function saveOrSendRequest(sendNow) {
    const saveBtn = byId('partnerContractsRequestSaveBtn');
    const sendBtn = byId('partnerContractsRequestSendBtn');
    try {
      const payload = buildRequestPayload();
      if (saveBtn) saveBtn.disabled = true;
      if (sendBtn) sendBtn.disabled = true;
      requestStatus(sendNow ? 'Creating request and preparing signature delivery…' : 'Creating draft request…');
      const created = await bridge()?.partnerContractsAction?.('create_request', payload);
      const requestId = created?.request?.id;
      if (!requestId) throw new Error('Request was created but no request id was returned.');
      const finalBundle = sendNow
        ? await bridge()?.partnerContractsAction?.('send_request', { request_id: requestId })
        : created;

      const state = getState();
      if (state.requestDetails instanceof Map) state.requestDetails.set(requestId, finalBundle);
      if (typeof window.closeAllModals === 'function') window.closeAllModals();
      await bridge()?.reload?.();
      await bridge()?.selectRequest?.(requestId);
      requestStatus(
        sendNow
          ? `Signature request <strong>${escape(payload.request_title)}</strong> is live. Use the email launchpad to open drafts for the active signer group.`
          : `Draft request <strong>${escape(payload.request_title)}</strong> created.`,
        'success'
      );
      if (sendNow) showDispatchModal(finalBundle);
    } catch (error) {
      requestStatus('Could not save the request: ' + escape(error.message), 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function buildDispatchEntry(bundle, signer) {
    const request = bundle?.request || {};
    const template = bundle?.request || {};
    const partner = findPartner(request.partner_profile_id) || {};
    const signingUrl = bridge()?.buildSigningUrl?.(signer.signing_token) || '';
    const subject = replaceTokens(request.email_subject || defaultEmailSubject(), {
      signer_name: signer.signer_name,
      signer_email: signer.signer_email,
      client_name: request.client_name,
      client_email: request.client_email,
      partner_name: partner.display_name || partner.business_name || 'Partner',
      request_title: request.request_title,
      template_name: template.template_name || findTemplate(request.template_id)?.template_name || '',
      signing_url: signingUrl
    });
    const body = replaceTokens(request.email_message || defaultEmailMessage(), {
      signer_name: signer.signer_name,
      signer_email: signer.signer_email,
      client_name: request.client_name,
      client_email: request.client_email,
      partner_name: partner.display_name || partner.business_name || 'Partner',
      request_title: request.request_title,
      template_name: findTemplate(request.template_id)?.template_name || '',
      signing_url: signingUrl
    });
    const cc = (request.cc_emails || []).join(',');
    const canLaunch = ['sent', 'viewed'].includes(String(signer.status || ''));
    return `
      <div class="partner-contracts-dispatch-item">
        <div class="partner-contracts-dispatch-head">
          <div>
            <strong>${escape(signer.signer_name || 'Signer')}</strong>
            <small>${escape(signer.signer_email || '—')} · ${escape(bridge()?.prettyLabel?.(signer.signer_role || 'client') || signer.signer_role || 'client')}</small>
          </div>
          <span class="status-pill ${escape(bridge()?.statusTone?.(signer.status) || 'status-New')}">${escape(bridge()?.prettyLabel?.(signer.status || 'draft') || signer.status || 'draft')}</span>
        </div>
        <p class="partner-contracts-helper-copy">${canLaunch ? 'This signer is active in the routing order and can receive the signature email now.' : 'This signer is queued until all earlier signers complete their steps.'}</p>
        <div class="partner-contracts-dispatch-url">${escape(signingUrl || 'Signing link unavailable')}</div>
        <div class="partner-contracts-dispatch-actions">
          ${canLaunch ? `<a class="btn-save" href="${escape(mailtoUrl(signer.signer_email, subject, body, cc))}"><i class="fas fa-envelope"></i> Open Email Draft</a>` : '<button class="btn-secondary" type="button" disabled><i class="fas fa-hourglass-half"></i> Waiting on prior signer</button>'}
          <button class="btn-secondary" type="button" data-copy-link="${encodeURIComponent(signingUrl)}"><i class="fas fa-link"></i> Copy Link</button>
          <button class="btn-secondary" type="button" data-copy-body="${encodeURIComponent(body)}"><i class="fas fa-copy"></i> Copy Email Body</button>
        </div>
      </div>
    `;
  }

  function showDispatchModal(bundle) {
    const list = byId('partnerContractsDispatchList');
    const summary = byId('partnerContractsDispatchSummary');
    if (!list || !summary || !dispatchModal()) return;
    const request = bundle?.request || {};
    const signers = [...(bundle?.signers || [])].sort((a, b) => Number(a.routing_order || 0) - Number(b.routing_order || 0));
    summary.innerHTML = `Request <strong>${escape(request.request_title || 'Signature Request')}</strong> has ${signers.length} signer(s). Open drafts for active signers now, then come back later for queued signers when their turn becomes active.`;
    list.innerHTML = signers.map((signer) => buildDispatchEntry(bundle, signer)).join('');
    dispatchModal().classList.remove('hidden');
  }

  async function openRequestBuilder(options = {}) {
    if (!bridge()) {
      requestStatus('DocuMike core script is not available yet.', 'error');
      return;
    }
    if (!getState().loaded) {
      await bridge().reload?.();
    }
    resetRequestBuilderForm();
    const preferredTemplateId = options.templateId || getState().selectedTemplateId || '';
    await populateTemplateOptions(preferredTemplateId, options.templateVersionId || '');
    requestModal()?.classList.remove('hidden');
  }

  function bindRequestBuilderEvents() {
    byId('pcr_partner_profile_id')?.addEventListener('change', async () => {
      await populateTemplateOptions('', '');
    });
    byId('pcr_template_id')?.addEventListener('change', async () => {
      await populateTemplateOptions(selectedTemplateId(), '');
    });
    byId('partnerContractsAddSignerBtn')?.addEventListener('click', () => addSignerRow({ signer_role: 'co_signer' }));
    byId('partnerContractsRequestSaveBtn')?.addEventListener('click', () => saveOrSendRequest(false));
    byId('partnerContractsRequestSendBtn')?.addEventListener('click', () => saveOrSendRequest(true));
    byId('pcr_email_subject')?.addEventListener('input', () => {
      byId('pcr_email_subject').dataset.manual = byId('pcr_email_subject').value.trim() ? 'true' : 'false';
    });
    byId('pcr_email_message')?.addEventListener('input', () => {
      byId('pcr_email_message').dataset.manual = byId('pcr_email_message').value.trim() ? 'true' : 'false';
    });
    byId('pcr_client_name')?.addEventListener('input', applyTemplateDefaults);
    byId('pcr_client_email')?.addEventListener('input', applyTemplateDefaults);

    signerList()?.addEventListener('click', (event) => {
      const row = event.target.closest('.partner-contracts-signer-row');
      if (!row) return;
      if (event.target.closest('[data-signer-remove]')) {
        row.remove();
        if (!signerList().children.length) addSignerRow({ signer_role: 'client' });
        renumberSignerRows();
        return;
      }
      const moveBtn = event.target.closest('[data-signer-move]');
      if (!moveBtn) return;
      const direction = moveBtn.dataset.signerMove;
      if (direction === 'up' && row.previousElementSibling) {
        row.parentNode.insertBefore(row, row.previousElementSibling);
      }
      if (direction === 'down' && row.nextElementSibling) {
        row.parentNode.insertBefore(row.nextElementSibling, row);
      }
      renumberSignerRows();
    });

    dispatchModal()?.addEventListener('click', async (event) => {
      const linkBtn = event.target.closest('[data-copy-link]');
      const bodyBtn = event.target.closest('[data-copy-body]');
      if (!linkBtn && !bodyBtn) return;
      const value = decodeURIComponent(linkBtn?.dataset.copyLink || bodyBtn?.dataset.copyBody || '');
      try {
        await navigator.clipboard.writeText(value);
        requestStatus(linkBtn ? 'Signing link copied to clipboard.' : 'Email body copied to clipboard.', 'success');
      } catch {
        requestStatus('Clipboard copy failed. You may need to copy manually.', 'warning');
      }
    });
  }

  bindRequestBuilderEvents();
  window.openPartnerContractsRequestBuilder = openRequestBuilder;
  window.showPartnerContractsDispatchModal = showDispatchModal;
})();
