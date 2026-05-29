/* build:1780028952622 */
// Postmark-based outbound email for Partner Contracts.
// Reads configuration from environment variables:
//   POSTMARK_SERVER_TOKEN   - Postmark Server API token
//   CONTRACT_FROM_EMAIL     - Default "From" address (must be a verified Postmark sender)
//   CONTRACT_FROM_NAME      - Optional friendly sender name
//   CONTRACT_PUBLIC_BASE_URL - Optional override for signing links (defaults to event host)
//   POSTMARK_MESSAGE_STREAM - Optional message stream id (defaults to "outbound")
//
// All sends are best-effort: failures are returned to the caller so the UI can
// fall back to the mailto launchpad if the provider is misconfigured.

const POSTMARK_API_URL = 'https://api.postmarkapp.com/email';

// Hardcoded defaults so the system works without env vars.
// These can still be overridden via env vars or via the in-dashboard Setup page
// which stores values in the crm_app_settings table.
const DEFAULT_FROM_EMAIL = 'mike@rapidresponseresto.com';
const DEFAULT_FROM_NAME = 'Rapid Response Restoration';
const DEFAULT_MESSAGE_STREAM = 'outbound';

// In-memory cache of settings loaded from Supabase
let cachedSettings = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30000;

async function loadSettings(sb) {
  if (!sb) return cachedSettings || {};
  const now = Date.now();
  if (cachedSettings && now - cacheLoadedAt < CACHE_TTL_MS) return cachedSettings;
  try {
    const { data } = await sb.from('crm_app_settings').select('setting_key, setting_value').in('setting_key', [
      'postmark_server_token',
      'contract_from_email',
      'contract_from_name',
      'contract_public_base_url',
      'postmark_message_stream',
      'postmark_webhook_secret'
    ]);
    const settings = {};
    (data || []).forEach((row) => {
      settings[row.setting_key] = row.setting_value;
    });
    cachedSettings = settings;
    cacheLoadedAt = now;
    return settings;
  } catch {
    return cachedSettings || {};
  }
}

function clearSettingsCache() {
  cachedSettings = null;
  cacheLoadedAt = 0;
}

async function getPostmarkToken(sb) {
  const envToken = String(process.env.POSTMARK_SERVER_TOKEN || '').trim();
  if (envToken) return envToken;
  const settings = await loadSettings(sb);
  return String(settings.postmark_server_token || '').trim();
}

async function getFromEmail(sb) {
  const envValue = String(process.env.CONTRACT_FROM_EMAIL || '').trim();
  if (envValue) return envValue;
  const settings = await loadSettings(sb);
  return String(settings.contract_from_email || DEFAULT_FROM_EMAIL).trim();
}

async function getFromName(sb) {
  const envValue = String(process.env.CONTRACT_FROM_NAME || '').trim();
  if (envValue) return envValue;
  const settings = await loadSettings(sb);
  return String(settings.contract_from_name || DEFAULT_FROM_NAME).trim();
}

async function getMessageStream(sb) {
  const envValue = String(process.env.POSTMARK_MESSAGE_STREAM || '').trim();
  if (envValue) return envValue;
  const settings = await loadSettings(sb);
  return String(settings.postmark_message_stream || DEFAULT_MESSAGE_STREAM).trim();
}

async function getWebhookSecret(sb) {
  const envValue = String(process.env.POSTMARK_WEBHOOK_SECRET || '').trim();
  if (envValue) return envValue;
  const settings = await loadSettings(sb);
  return String(settings.postmark_webhook_secret || '').trim();
}

async function isEmailConfigured(sb) {
  const token = await getPostmarkToken(sb);
  const fromEmail = await getFromEmail(sb);
  return Boolean(token && fromEmail);
}

async function resolveFromHeader(sb) {
  const fromEmail = await getFromEmail(sb);
  const fromName = await getFromName(sb);
  if (!fromEmail) return '';
  return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
}

