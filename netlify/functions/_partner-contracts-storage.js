/* build:1780028952622 */
// Supabase Storage helpers for partner contracts.
// Bucket: partner-contracts
//
// Conventions:
//   templates/<partner_profile_id>/<template_id>/<version_id>/<filename>
//   requests/<request_id>/signed/<filename>
//   requests/<request_id>/audit/<filename>

const PARTNER_CONTRACTS_BUCKET = 'partner-contracts';

function templateObjectPath(partnerProfileId, templateId, versionId, filename) {
  const safeName = sanitizeFilename(filename || 'template.pdf');
  return `templates/${partnerProfileId}/${templateId}/${versionId || 'pending'}/${safeName}`;
}

function requestPdfObjectPath(requestId, kind, filename) {
  const safeName = sanitizeFilename(filename || `${kind}.pdf`);
  const folder = kind === 'signed' ? 'signed' : kind === 'audit' ? 'audit' : 'attachments';
  return `requests/${requestId}/${folder}/${safeName}`;
}

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'file';
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/);
  if (!match) throw Object.assign(new Error('Expected a data URL with base64 payload.'), { statusCode: 400 });
  return { mime: match[1] || 'application/octet-stream', buffer: Buffer.from(match[2], 'base64') };
}

async function uploadBuffer(sb, { bucket = PARTNER_CONTRACTS_BUCKET, path, buffer, contentType, upsert = true }) {
  if (!path) throw new Error('Storage object path is required.');
  if (!buffer) throw new Error('Storage upload requires a buffer.');
  const { data, error } = await sb.storage.from(bucket).upload(path, buffer, {
    contentType: contentType || 'application/octet-stream',
    upsert
  });
  if (error) throw error;
  return data;
}

async function createSignedUrl(sb, { bucket = PARTNER_CONTRACTS_BUCKET, path, expiresInSeconds = 600 }) {
  if (!path) throw new Error('Cannot sign empty path.');
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error) throw error;
  return data?.signedUrl || '';
}

async function downloadObject(sb, { bucket = PARTNER_CONTRACTS_BUCKET, path }) {
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error) throw error;
  return data;
}

module.exports = {
  PARTNER_CONTRACTS_BUCKET,
  templateObjectPath,
  requestPdfObjectPath,
  sanitizeFilename,
  dataUrlToBuffer,
  uploadBuffer,
  createSignedUrl,
  downloadObject
};
