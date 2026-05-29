(function () {
  const state = { status: null, loading: false };

  function byId(id) { return document.getElementById(id); }
  function escape(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setStatus(msg, type) {
    const el = byId('contractsSetupStatus');
    if (!el) return;
    if (!msg) { el.className = 'agent-admin-status hidden'; el.innerHTML = ''; return; }
    el.className = 'agent-admin-status' + (type ? ' ' + type : '');
    el.innerHTML = msg;
  }

  async function apiFetch(url, options = {}) {
    const { data: { session } } = await window.sb.auth.getSession();
    if (!session?.access_token) throw new Error('You are not signed in.');
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
        ...(options.headers || {})
      }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Setup request failed.');
    return json;
  }

  async function loadStatus() {
    return apiFetch('/.netlify/functions/partner-contracts-setup?resource=status');
  }

  async function postAction(action, payload = {}) {
    return apiFetch('/.netlify/functions/partner-contracts-setup', {
      method: 'POST',
      body: JSON.stringify({ action, ...payload })
    });
  }

  function checkRow(label, ok, hint) {
    return `<div class="contracts-setup-check ${ok ? 'ok' : 'pending'}"><i class="fas ${ok ? 'fa-check-circle' : 'fa-circle-dot'}"></i><div><strong>${escape(label)}</strong>${hint ? `<small>${escape(hint)}</small>` : ''}</div><span class="contracts-setup-badge ${ok ? 'ok' : 'pending'}">${ok ? 'Ready' : 'Pending'}</span></div>`;
  }

  function helperBlock(status) {
    const installed = Boolean(status.helper_installed);
    return `
      <div class="settings-card contracts-setup-card ${installed ? '' : 'contracts-setup-callout'}">
        <h3><i class="fas fa-${installed ? 'check-circle' : 'triangle-exclamation'}"></i> Step 1 · One-time helper install ${installed ? '<span class="contracts-setup-badge ok">Installed</span>' : '<span class="contracts-setup-badge pending">Action needed</span>'}</h3>
        ${installed
          ? '<p>The helper function is already installed. You can re-copy the SQL below for reference, or skip to Step 2.</p>'
          : '<p><strong>Do this first:</strong> open <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">Supabase Dashboard</a> → your project → SQL Editor → New Query, then paste the SQL below and click <em>Run</em>. After that, every future migration runs from this page with one click.</p>'
        }
        <textarea readonly class="mono contracts-setup-sql" onclick="this.select()">${escape(status.helper_sql || '')}</textarea>
        <div class="contracts-setup-actions">
          <button type="button" class="btn-save" data-action="copy-helper"><i class="fas fa-copy"></i> Copy SQL to Clipboard</button>
          <a href="https://supabase.com/dashboard/project/_/sql/new" target="_blank" rel="noopener noreferrer" class="btn-secondary"><i class="fas fa-arrow-up-right-from-square"></i> Open Supabase SQL Editor</a>
          <button type="button" class="btn-secondary" data-action="refresh-status"><i class="fas fa-sync"></i> I've run it — check again</button>
        </div>
      </div>
    `;
  }

  function render() {
    const body = byId('contractsSetupBody');
    if (!body || !state.status) return;
    const s = state.status;
    const tablesReady = Object.values(s.tables || {}).every(Boolean);
    const config = s.config || {};
    const webhookUrl = config.webhook_url || '';
    const helperReady = Boolean(s.helper_installed);
    body.innerHTML = `
      ${helperBlock(s)}
      <div class="settings-card contracts-setup-card">
        <h3><i class="fas fa-database"></i> Step 2 · Database & Storage</h3>
        ${helperReady ? '' : '<p class="contracts-setup-hint"><i class="fas fa-circle-info"></i> Finish Step 1 first — the button below will fail until the helper function exists.</p>'}
        <div class="contracts-setup-checks">
          ${Object.entries(s.tables || {}).map(([t, ok]) => checkRow(t, ok)).join('')}
          ${checkRow('Storage bucket: partner-contracts', s.storage_bucket_ready)}
        </div>
        <div class="contracts-setup-actions">
          <button type="button" class="btn-save" data-action="run-migrations" ${helperReady ? '' : 'disabled'}><i class="fas fa-rocket"></i> ${tablesReady && s.storage_bucket_ready ? 'Re-run Setup' : 'Run Setup Now'}</button>
        </div>
      </div>

      <div class="settings-card contracts-setup-card">
        <h3><i class="fas fa-envelope"></i> Step 3 · Outbound Email (Postmark)</h3>
        <div class="contracts-setup-pending-banner">
          <strong><i class="fas fa-triangle-exclamation"></i> Postmark Pending Approval Mode</strong>
          <p>If your Postmark account is still <em>pending approval</em>, you can only send emails to addresses on the same domain as your From address (e.g. <code>${escape(config.contract_from_email || '')}</code> can only send to <code>@${escape((config.contract_from_email || '').split('@')[1] || '')}</code>). To send to clients on Gmail, iCloud, etc., <a href="https://account.postmarkapp.com/servers/19239211/streams" target="_blank" rel="noopener noreferrer">request approval in Postmark</a>. The Send Test Email button below sends to your own From address so it works either way.</p>
        </div>
        <div class="form-grid">
          <div class="form-group"><label>Postmark Server Token ${config.postmark_token_present ? '<span class="contracts-setup-badge ok">Saved</span>' : '<span class="contracts-setup-badge pending">Required</span>'}</label><input type="password" id="setup_postmark_token" placeholder="Paste your Postmark server token" /></div>
          <div class="form-group"><label>From Email</label><input type="email" id="setup_from_email" value="${escape(config.contract_from_email || '')}" /></div>
          <div class="form-group"><label>From Name</label><input type="text" id="setup_from_name" value="${escape(config.contract_from_name || '')}" /></div>
          <div class="form-group"><label>Message Stream</label><input type="text" id="setup_message_stream" value="${escape(config.postmark_message_stream || 'outbound')}" /></div>
          <div class="form-group full"><label>Public Base URL <small class="contracts-setup-helper">Used in signing links inside emails. Leave blank to auto-detect.</small></label><input type="text" id="setup_base_url" value="${escape(config.contract_public_base_url || '')}" placeholder="https://your-site.netlify.app" /></div>
        </div>
        <div class="contracts-setup-actions">
          <button type="button" class="btn-save" data-action="save-settings"><i class="fas fa-save"></i> Save Email Settings</button>
          <button type="button" class="btn-secondary" data-action="send-test-email"><i class="fas fa-paper-plane"></i> Send Test Email to From Address</button>
        </div>
      </div>

      <div class="settings-card contracts-setup-card">
        <h3><i class="fas fa-bell"></i> Postmark Webhook</h3>
        <p>Configure this URL in Postmark \u2192 Server \u2192 Settings \u2192 Webhooks to track Delivery, Open, Bounce, Spam, and Click events.</p>
        <div class="form-group full"><label>Webhook URL</label><input type="text" readonly value="${escape(webhookUrl || 'Save email settings first to generate this URL.')}" /></div>
        <div class="contracts-setup-actions">
          <button type="button" class="btn-secondary" data-action="copy-webhook" ${webhookUrl ? '' : 'disabled'}><i class="fas fa-copy"></i> Copy URL</button>
          <button type="button" class="btn-secondary" data-action="rotate-webhook-secret"><i class="fas fa-rotate"></i> Rotate Webhook Secret</button>
        </div>
      </div>
    `;
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    setStatus('Loading setup status\u2026');
    try {
      state.status = await loadStatus();
      render();
      setStatus('');
    } catch (error) {
      setStatus('Could not load setup status: ' + escape(error.message), 'error');
    } finally {
      state.loading = false;
    }
  }

  async function handleClick(event) {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy-helper') {
      try { await navigator.clipboard.writeText(state.status?.helper_sql || ''); setStatus('Helper SQL copied to clipboard. Paste it into Supabase SQL Editor.', 'success'); } catch { setStatus('Could not copy. Select and copy manually.', 'warning'); }
      return;
    }
    if (action === 'refresh-status') {
      await refresh();
      return;
    }
    if (action === 'copy-webhook') {
      try { await navigator.clipboard.writeText(state.status?.config?.webhook_url || ''); setStatus('Webhook URL copied to clipboard.', 'success'); } catch { setStatus('Could not copy. Select and copy manually.', 'warning'); }
      return;
    }
    if (action === 'run-migrations') {
      try {
        setStatus('Running migrations\u2026');
        const res = await postAction('run_migrations');
        if (res.missing_helper) {
          setStatus(escape(res.error || 'Helper is not installed yet.'), 'warning');
          await refresh();
          return;
        }
        if (!res.ok) {
          // v3.6.0: show detailed diagnostic info when a specific SQL statement was identified as the failure
          let html = 'Migration failed';
          if (res.failed_step) html += ' in step <strong>' + escape(res.failed_step) + '</strong>';
          html += ': ' + escape(res.error || 'unknown error');
          if (res.failing_statement_index !== undefined && res.failing_statement_preview) {
            html += '<br><br><strong>Failing statement #' + (res.failing_statement_index + 1)
                  + ' of ' + (res.total_statements || '?') + ':</strong>'
                  + '<pre style="white-space:pre-wrap;background:rgba(0,0,0,0.18);padding:8px;border-radius:6px;font-size:0.78rem;margin:6px 0;">'
                  + escape(res.failing_statement_preview) + '</pre>'
                  + '<strong>PostgreSQL error:</strong> ' + escape(res.failing_statement_error || res.error);
          }
          setStatus(html, 'error');
          return;
        }
        setStatus(res.message || 'Setup completed.', 'success');
        await refresh();
      } catch (error) { setStatus('Could not run migrations: ' + escape(error.message), 'error'); }
      return;
    }
    if (action === 'save-settings') {
      try {
        setStatus('Saving email settings\u2026');
        const payload = {
          contract_from_email: byId('setup_from_email')?.value || '',
          contract_from_name: byId('setup_from_name')?.value || '',
          postmark_message_stream: byId('setup_message_stream')?.value || '',
          contract_public_base_url: byId('setup_base_url')?.value || ''
        };
        const token = byId('setup_postmark_token')?.value || '';
        if (token.trim()) payload.postmark_server_token = token.trim();
        await postAction('save_settings', payload);
        setStatus('Email settings saved.', 'success');
        await refresh();
      } catch (error) { setStatus('Could not save settings: ' + escape(error.message), 'error'); }
      return;
    }
    if (action === 'send-test-email') {
      try {
        // Send to the configured From email - this always works in pending mode.
        const fromEmail = state.status?.config?.contract_from_email || '';
        setStatus(`Sending test email to ${escape(fromEmail || 'your From address')}\u2026`);
        const res = await postAction('send_test_email', { recipient: fromEmail });
        if (res.ok) {
          setStatus(`Test email sent successfully to ${escape(res.recipient || fromEmail)}. Check your inbox.`, 'success');
        } else if (res.pending_approval) {
          setStatus('Postmark pending approval: ' + escape(res.hint || ''), 'warning');
        } else {
          setStatus('Test email failed: ' + escape(res.result?.error || res.error || 'unknown error'), 'error');
        }
      } catch (error) { setStatus('Could not send test email: ' + escape(error.message), 'error'); }
      return;
    }
    if (action === 'rotate-webhook-secret') {
      try {
        setStatus('Rotating webhook secret\u2026');
        await postAction('generate_webhook_secret');
        setStatus('Webhook secret rotated. Copy the new URL into Postmark.', 'success');
        await refresh();
      } catch (error) { setStatus('Could not rotate secret: ' + escape(error.message), 'error'); }
    }
  }

  function bindEvents() {
    byId('contractsSetupRefreshBtn')?.addEventListener('click', refresh);
    byId('contractsSetupBody')?.addEventListener('click', handleClick);
  }

  bindEvents();
  window.loadContractsSetupView = ({ force = false } = {}) => refresh();
})();