async function resolveBaseUrl(event, sb) {
  const explicit = String(process.env.CONTRACT_PUBLIC_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  if (sb) {
    const settings = await loadSettings(sb);
    const stored = String(settings.contract_public_base_url || '').trim();
    if (stored) return stored.replace(/\/$/, '');
  }
  const headers = event?.headers || {};
  const proto = headers['x-forwarded-proto'] || 'https';
  const host = headers.host || headers['x-forwarded-host'] || '';
  if (!host) return '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function buildSigningUrl(baseUrl, token) {
  if (!baseUrl || !token) return '';
  return `${baseUrl}/contract-signing/index.html?token=${encodeURIComponent(token)}`;
}

function applyTokens(template, context) {
  const map = {
    signer_name: context.signer_name || '',
    signer_email: context.signer_email || '',
    client_name: context.client_name || '',
    client_email: context.client_email || '',
    partner_name: context.partner_name || '',
    request_title: context.request_title || '',
    template_name: context.template_name || '',
    signing_url: context.signing_url || ''
  };
  return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key) => map[key] || '');
}

function defaultSubject(context) {
  if (context.template_name && context.partner_name) {
    return `Please sign: ${context.template_name} for ${context.partner_name}`;
  }
  return context.request_title ? `Please sign: ${context.request_title}` : 'Signature request';
}

function defaultBody(context) {
  return [
    `Hello ${context.signer_name || 'there'},`,
    '',
    `${context.partner_name || 'Our team'} has prepared a signature request for ${context.request_title || 'your contract'}.`,
    'Please review and sign using the secure link below:',
    context.signing_url || '(signing link unavailable)',
    '',
    'If you have any questions, reply to this email before signing.',
    '',
    'Thank you'
  ].join('\n');
}

function textToHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br />');
}

async function sendPostmarkEmail({ sb, to, cc, subject, textBody, htmlBody, messageStream }) {
  const token = await getPostmarkToken(sb);
  const fromHeader = await resolveFromHeader(sb);
  if (!token || !fromHeader) {
    return { sent: false, skipped: true, reason: 'Postmark is not configured. Open the Setup page to add your Postmark Server Token.' };
  }
  if (!to) {
    return { sent: false, skipped: true, reason: 'Recipient email missing.' };
  }
  const stream = messageStream || await getMessageStream(sb);
  const payload = {
    From: fromHeader,
    To: to,
    Subject: subject || 'Signature request',
    TextBody: textBody || '',
    HtmlBody: htmlBody || textToHtml(textBody || ''),
    MessageStream: stream
  };
  if (cc) payload.Cc = cc;
  try {
    const res = await fetch(POSTMARK_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token
      },
      body: JSON.stringify(payload)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json.ErrorCode && json.ErrorCode !== 0)) {
      const message = json.Message || json.error || `Postmark returned status ${res.status}`;
      return { sent: false, error: message, provider: 'postmark', raw: json };
    }
    return { sent: true, provider: 'postmark', message_id: json.MessageID || null, raw: json };
  } catch (error) {
    return { sent: false, error: error.message || 'Postmark request failed.', provider: 'postmark' };
  }
}

function buildSignerEmail({ request, signer, partner, template, signingUrl }) {
  const tokenContext = {
    signer_name: signer.signer_name || '',
    signer_email: signer.signer_email || '',
    client_name: request.client_name || '',
    client_email: request.client_email || '',
    partner_name: partner?.display_name || partner?.business_name || '',
    request_title: request.request_title || '',
    template_name: template?.template_name || '',
    signing_url: signingUrl
  };
  const subject = applyTokens(request.email_subject || defaultSubject(tokenContext), tokenContext);
  const text = applyTokens(request.email_message || defaultBody(tokenContext), tokenContext);
  return {
    subject,
    text,
    html: textToHtml(text)
  };
}

module.exports = {
  isEmailConfigured,
  resolveBaseUrl,
  buildSigningUrl,
  buildSignerEmail,
  sendPostmarkEmail,
  applyTokens,
  textToHtml,
  loadSettings,
  clearSettingsCache,
  getPostmarkToken,
  getFromEmail,
  getFromName,
  getMessageStream,
  getWebhookSecret,
  DEFAULT_FROM_EMAIL,
  DEFAULT_FROM_NAME,
  DEFAULT_MESSAGE_STREAM
};
