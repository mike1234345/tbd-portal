(function () {
  // Partner Contracts Field Editor - clean rewrite
  // Renders the template PDF inline, lets admin drag/place fields on it,
  // and saves a coordinate map (percent of page width/height) back to the server.

  const state = {
    templateVersionId: '',
    templateName: '',
    pdfUrl: '',
    pdfDoc: null,
    fields: [],
    sources: [],
    selectedFieldId: null,
    addType: null,
    addLabel: '',
    addPrefillSource: '',
    zoom: 1.0,
    pageDimensions: []
  };

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  function byId(id) { return document.getElementById(id); }
  function escape(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setStatus(msg, tone) {
    const el = byId('fieldEditorStatus');
    if (!el) return;
    if (!msg) { el.className = 'agent-admin-status hidden'; el.innerHTML = ''; return; }
    el.className = 'agent-admin-status' + (tone ? ' ' + tone : '');
    el.innerHTML = msg;
  }

  async function apiPost(action, payload) {
    const { data: { session } } = await window.sb.auth.getSession();
    if (!session || !session.access_token) throw new Error('You are not signed in.');
    const res = await fetch('/.netlify/functions/partner-contracts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
    const json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error || 'Request failed.');
    return json;
  }

  function defaultDimensionsFor(type) {
    switch (type) {
      case 'signature': return { width: 25, height: 5 };
      case 'initials': return { width: 8, height: 4 };
      case 'date': return { width: 14, height: 3.2 };
      case 'checkbox': return { width: 3, height: 2.5 };
      default: return { width: 22, height: 3.2 };
    }
  }

  function defaultLabel(type) {
    return ({
      text: 'Text Field',
      date: 'Date',
      signature: 'Signature',
      initials: 'Initials',
      checkbox: 'Checkbox'
    })[type] || 'Field';
  }

  function makeFieldId() {
    return 'fld_' + Math.random().toString(36).slice(2, 9);
  }

  function fieldsForPage(pageNum) {
    return state.fields.filter(function (f) { return Number(f.page || 1) === pageNum; });
  }

  function renderOverlay(pageNum) {
    const overlay = document.querySelector('[data-field-page="' + pageNum + '"] .field-editor-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    fieldsForPage(pageNum).forEach(function (field) {
      const div = document.createElement('div');
      div.className = 'field-editor-field' +
        (field.id === state.selectedFieldId ? ' selected' : '') +
        ' field-editor-field-' + field.type;
      div.dataset.fieldId = field.id;
      div.style.left = Number(field.x || 0) + '%';
      div.style.top = Number(field.y || 0) + '%';
      div.style.width = Number(field.width || 20) + '%';
      div.style.height = Number(field.height || 4) + '%';
      div.innerHTML = '<span class="field-editor-field-label">' +
        escape(field.label || defaultLabel(field.type)) + '</span>';
      overlay.appendChild(div);
    });
  }

  function renderAllOverlays() {
    for (let i = 1; i <= state.pageDimensions.length; i++) renderOverlay(i);
    renderFieldsList();
    renderFieldForm();
  }

  function renderFieldsList() {
    const wrap = byId('fieldEditorList');
    if (!wrap) return;
    if (!state.fields.length) {
      wrap.innerHTML = '<p class="partner-contracts-helper-copy">No fields placed yet. Pick a field type above, then click anywhere on the PDF to place it.</p>';
      return;
    }
    wrap.innerHTML = state.fields.map(function (field, idx) {
      return '<div class="field-editor-list-item' +
        (field.id === state.selectedFieldId ? ' selected' : '') +
        '" data-list-field-id="' + field.id + '">' +
        '<strong>' + (idx + 1) + '. ' + escape(field.label || defaultLabel(field.type)) + '</strong>' +
        '<small>' + escape(field.type) + ' \u00b7 page ' + field.page +
        (field.prefill_source ? ' \u00b7 auto: ' + escape(field.prefill_source) : ' \u00b7 manual') +
        '</small></div>';
    }).join('');
  }

  function renderFieldForm() {
    const form = byId('fieldEditorFieldForm');
    const hint = byId('fieldEditorSideHint');
    const field = state.fields.find(function (f) { return f.id === state.selectedFieldId; });
    if (!form || !hint) return;
    if (!field) {
      form.classList.add('hidden');
      hint.classList.remove('hidden');
      return;
    }
    hint.classList.add('hidden');
    form.classList.remove('hidden');
    if (byId('fldLabel')) byId('fldLabel').value = field.label || '';
    if (byId('fldSignerRole')) byId('fldSignerRole').value = field.signer_role || 'client';
    if (byId('fldRequired')) byId('fldRequired').checked = Boolean(field.required);
    if (byId('fldWidth')) byId('fldWidth').value = field.width || 20;
    if (byId('fldHeight')) byId('fldHeight').value = field.height || 4;
    const select = byId('fldPrefillSource');
    if (select) {
      select.innerHTML = '<option value="">\u2014 None (manual entry) \u2014</option>' +
        state.sources.map(function (src) {
          return '<option value="' + escape(src.key) + '">' + escape(src.label) + '</option>';
        }).join('');
      select.value = field.prefill_source || '';
    }
  }

  function selectField(id) {
    state.selectedFieldId = id || null;
    renderAllOverlays();
  }

  function deleteSelectedField() {
    if (!state.selectedFieldId) return;
    state.fields = state.fields.filter(function (f) { return f.id !== state.selectedFieldId; });
    state.selectedFieldId = null;
    renderAllOverlays();
  }

  function applyFieldForm() {
    const field = state.fields.find(function (f) { return f.id === state.selectedFieldId; });
    if (!field) return;
    field.label = (byId('fldLabel').value || '').trim() || defaultLabel(field.type);
    field.signer_role = byId('fldSignerRole').value || 'client';
    field.prefill_source = byId('fldPrefillSource').value || '';
    field.required = byId('fldRequired').checked;
    const w = Number(byId('fldWidth').value);
    const h = Number(byId('fldHeight').value);
    if (!Number.isNaN(w) && w > 0) field.width = Math.min(100, Math.max(2, w));
    if (!Number.isNaN(h) && h > 0) field.height = Math.min(60, Math.max(1.5, h));
    renderAllOverlays();
  }

  function placeFieldAt(pageNum, xPercent, yPercent) {
    if (!state.addType) return;
    const dims = defaultDimensionsFor(state.addType);
    const field = {
      id: makeFieldId(),
      type: state.addType,
      page: pageNum,
      label: state.addLabel || defaultLabel(state.addType),
      x: Math.max(0, Math.min(100 - dims.width, xPercent - dims.width / 2)),
      y: Math.max(0, Math.min(100 - dims.height, yPercent - dims.height / 2)),
      width: dims.width,
      height: dims.height,
      signer_role: 'client',
      prefill_source: state.addPrefillSource || '',
      required: ['signature', 'initials'].indexOf(state.addType) !== -1
    };
    state.fields.push(field);
    state.selectedFieldId = field.id;
    state.addType = null;
    state.addLabel = '';
    state.addPrefillSource = '';
    document.querySelectorAll('.field-add-btn').forEach(function (btn) { btn.classList.remove('active'); });
    renderAllOverlays();
  }

  function attachPageInteractions(pageWrapper, pageNum) {
    const overlay = pageWrapper.querySelector('.field-editor-overlay');
    overlay.addEventListener('click', function (event) {
      if (event.target.closest('.field-editor-field')) return;
      if (!state.addType) {
        state.selectedFieldId = null;
        renderAllOverlays();
        return;
      }
      const rect = overlay.getBoundingClientRect();
      const xPercent = ((event.clientX - rect.left) / rect.width) * 100;
      const yPercent = ((event.clientY - rect.top) / rect.height) * 100;
      placeFieldAt(pageNum, xPercent, yPercent);
    });

    overlay.addEventListener('mousedown', function (event) {
      const target = event.target.closest('.field-editor-field');
      if (!target) return;
      const id = target.dataset.fieldId;
      const field = state.fields.find(function (f) { return f.id === id; });
      if (!field) return;
      selectField(id);
      const overlayRect = overlay.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = field.x;
      const startTop = field.y;

      function onMove(e) {
        const dxPercent = ((e.clientX - startX) / overlayRect.width) * 100;
        const dyPercent = ((e.clientY - startY) / overlayRect.height) * 100;
        field.x = Math.max(0, Math.min(100 - field.width, startLeft + dxPercent));
        field.y = Math.max(0, Math.min(100 - field.height, startTop + dyPercent));
        renderOverlay(pageNum);
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
  }

  function updateZoomDisplay() {
    const el = byId('fieldEditorZoomDisplay');
    if (el) el.textContent = Math.round(state.zoom * 100) + '%';
  }

  async function setZoom(newZoom) {
    state.zoom = Math.max(0.5, Math.min(3, Number(newZoom) || 1));
    updateZoomDisplay();
    await renderPdf();
  }

  async function ensurePdfJsLoaded() {
    if (window.pdfjsLib) return true;
    return new Promise(function (resolve) {
      const start = Date.now();
      const tick = function () {
        if (window.pdfjsLib) return resolve(true);
        if (Date.now() - start > 5000) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function renderPdf() {
    const container = byId('fieldEditorPdfContainer');
    if (!container) return;
    container.innerHTML = '';
    state.pageDimensions = [];

    if (!state.pdfUrl) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-file-pdf"></i><p>This template version has no PDF file attached. Open the template, edit the version, and upload a PDF file there first. Then come back and click Map Fields again.</p></div>';
      return;
    }

    const pdfReady = await ensurePdfJsLoaded();
    if (!pdfReady) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-triangle-exclamation"></i><p>PDF.js library could not load from the CDN. Check your network or try a different browser. <a href="' + escape(state.pdfUrl) + '" target="_blank" rel="noopener noreferrer">Open template PDF in a new tab</a> meanwhile.</p></div>';
      return;
    }

    try {
      // Always re-fetch the PDF document so zoom re-renders work cleanly
      const loadingTask = window.pdfjsLib.getDocument(state.pdfUrl);
      state.pdfDoc = await loadingTask.promise;

      const availableWidth = Math.max(400, container.clientWidth - 60);
      const baseWidth = Math.min(1100, availableWidth) * state.zoom;

      for (let pageNum = 1; pageNum <= state.pdfDoc.numPages; pageNum++) {
        const page = await state.pdfDoc.getPage(pageNum);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = baseWidth / baseViewport.width;
        const viewport = page.getViewport({ scale: scale });

        // Page number label
        const label = document.createElement('div');
        label.className = 'field-editor-page-label';
        label.textContent = 'Page ' + pageNum + ' of ' + state.pdfDoc.numPages;
        container.appendChild(label);

        // Page wrapper holds the canvas + the absolute-positioned field overlay
        const pageWrapper = document.createElement('div');
        pageWrapper.className = 'field-editor-page-wrapper';
        pageWrapper.dataset.fieldPage = pageNum;
        pageWrapper.style.width = viewport.width + 'px';
        pageWrapper.style.height = viewport.height + 'px';

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = 'block';
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
        pageWrapper.appendChild(canvas);

        const overlay = document.createElement('div');
        overlay.className = 'field-editor-overlay';
        pageWrapper.appendChild(overlay);

        container.appendChild(pageWrapper);
        state.pageDimensions.push({ width: viewport.width, height: viewport.height });

        // Render the actual PDF content
        try {
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        } catch (renderErr) {
          console.error('Page', pageNum, 'render failed:', renderErr);
        }

        attachPageInteractions(pageWrapper, pageNum);
      }
      renderAllOverlays();
    } catch (err) {
      console.error('PDF render error:', err);
      container.innerHTML = '<div class="empty-state"><i class="fas fa-triangle-exclamation"></i><p>Could not render PDF: ' + escape(err.message || 'unknown error') + '. <a href="' + escape(state.pdfUrl) + '" target="_blank" rel="noopener noreferrer">Open it directly</a>.</p></div>';
    }
  }

  async function openFieldEditor(options) {
    options = options || {};
    state.templateVersionId = options.templateVersionId || '';
    state.templateName = options.templateName || 'Template';
    state.selectedFieldId = null;
    state.addType = null;
    state.fields = [];
    state.sources = [];
    state.zoom = 1.0;
    updateZoomDisplay();

    if (byId('fieldEditorTitle')) {
      byId('fieldEditorTitle').innerHTML =
        '<i class="fas fa-object-group"></i> Map Fields on ' + escape(state.templateName);
    }
    byId('partnerContractsFieldEditorModal').classList.remove('hidden');
    setStatus('Loading template PDF and field map\u2026');

    try {
      const [pdfRes, sourcesRes] = await Promise.all([
        apiPost('get_template_version_pdf_url', { template_version_id: state.templateVersionId }),
        apiPost('get_merge_sources')
      ]);
      state.pdfUrl = pdfRes.url || '';
      state.fields = (pdfRes.merge_fields || []).map(function (f) {
        return Object.assign({}, f, { id: f.id || makeFieldId() });
      });
      state.sources = sourcesRes.sources || [];

      await renderPdf();
      renderAllOverlays();

      if (!pdfRes.has_pdf || !state.pdfUrl) {
        setStatus('This template version has no PDF file attached. Open the template, edit the version, and upload a PDF file there first. Then come back and click Map Fields again.', 'warning');
      } else {
        setStatus('Template PDF loaded. Click a field type then click anywhere on the PDF to place it.', 'success');
      }
    } catch (err) {
      setStatus('Could not load template: ' + escape(err.message), 'error');
    }
  }

  async function saveFields() {
    if (!state.templateVersionId) return;
    try {
      setStatus('Saving field map\u2026');
      const sanitized = state.fields.map(function (f) {
        return {
          id: f.id,
          type: f.type,
          label: f.label,
          page: Number(f.page || 1),
          x: Number(f.x || 0),
          y: Number(f.y || 0),
          width: Number(f.width || 20),
          height: Number(f.height || 4),
          signer_role: f.signer_role || 'client',
          prefill_source: f.prefill_source || '',
          required: Boolean(f.required)
        };
      });
      await apiPost('save_template_fields', {
        template_version_id: state.templateVersionId,
        merge_fields: sanitized
      });
      setStatus('Saved ' + sanitized.length + ' field(s).', 'success');
    } catch (err) {
      setStatus('Could not save: ' + escape(err.message), 'error');
    }
  }

  function bindEvents() {
    document.querySelectorAll('[data-field-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.addType = btn.dataset.fieldAdd;
        // Optional quick-add metadata: pre-bind a label + CRM source so the user
        // can drop a pre-configured field with one click.
        state.addLabel = btn.dataset.fieldLabel || '';
        state.addPrefillSource = btn.dataset.fieldPrefill || '';
        document.querySelectorAll('.field-add-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var hint = state.addLabel
          ? 'Click on the PDF to place: ' + state.addLabel + (state.addPrefillSource ? ' (auto-fills from CRM)' : '')
          : 'Click anywhere on the PDF to place a ' + btn.dataset.fieldAdd + ' field. Click an existing field to select it, drag to move.';
        setStatus(hint);
      });
    });
    byId('fieldEditorSaveBtn') && byId('fieldEditorSaveBtn').addEventListener('click', saveFields);
    byId('fldApplyBtn') && byId('fldApplyBtn').addEventListener('click', applyFieldForm);
    byId('fldDeleteBtn') && byId('fldDeleteBtn').addEventListener('click', deleteSelectedField);
    byId('fieldEditorList') && byId('fieldEditorList').addEventListener('click', function (event) {
      const item = event.target.closest('[data-list-field-id]');
      if (item) selectField(item.dataset.listFieldId);
    });
    byId('fieldEditorZoomIn') && byId('fieldEditorZoomIn').addEventListener('click', function () { setZoom(state.zoom + 0.2); });
    byId('fieldEditorZoomOut') && byId('fieldEditorZoomOut').addEventListener('click', function () { setZoom(state.zoom - 0.2); });
    byId('fieldEditorZoomReset') && byId('fieldEditorZoomReset').addEventListener('click', function () { setZoom(1.0); });
    byId('fieldEditorZoomFit') && byId('fieldEditorZoomFit').addEventListener('click', function () { setZoom(1.5); });
  }

  bindEvents();
  window.openPartnerContractsFieldEditor = openFieldEditor;
})();
