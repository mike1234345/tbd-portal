/* build:1780028952622 */
// Minimal pure-JS PDF generator for partner contracts.
// No native deps — produces a tagged single-stream PDF with one or many pages of text.
// Suitable for audit trail + signed contract summary documents.
//
// Why custom: keeps the Netlify function bundle tiny and deterministic.
// For richer layouts (logos, signatures inline) you can later swap in pdfkit.

function encodeText(value) {
  // PDF text strings use parentheses; escape special characters
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapText(text, maxChars = 92) {
  const lines = [];
  String(text || '').split(/\r?\n/).forEach((paragraph) => {
    if (!paragraph) {
      lines.push('');
      return;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    words.forEach((word) => {
      if (!current) {
        current = word;
        return;
      }
      if ((current + ' ' + word).length > maxChars) {
        lines.push(current);
        current = word;
      } else {
        current += ' ' + word;
      }
    });
    if (current) lines.push(current);
  });
  return lines;
}

function buildPdf(sections, options = {}) {
  const title = options.title || 'Contract Audit Trail';
  const fontSize = options.fontSize || 11;
  const lineHeight = options.lineHeight || 16;
  const margin = options.margin || 54;
  const pageWidth = 612;
  const pageHeight = 792;
  const maxLinesPerPage = Math.floor((pageHeight - margin * 2 - 40) / lineHeight);

  // Build pages of lines
  const flatLines = [];
  sections.forEach((section, sectionIndex) => {
    if (section.heading) flatLines.push({ type: 'heading', text: section.heading });
    (section.lines || []).forEach((line) => flatLines.push({ type: 'body', text: line }));
    if (sectionIndex < sections.length - 1) flatLines.push({ type: 'spacer' });
  });

  const pages = [];
  let currentPage = [];
  for (const item of flatLines) {
    if (currentPage.length >= maxLinesPerPage) {
      pages.push(currentPage);
      currentPage = [];
    }
    currentPage.push(item);
  }
  if (currentPage.length) pages.push(currentPage);
  if (!pages.length) pages.push([{ type: 'body', text: '(no content)' }]);

  const objects = [];
  function addObject(content) {
    objects.push(content);
    return objects.length; // 1-indexed object id
  }

  const fontRegularId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const pageObjectIds = [];
  const contentObjectIds = [];

  pages.forEach((pageLines, pageIndex) => {
    const stream = renderPageStream(pageLines, { title, margin, pageHeight, fontSize, lineHeight, pageIndex, totalPages: pages.length });
    const contentId = addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    contentObjectIds.push(contentId);
  });

  // Pages object will be created after page objects.
  const pagesObjectId = objects.length + pages.length + 1;
  pages.forEach((_, idx) => {
    const pageContent = `<< /Type /Page /Parent ${pagesObjectId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentObjectIds[idx]} 0 R >>`;
    const pageId = addObject(pageContent);
    pageObjectIds.push(pageId);
  });
  const pagesObjContent = `<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  const pagesId = addObject(pagesObjContent);
  if (pagesId !== pagesObjectId) {
    // sanity check; if mismatched, regenerate with correct parent references
    for (let i = 0; i < pageObjectIds.length; i += 1) {
      objects[pageObjectIds[i] - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentObjectIds[i]} 0 R >>`;
    }
  }
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  return assemblePdf(objects, catalogId);
}

function renderPageStream(lines, ctx) {
  const { title, margin, pageHeight, fontSize, lineHeight, pageIndex, totalPages } = ctx;
  const startY = pageHeight - margin;
  let cursorY = startY;
  let stream = '';

  // Title (page 1 only)
  if (pageIndex === 0) {
    stream += `BT /F2 18 Tf ${margin} ${cursorY} Td (${encodeText(title)}) Tj ET\n`;
    cursorY -= 28;
  } else {
    stream += `BT /F2 12 Tf ${margin} ${cursorY} Td (${encodeText(title + ' (continued)')}) Tj ET\n`;
    cursorY -= 24;
  }

  for (const item of lines) {
    if (cursorY < margin + 20) break;
    if (item.type === 'heading') {
      stream += `BT /F2 13 Tf ${margin} ${cursorY} Td (${encodeText(item.text)}) Tj ET\n`;
      cursorY -= lineHeight + 4;
    } else if (item.type === 'spacer') {
      cursorY -= lineHeight / 2;
    } else {
      stream += `BT /F1 ${fontSize} Tf ${margin} ${cursorY} Td (${encodeText(item.text)}) Tj ET\n`;
      cursorY -= lineHeight;
    }
  }

  // Footer with page number
  stream += `BT /F1 9 Tf ${margin} ${margin / 2 + 4} Td (${encodeText(`Page ${pageIndex + 1} of ${totalPages}`)}) Tj ET\n`;

  return stream;
}

