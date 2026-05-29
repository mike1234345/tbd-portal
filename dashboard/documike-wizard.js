// DocuMike Appointment Wizard (v3.5.0)
// Flow: Pick Partner -> Pick Template -> Auto-fill custom fields -> Set signer routing -> Send
// Triggered from openDocuMikeForAppointment() in dashboard.js
(function () {
  const state = {
    appointment: null,
    lead: null,
    partner: null,
    template: null,
    version: null,
    prefill: {},
    customFields: [],   // fields from version.merge_fields filtered to role='custom'
    fieldValues: {},    // user-edited values keyed by field id
    signers: []         // [{role,name,email,routing_order}]
  };

  function byId(id) { return document.getElementById(id); }
  function escape(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function setStatus(msg, tone) {
    const el = byId('documikeWizardStatus');
    if (!el) return;
    if (!msg) { el.className = 'agent-admin-status hidden'; el.innerHTML = ''; return; }
    el.className = 'agent-admin-status' + (tone ? ' ' + tone : '');
    el.innerHTML = msg;
  }

  async function apiPost(action, payload) {
    const { data: { session } } = await window.sb.auth.getSession();
    if (!session?.access_token) throw new Error('You are not signed in.');
    const res = await fetch('/.netlify/functions/partner-contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify(Object.assign({ action }, payload || {}))
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  }

  // ===== STEP RENDERING =====

  function renderStep1_PickPartner() {
    const bridge = window.partnerContractsBridge;
    const partners = bridge ? bridge.visiblePartners() : [];
    const lead = state.lead;
    const summary = `<div class="documike-wizard-context">
      <strong><i class="fas fa-user"></i> ${escape(lead?.contact_name || 'Unknown client')}</strong>
      <small>${escape([lead?.phone, lead?.email, lead?.address].filter(Boolean).join(' \u00b7 ') || 'No contact details on lead')}</small>
    </div>`;
    const optionsHtml = partners.length
      ? partners.map((p) => `<option value="${escape(p.id)}">${escape(p.display_name || p.business_name || 'Partner')}${p.contact_email ? '' : ' (no email on file)'}</option>`).join('')
      : '<option value="">No partners yet</option>';
    byId('documikeWizardBody').innerHTML = `
      ${summary}
      <h3>Step 1 of 4 \u00b7 Pick a partner</h3>
      <p class="modal-sub">Which partner is this contract for?</p>
      <div class="form-group">
        <label>Partner</label>
        <select id="dmw_partner_id"><option value="">\u2014 Choose a partner \u2014</option>${optionsHtml}</select>
      </div>
      <div id="dmw_partner_email_wrap" class="form-group hidden">
        <label>Partner contact email
          <small style="color:var(--text-3);font-weight:400;">\u2014 Receives a copy of the signed contract</small>
        </label>
        <input type="email" id="dmw_partner_email" placeholder="partner@example.com" />
        <p class="documike-wizard-helper hidden" id="dmw_partner_email_hint"><i class="fas fa-circle-info"></i> This partner has no email on file. Enter one to save it for future contracts.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-wizard-cancel><i class="fas fa-xmark"></i> Cancel</button>
        <button type="button" class="btn-save" id="dmw_next_step1" disabled><i class="fas fa-arrow-right"></i> Next: Pick Template</button>
      </div>
    `;

    const partnerSel = byId('dmw_partner_id');
    const emailWrap = byId('dmw_partner_email_wrap');
    const emailInput = byId('dmw_partner_email');
    const emailHint = byId('dmw_partner_email_hint');
    const nextBtn = byId('dmw_next_step1');

    partnerSel.addEventListener('change', () => {
      const pid = partnerSel.value;
      const partner = partners.find((p) => p.id === pid);
      state.partner = partner || null;
      if (partner) {
        emailWrap.classList.remove('hidden');
        const existing = partner.contact_email || partner.email || '';
        emailInput.value = existing;
        if (existing) emailHint.classList.add('hidden');
        else emailHint.classList.remove('hidden');
        nextBtn.disabled = !partner;
      } else {
        emailWrap.classList.add('hidden');
        nextBtn.disabled = true;
      }
    });

    nextBtn.addEventListener('click', async () => {
      const email = (emailInput.value || '').trim();
      if (state.partner && email && email !== (state.partner.contact_email || state.partner.email || '')) {
        // Save the email to the partner profile so future contracts auto-fill it
        try {
          setStatus('Saving partner email\u2026');
          await apiPost('update_partner_contact', { partner_profile_id: state.partner.id, contact_email: email });
          state.partner.contact_email = email;
          setStatus('Partner email saved.', 'success');
        } catch (err) {
          setStatus('Could not save partner email: ' + escape(err.message), 'warning');
        }
      } else if (state.partner) {
        state.partner.contact_email = email;
      }
      renderStep2_PickTemplate();
    });
  }

  async function renderStep2_PickTemplate() {
    const bridge = window.partnerContractsBridge;
    const allTemplates = bridge ? bridge.currentTemplates() : [];
    const partnerTemplates = allTemplates.filter((t) => t.partner_profile_id === state.partner.id && t.is_active !== false);

    if (!partnerTemplates.length) {
      byId('documikeWizardBody').innerHTML = `
        <h3>Step 2 of 4 \u00b7 Pick a template</h3>
        <div class="empty-state">
          <i class="fas fa-folder-open"></i>
          <p><strong>${escape(state.partner.display_name || 'This partner')}</strong> has no templates yet.</p>
          <p class="documike-wizard-helper">Add a template from the DocuMike page first, then come back here.</p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-wizard-cancel><i class="fas fa-xmark"></i> Close</button>
          <button type="button" class="btn-secondary" id="dmw_back_step2"><i class="fas fa-arrow-left"></i> Back</button>
        </div>
      `;
      byId('dmw_back_step2').addEventListener('click', () => renderStep1_PickPartner());
      return;
    }

    byId('documikeWizardBody').innerHTML = `
      <h3>Step 2 of 4 \u00b7 Pick a template</h3>
      <p class="modal-sub">Which contract template should we send to <strong>${escape(state.lead?.contact_name || 'the client')}</strong>?</p>
      <div class="documike-wizard-template-list">
        ${partnerTemplates.map((t) => `
          <label class="documike-wizard-template-card">
            <input type="radio" name="dmw_template" value="${escape(t.id)}" />
            <div>
              <strong>${escape(t.template_name)}</strong>
              <small>${escape(t.description || 'No description')}</small>
            </div>
          </label>
        `).join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="dmw_back_step2"><i class="fas fa-arrow-left"></i> Back</button>
        <button type="button" class="btn-save" id="dmw_next_step2" disabled><i class="fas fa-arrow-right"></i> Next: Review fields</button>
      </div>
    `;
    byId('dmw_back_step2').addEventListener('click', () => renderStep1_PickPartner());
    const nextBtn = byId('dmw_next_step2');
    document.querySelectorAll('input[name="dmw_template"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        state.template = partnerTemplates.find((t) => t.id === radio.value) || null;
        nextBtn.disabled = !state.template;
      });
    });
    nextBtn.addEventListener('click', () => loadAndRenderStep3());
  }

  async function loadAndRenderStep3() {
    setStatus('Loading template fields\u2026');
    try {
      const detail = await window.partnerContractsBridge.ensureTemplateDetails(state.template.id);
      const versions = detail?.versions || [];
      // Find the latest ready (or any non-archived) version with merge_fields
      const candidate = versions.find((v) => v.id === detail.template.active_version_id)
                     || versions.find((v) => v.status !== 'archived' && Array.isArray(v.merge_fields) && v.merge_fields.length)
                     || versions[0];
      if (!candidate) throw new Error('This template has no versions yet. Upload a PDF and map fields first.');
      state.version = candidate;
      const allFields = Array.isArray(candidate.merge_fields) ? candidate.merge_fields : [];
      state.customFields = allFields.filter((f) => f.signer_role === 'custom');
      setStatus('');
      renderStep3_FillFields();
    } catch (err) {
      setStatus('Could not load template: ' + escape(err.message), 'error');
      // Stay on step 2
    }
  }

  function autoFillValueForField(field) {
    const src = field.prefill_source;
    if (!src) return '';
    return state.prefill[src] || '';
  }

  // v3.5.3: Group custom fields by their prefill_source.
  // Fields that share a source (e.g. "policy_number" appearing on pages 1 and 4)
  // are merged into ONE input. Fields with no prefill_source remain unique
  // (each gets its own input, keyed by field id).
  function buildFieldGroups() {
    const fields = state.customFields || [];
    const bySource = new Map();   // prefill_source -> { source, label, type, fields:[...] }
    const standalone = [];        // fields with no prefill_source
    fields.forEach((f) => {
      const src = (f.prefill_source || '').trim();
      if (src) {
        if (!bySource.has(src)) {
          bySource.set(src, {
            key: 'src:' + src,
            source: src,
            label: f.label || src,
            type: f.type || 'text',
            required: !!f.required,
            fields: [f]
          });
        } else {
          const g = bySource.get(src);
          g.fields.push(f);
          if (f.required) g.required = true;
          // Prefer the shortest non-empty label as the canonical group label
          if (f.label && f.label.length < g.label.length) g.label = f.label;
        }
      } else {
        standalone.push({
          key: 'id:' + f.id,
          source: '',
          label: f.label || 'Field',
          type: f.type || 'text',
          required: !!f.required,
          fields: [f]
        });
      }
    });
    return [...bySource.values(), ...standalone];
  }

  function autoFillValueForGroup(group) {
    if (!group.source) return '';
    return state.prefill[group.source] || '';
  }

  function renderStep3_FillFields() {
    const groups = buildFieldGroups();
    // Seed fieldValues keyed by GROUP key (so duplicates share one input)
    state.fieldValues = {};
    groups.forEach((g) => { state.fieldValues[g.key] = autoFillValueForGroup(g); });

    const totalFieldCount = state.customFields.length;
    const dedupeNote = (totalFieldCount > groups.length)
      ? `<p class="muted" style="font-size:.82rem;color:var(--text-3);margin:6px 0;"><i class="fas fa-circle-info"></i> This template has ${totalFieldCount} field${totalFieldCount === 1 ? '' : 's'} but only ${groups.length} unique input${groups.length === 1 ? '' : 's'} — the same value will auto-fill on every page where it's needed.</p>`
      : '';

    const fieldsHtml = groups.length
      ? `<div class="documike-wizard-fields-grid">
          ${groups.map((g) => {
            const value = state.fieldValues[g.key] || '';
            const isAuto = Boolean(autoFillValueForGroup(g));
            const inputType = g.type === 'date' ? 'date' : 'text';
            const occurrences = g.fields.length;
            const occBadge = occurrences > 1
              ? `<span class="documike-badge multi" title="Appears ${occurrences} times in the contract"><i class="fas fa-clone"></i> ×${occurrences}</span>`
              : '';
            return `
              <div class="form-group documike-wizard-field ${isAuto ? 'is-autofilled' : (value ? '' : 'is-missing')}">
                <label>
                  ${escape(g.label)}
                  ${occBadge}
                  ${isAuto ? '<span class="documike-badge auto"><i class="fas fa-wand-magic-sparkles"></i> Auto-filled</span>' : ''}
                  ${g.required ? '<span class="documike-badge required">Required</span>' : ''}
                  ${g.source ? `<small style="color:var(--text-3);font-weight:400;display:block;">Source: ${escape(g.source)}${occurrences > 1 ? ` · fills ${occurrences} spots` : ''}</small>` : ''}
                </label>
                <input type="${inputType}" data-dmw-group-key="${escape(g.key)}" value="${escape(value)}" placeholder="${escape(g.label)}" />
              </div>
            `;
          }).join('')}
        </div>`
      : '<div class="empty-state small"><p>This template has no <em>custom</em>-role fields. Just click Next to set up signer emails.</p></div>';

    byId('documikeWizardBody').innerHTML = `
      <h3>Step 3 of 4 \u00b7 Fill in the blanks</h3>
      <p class="modal-sub">These are the <strong>custom</strong>-role fields from <em>${escape(state.template.template_name)}</em>. Client / partner / cosigner fields stay blank \u2014 they fill those on their signing page.</p>
      ${dedupeNote}
      <div class="documike-wizard-legend">
        <span><span class="dot auto"></span> Auto-filled from CRM (editable)</span>
        <span><span class="dot missing"></span> Needs your input</span>
        <span><i class="fas fa-clone"></i> Appears more than once</span>
      </div>
      ${fieldsHtml}
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="dmw_back_step3"><i class="fas fa-arrow-left"></i> Back</button>
        <button type="button" class="btn-secondary" id="dmw_inperson_step3" title="Client is here right now — skip email routing and open the signing page on this device"><i class="fas fa-mobile-screen"></i> Sign In Person Now</button>
        <button type="button" class="btn-save" id="dmw_next_step3"><i class="fas fa-arrow-right"></i> Next: Signer routing</button>
      </div>
    `;
    // Listen for input changes on grouped inputs
    document.querySelectorAll('[data-dmw-group-key]').forEach((input) => {
      input.addEventListener('input', () => {
        state.fieldValues[input.dataset.dmwGroupKey] = input.value;
        const wrap = input.closest('.documike-wizard-field');
        if (wrap) wrap.classList.toggle('is-missing', !input.value);
      });
    });
    byId('dmw_back_step3').addEventListener('click', () => renderStep2_PickTemplate());
    byId('dmw_next_step3').addEventListener('click', () => renderStep4_Signers());
    byId('dmw_inperson_step3').addEventListener('click', () => submitInPerson());
  }

  // v3.5.5: "Sign In Person Now" flow — client is physically present.
  // Auto-builds the client signer from the appointment lead, creates the request,
  // marks it in-person, then opens the signing page in a new tab on this device.
  async function submitInPerson() {
    const lead = state.lead;
    const clientName = lead?.contact_name || '';
    const clientEmail = lead?.email || '';
    if (!clientName) {
      setStatus('This appointment has no client name on the lead. Add one to the lead first, or use "Next: Signer routing" to enter it manually.', 'error');
      return;
    }

    // Build prefill_values from the deduplicated Step 3 inputs (same logic as submitRequest)
    const prefillValues = Object.assign({}, state.prefill);
    const groups = buildFieldGroups();
    groups.forEach((g) => {
      const val = state.fieldValues[g.key];
      if (!val) return;
      if (g.source) prefillValues[g.source] = val;
      g.fields.forEach((f) => {
        prefillValues[f.id] = val;
        const labelKey = String(f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (labelKey) prefillValues[labelKey] = val;
      });
    });

    // For in-person we still need an email on the signer row (DB requires it), but it's
    // never actually emailed because we mark_in_person before send_request fires.
    // Use a safe placeholder if the lead has no email.
    const placeholderEmail = clientEmail || `in-person+${Date.now()}@local.invalid`;

    const payload = {
      partner_profile_id: state.partner.id,
      template_id: state.template.id,
      template_version_id: state.version.id,
      request_title: `${state.template.template_name} \u2014 ${clientName} (In-Person)`,
      client_name: clientName,
      client_email: clientEmail,
      lead_id: state.appointment?.lead_id || null,
      email_subject: '',
      email_message: '',
      prefill_values: prefillValues,
      signers: [{
        signer_role: 'client',
        signer_name: clientName,
        signer_email: placeholderEmail,
        routing_order: 1
      }],
      request_payload: {
        source: 'appointment_wizard',
        appointment_id: state.appointment?.id || null,
        lead_id: state.appointment?.lead_id || null,
        in_person: true,
        unique_inputs: groups.length,
        total_field_count: state.customFields.length,
        auto_filled_count: groups.filter((g) => Boolean(autoFillValueForGroup(g))).length,
        manual_filled_count: groups.filter((g) => !autoFillValueForGroup(g) && state.fieldValues[g.key]).length
      }
    };

    setStatus('Preparing in-person signing session\u2026');
    try {
      // 1. Create the request
      const createResp = await apiPost('create_request', payload);
      const request = createResp?.request || createResp;
      const requestId = request?.id;
      if (!requestId) throw new Error('Could not create request');

      // 2. Render the PDF with prefilled values so the client sees merged data
      try { await apiPost('regenerate_rendered_pdf', { request_id: requestId }); } catch (e) { /* non-fatal */ }

      // 3. Find the signer ID we just created (the only one)
      const signers = Array.isArray(createResp?.signers) ? createResp.signers : [];
      const signer = signers[0];
      if (!signer || !signer.id) {
        // Fallback: fetch request bundle to get signer id
        const detail = await window.partnerContractsBridge?.ensureRequestDetails?.(requestId);
        const fallbackSigner = detail?.signers?.[0];
        if (!fallbackSigner) throw new Error('Could not locate signer record');
        await openInPersonWindow(requestId, fallbackSigner);
      } else {
        await openInPersonWindow(requestId, signer);
      }

      // 4. Refresh DocuMike data + close wizard
      try { await window.partnerContractsBridge?.reload?.(); } catch (e) {}
      setStatus(`In-person signing window opened for <strong>${escape(clientName)}</strong>. They can sign on this device.`, 'success');
      setTimeout(() => closeWizard(), 2000);
    } catch (err) {
      setStatus('Could not start in-person signing: ' + escape(err.message), 'error');
    }
  }

  async function openInPersonWindow(requestId, signer) {
    // Use the existing mark_in_person backend action so the signing page shows the in-person UI
    const marked = await apiPost('mark_in_person', { request_id: requestId, signer_id: signer.id });
    const token = marked?.in_person?.signing_token || signer.signing_token;
    if (!token) throw new Error('Signer activated, but no signing token was returned.');
    const signingUrl = `${window.location.origin}/contract-signing/index.html?token=${encodeURIComponent(token)}&mode=in_person`;
    window.open(signingUrl, '_blank', 'noopener,noreferrer');
  }

  function renderStep4_Signers() {
    const lead = state.lead;
    const partner = state.partner;
    // Default signer rows
    if (!state.signers.length) {
      const def = [];
      def.push({ role: 'client', name: lead?.contact_name || '', email: lead?.email || '', routing_order: 1 });
      const partnerEmail = partner?.contact_email || partner?.email || '';
      if (partnerEmail) {
        def.push({ role: 'partner', name: partner?.display_name || partner?.business_name || 'Partner', email: partnerEmail, routing_order: 2 });
      }
      state.signers = def;
    }
    renderSignerList();

    byId('documikeWizardBody').innerHTML = `
      <h3>Step 4 of 4 \u00b7 Signer routing & send</h3>
      <p class="modal-sub">The client signs first, then the partner gets emailed automatically. Add a co-signer if needed.</p>
      <div id="dmw_signer_list" class="documike-wizard-signer-list"></div>
      <div class="documike-wizard-row">
        <button type="button" class="btn-secondary btn-inline" id="dmw_add_signer"><i class="fas fa-user-plus"></i> Add Co-signer</button>
      </div>
      <div class="form-group full">
        <label>Email subject <small style="color:var(--text-3);font-weight:400;">\u2014 Sent to each signer</small></label>
        <input type="text" id="dmw_email_subject" value="Please sign: ${escape(state.template.template_name)}" />
      </div>
      <div class="form-group full">
        <label>Email message</label>
        <textarea id="dmw_email_message" rows="4">Hello {{signer_name}},

${escape(partner?.display_name || 'We have')} prepared a contract for you to review and sign.

Click the link below to view and sign:
{{signing_url}}

Thank you.</textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="dmw_back_step4"><i class="fas fa-arrow-left"></i> Back</button>
        <button type="button" class="btn-secondary" id="dmw_save_draft"><i class="fas fa-save"></i> Save as Draft</button>
        <button type="button" class="btn-save" id="dmw_send"><i class="fas fa-paper-plane"></i> Send for Signing</button>
      </div>
    `;
    renderSignerList();
    byId('dmw_add_signer').addEventListener('click', () => {
      state.signers.push({ role: 'co_signer', name: '', email: '', routing_order: state.signers.length + 1 });
      renderSignerList();
    });
    byId('dmw_back_step4').addEventListener('click', () => renderStep3_FillFields());
    byId('dmw_save_draft').addEventListener('click', () => submitRequest(false));
    byId('dmw_send').addEventListener('click', () => submitRequest(true));
  }

  function renderSignerList() {
    const wrap = byId('dmw_signer_list');
    if (!wrap) return;
    wrap.innerHTML = state.signers.map((s, idx) => `
      <div class="documike-wizard-signer-row" data-signer-idx="${idx}">
        <div class="documike-wizard-signer-order">${s.routing_order}</div>
        <div class="form-group">
          <label>Role</label>
          <select data-signer-field="role">
            <option value="client" ${s.role === 'client' ? 'selected' : ''}>Client</option>
            <option value="partner" ${s.role === 'partner' ? 'selected' : ''}>Partner</option>
            <option value="co_signer" ${s.role === 'co_signer' ? 'selected' : ''}>Co-signer</option>
            <option value="custom" ${s.role === 'custom' ? 'selected' : ''}>Custom</option>
          </select>
        </div>
        <div class="form-group"><label>Name</label><input type="text" data-signer-field="name" value="${escape(s.name || '')}" placeholder="Full name" /></div>
        <div class="form-group"><label>Email</label><input type="email" data-signer-field="email" value="${escape(s.email || '')}" placeholder="signer@example.com" /></div>
        <button type="button" class="btn-icon-danger" data-signer-remove title="Remove signer"><i class="fas fa-trash"></i></button>
      </div>
    `).join('');
    wrap.querySelectorAll('[data-signer-idx]').forEach((row) => {
      const idx = Number(row.dataset.signerIdx);
      row.querySelectorAll('[data-signer-field]').forEach((input) => {
        input.addEventListener('input', () => {
          state.signers[idx][input.dataset.signerField] = input.value;
        });
        input.addEventListener('change', () => {
          state.signers[idx][input.dataset.signerField] = input.value;
        });
      });
      const rm = row.querySelector('[data-signer-remove]');
      if (rm) rm.addEventListener('click', () => {
        state.signers.splice(idx, 1);
        state.signers.forEach((s, i) => { s.routing_order = i + 1; });
        renderSignerList();
      });
    });
  }

  async function submitRequest(sendNow) {
    // Validate signers
    const validSigners = state.signers.filter((s) => s.name && s.email);
    if (!validSigners.length) {
      setStatus('Add at least one signer with a name and email.', 'error');
      return;
    }
    // v3.5.3: Build prefill_values from the deduplicated groups.
    // Each group covers one or more underlying fields (when prefill_source matches).
    // Writing to BOTH the prefill_source key AND every member field id ensures the
    // renderer fills every spot — even if a future renderer change drops one path.
    const prefillValues = Object.assign({}, state.prefill);
    const groups = buildFieldGroups();
    groups.forEach((g) => {
      const val = state.fieldValues[g.key];
      if (!val) return;
      if (g.source) prefillValues[g.source] = val;
      g.fields.forEach((f) => {
        prefillValues[f.id] = val;
        const labelKey = String(f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (labelKey) prefillValues[labelKey] = val;
      });
    });

    const payload = {
      partner_profile_id: state.partner.id,
      template_id: state.template.id,
      template_version_id: state.version.id,
      request_title: `${state.template.template_name} \u2014 ${state.lead?.contact_name || 'Client'}`,
      client_name: state.lead?.contact_name || '',
      client_email: state.lead?.email || '',
      lead_id: state.appointment?.lead_id || null,
      email_subject: byId('dmw_email_subject')?.value || '',
      email_message: byId('dmw_email_message')?.value || '',
      prefill_values: prefillValues,
      signers: validSigners.map((s, i) => ({
        signer_role: s.role,
        signer_name: s.name,
        signer_email: s.email,
        routing_order: i + 1
      })),
      request_payload: {
        source: 'appointment_wizard',
        appointment_id: state.appointment?.id || null,
        lead_id: state.appointment?.lead_id || null,
        unique_inputs: groups.length,
        total_field_count: state.customFields.length,
        auto_filled_count: groups.filter((g) => Boolean(autoFillValueForGroup(g))).length,
        manual_filled_count: groups.filter((g) => !autoFillValueForGroup(g) && state.fieldValues[g.key]).length
      }
    };

    setStatus(sendNow ? 'Creating request and sending email to first signer\u2026' : 'Saving draft\u2026');
    try {
      const createResp = await apiPost('create_request', payload);
      const requestId = createResp?.request?.id || createResp?.id;
      if (!requestId) throw new Error('Could not create request');
      // Trigger rendered PDF generation up front (so signers see merged data)
      try { await apiPost('regenerate_rendered_pdf', { request_id: requestId }); } catch (e) { /* non-fatal */ }
      if (sendNow) {
        await apiPost('send_request', { request_id: requestId });
        setStatus(`Sent! Email is on its way to <strong>${escape(validSigners[0].name)}</strong>. The next signer will be emailed automatically after this one signs.`, 'success');
      } else {
        setStatus(`Saved as draft. Open it from the Signature Requests list to send when ready.`, 'success');
      }
      // Refresh the underlying DocuMike data + close after a beat
      try { await window.partnerContractsBridge?.reload?.(); } catch (e) {}
      setTimeout(() => closeWizard(), 1800);
    } catch (err) {
      setStatus('Could not create request: ' + escape(err.message), 'error');
    }
  }

  // ===== PUBLIC API =====

  async function openWizard({ appointment, lead, prefill }) {
    state.appointment = appointment;
    state.lead = lead || null;
    state.prefill = prefill || {};
    state.partner = null;
    state.template = null;
    state.version = null;
    state.customFields = [];
    state.fieldValues = {};
    state.signers = [];

    // Make sure DocuMike data is loaded
    if (window.partnerContractsBridge && !window.partnerContractsBridge.getState().loaded) {
      try { await window.partnerContractsBridge.reload(); } catch (e) {}
    }

    const modal = byId('documikeWizardModal');
    if (!modal) {
      alert('DocuMike wizard is not available yet. Please refresh and try again.');
      return;
    }
    modal.classList.remove('hidden');
    setStatus('');
    renderStep1_PickPartner();
  }

  function closeWizard() {
    byId('documikeWizardModal')?.classList.add('hidden');
    setStatus('');
  }

  // Wire close buttons and outside cancel
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-wizard-cancel]') || event.target.closest('#documikeWizardModal [data-close]')) {
      closeWizard();
    }
  });

  window.openDocuMikeWizard = openWizard;
  window.closeDocuMikeWizard = closeWizard;
})();
