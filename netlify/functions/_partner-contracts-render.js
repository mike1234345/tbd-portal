/* build:1780028952622 */
// Phase 3C: render a finalized "signed" PDF by stamping field values + signature
// images onto the original template PDF.
//
// Uses pdf-lib (pure JS). No native deps. Field coordinates are stored as
// percentages of page width/height, so we convert to PDF user-space at render time.
// PDF coordinates have origin at bottom-left; our editor used top-left, so we flip Y.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

function pickValue(field, signerValuesById, requestPrefill) {
  if (signerValuesById && signerValuesById[field.id]) return signerValuesById[field.id];
  if (requestPrefill && requestPrefill[field.id]) return requestPrefill[field.id];
  if (field.resolved_value) return field.resolved_value;
  return '';
}

function bytesFromDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', buffer: Buffer.from(m[2], 'base64') };
}

async function downloadTemplatePdf(sb, version) {
  if (!version?.storage_bucket || !version?.storage_object_path) {
    throw new Error('Template version has no source PDF in storage.');
  }
  const { data, error } = await sb.storage.from(version.storage_bucket).download(version.storage_object_path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function renderFinalPdf({
  templatePdfBytes,
  mergeFields = [],
  signers = [],
  resolvedFields = [],
  requestPrefill = {}
}) {
  const pdfDoc = await PDFDocument.load(templatePdfBytes, { ignoreEncryption: true });
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  // Build lookups from signer.id -> embedded signature image AND optional initials image
  // v3.5.1: signers can now draw separate initials, stored in signature_payload.initials_image_data
  const signerById = new Map();
  const signaturesByRole = new Map();
  const initialsByRole = new Map();

  async function embedDataUrl(dataUrl) {
    if (!dataUrl) return null;
    const parsed = bytesFromDataUrl(dataUrl);
    if (!parsed) return null;
    try {
      return await pdfDoc.embedPng(parsed.buffer);
    } catch {
      try { return await pdfDoc.embedJpg(parsed.buffer); } catch { return null; }
    }
  }

  for (const s of signers) {
    signerById.set(s.id, s);
    const role = s.signer_role || 'client';
    // Main signature image
    if (s.signature_image_data) {
      const img = await embedDataUrl(s.signature_image_data);
      if (img) signaturesByRole.set(role, { img, signer: s });
    }
    // Optional separately-drawn initials (v3.5.1)
    const payload = (s.signature_payload && typeof s.signature_payload === 'object') ? s.signature_payload : {};
    if (payload.initials_image_data) {
      const img = await embedDataUrl(payload.initials_image_data);
      if (img) initialsByRole.set(role, { img, signer: s });
    }
  }

  // Build resolvedById for fast lookup
  const resolvedById = new Map();
  for (const f of resolvedFields || []) {
    resolvedById.set(f.id, f);
  }

  for (const field of mergeFields) {
    const pageIdx = Math.max(0, Math.min(pages.length - 1, Number(field.page || 1) - 1));
    const page = pages[pageIdx];
    const { width: pw, height: ph } = page.getSize();
    const xPct = Number(field.x || 0);
    const yPct = Number(field.y || 0);
    const wPct = Number(field.width || 20);
    const hPct = Number(field.height || 4);
    const x = (xPct / 100) * pw;
    const wPx = (wPct / 100) * pw;
    const hPx = (hPct / 100) * ph;
    // Convert top-left origin (editor) to bottom-left origin (PDF)
    const y = ph - ((yPct / 100) * ph) - hPx;

    if (field.type === 'signature' || field.type === 'initials') {
      const role = field.signer_role || 'client';
      // v3.5.6: For initials fields, ONLY render the drawn initials image (or the drawn
      // signature image if the signer chose "Copy from signature"). Never type out the
      // initials from the name — if the signer hasn't signed yet, the field stays BLANK.
      // This prevents "phantom" typed initials appearing for cosigners who haven't signed.
      let entry = null;
      if (field.type === 'initials') {
        entry = initialsByRole.get(role) || signaturesByRole.get(role);
      } else {
        entry = signaturesByRole.get(role);
      }
      if (entry && entry.img) {
        const dims = entry.img.scaleToFit(wPx, hPx);
        const drawX = x + (wPx - dims.width) / 2;
        const drawY = y + (hPx - dims.height) / 2;
        page.drawImage(entry.img, { x: drawX, y: drawY, width: dims.width, height: dims.height });
      }
      // No fallback. Field stays blank until the actual signer draws something.
      continue;
    }

    if (field.type === 'checkbox') {
      const resolved = resolvedById.get(field.id);
      const checked = String(resolved?.resolved_value || requestPrefill[field.id] || '').toLowerCase();
      const isChecked = ['1', 'true', 'yes', 'on', 'checked', 'x'].includes(checked);
      if (isChecked) {
        const cx = x + wPx / 2;
        const cy = y + hPx / 2;
        const r = Math.min(wPx, hPx) * 0.35;
        page.drawText('X', { x: cx - r * 0.55, y: cy - r * 0.55, size: r * 1.6, font: helvBold, color: rgb(0, 0, 0) });
      }
      continue;
    }

    // Text or date
    const resolved = resolvedById.get(field.id);
    const value = resolved?.resolved_value || requestPrefill[field.id] || '';
    if (!value) continue;
    const fontSize = Math.min(hPx * 0.7, 12);
    // Truncate to fit width using rough Helvetica metric
    let text = String(value);
    const maxChars = Math.max(1, Math.floor(wPx / (fontSize * 0.5)));
    if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '\u2026';
    page.drawText(text, { x: x + 2, y: y + hPx * 0.3, size: fontSize, font: helv, color: rgb(0, 0, 0) });
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = {
  renderFinalPdf,
  downloadTemplatePdf,
  bytesFromDataUrl
};