function assemblePdf(objects, catalogId) {
  const chunks = ['%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'];
  const offsets = [];
  let cursor = Buffer.byteLength(chunks[0], 'binary');
  objects.forEach((body, idx) => {
    offsets.push(cursor);
    const objectBytes = `${idx + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(objectBytes);
    cursor += Buffer.byteLength(objectBytes, 'binary');
  });
  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  return Buffer.from(chunks.join(''), 'binary');
}

function buildSignedPdf({ request, signers, events, partner, template }) {
  const lines = [];
  lines.push(`Request: ${request.request_title || ''}`);
  lines.push(`Status: ${request.status || ''}`);
  lines.push(`Partner: ${partner?.display_name || partner?.business_name || ''}`);
  lines.push(`Template: ${template?.template_name || ''}`);
  lines.push(`Client: ${request.client_name || request.client_email || ''}`);
  lines.push(`Sent: ${request.sent_at || ''}`);
  lines.push(`Completed: ${request.completed_at || ''}`);
  lines.push('');

  const signerLines = ['Signer Order:'];
  signers.forEach((signer, idx) => {
    signerLines.push(`${idx + 1}. ${signer.signer_name || ''} <${signer.signer_email || ''}>`);
    signerLines.push(`   Role: ${signer.signer_role || 'client'}  Status: ${signer.status || ''}  Order: ${signer.routing_order || ''}`);
    if (signer.signed_at) signerLines.push(`   Signed at: ${signer.signed_at}`);
    if (signer.declined_at) signerLines.push(`   Declined at: ${signer.declined_at}  Note: ${signer.decision_note || ''}`);
    if (signer.signature_payload?.typed_name) signerLines.push(`   Typed name: ${signer.signature_payload.typed_name}`);
  });

  const eventLines = ['Activity Timeline:'];
  events.slice().reverse().forEach((event) => {
    eventLines.push(`- ${event.created_at || ''}  ${event.event_type || ''}`);
    if (event.event_data?.signer_name) eventLines.push(`    Signer: ${event.event_data.signer_name}`);
    if (event.event_data?.error) eventLines.push(`    Error: ${event.event_data.error}`);
  });

  const messageLines = [];
  if (request.email_message) {
    messageLines.push('Email Message:');
    wrapText(request.email_message).forEach((line) => messageLines.push(line));
  }

  const sections = [
    { heading: 'Contract Summary', lines: wrapText(lines.join('\n')) },
    { heading: 'Signers', lines: wrapText(signerLines.join('\n')) },
    { heading: 'Audit Trail', lines: wrapText(eventLines.join('\n')) }
  ];
  if (messageLines.length) sections.push({ heading: 'Message', lines: wrapText(messageLines.join('\n')) });

  return buildPdf(sections, { title: `Signed Contract Summary - ${request.request_title || ''}` });
}

function buildAuditPdf({ request, signers, events, partner }) {
  const sections = [
    {
      heading: 'Request',
      lines: wrapText([
        `Title: ${request.request_title || ''}`,
        `Status: ${request.status || ''}`,
        `Partner: ${partner?.display_name || partner?.business_name || ''}`,
        `Client: ${request.client_name || ''} <${request.client_email || ''}>`,
        `Created: ${request.created_at || ''}`,
        `Sent: ${request.sent_at || ''}`,
        `Completed: ${request.completed_at || ''}`
      ].join('\n'))
    },
    {
      heading: 'Signers',
      lines: wrapText(signers.map((signer, idx) => `${idx + 1}. ${signer.signer_name} <${signer.signer_email}> [${signer.status}] order ${signer.routing_order}`).join('\n'))
    },
    {
      heading: 'Audit Events',
      lines: wrapText(events.slice().reverse().map((event) => `${event.created_at} - ${event.event_type} - ${JSON.stringify(event.event_data || {})}`).join('\n'))
    }
  ];
  return buildPdf(sections, { title: `Audit Trail - ${request.request_title || ''}` });
}

module.exports = {
  buildPdf,
  buildSignedPdf,
  buildAuditPdf,
  wrapText
};
