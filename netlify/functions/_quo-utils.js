/* build:1780028952622 */
// Shared utilities for Quo (formerly OpenPhone) integration
// Used by quo-webhook.js, quo-numbers.js, quo-dial-link.js
const crypto = require('node:crypto');

const QUO_API_BASE = 'https://api.openphone.com/v1';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function response(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  };
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function getApiKey() {
  return process.env.QUO_API_KEY || '';
}

function getWebhookSecret() {
  return process.env.QUO_WEBHOOK_SECRET || '';
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  // Lazy-require so build does not fail if pkg missing in any function dir
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function quoApi(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('QUO_API_KEY not configured in Netlify env vars');
  const res = await fetch(`${QUO_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Quo API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

/**
 * Verify the webhook signature sent by Quo.
 * Quo signs payloads with HMAC-SHA256 using the shared secret.
 * Header name: openphone-signature
 * Format: hmac;1;<timestamp>;<base64-signature>
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = getWebhookSecret();
  if (!secret) {
    console.warn('[quo-webhook] QUO_WEBHOOK_SECRET not set - signature verification skipped');
    return { ok: true, skipped: true };
  }
  if (!signatureHeader) return { ok: false, reason: 'missing signature header' };
  const parts = String(signatureHeader).split(';');
  if (parts.length < 4) return { ok: false, reason: 'malformed signature' };
  const [scheme, version, timestamp, providedSig] = parts;
  if (scheme !== 'hmac') return { ok: false, reason: 'unsupported scheme' };
  const signedData = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', Buffer.from(secret, 'base64').toString('utf8').length === Buffer.from(secret, 'base64').length
      ? Buffer.from(secret, 'base64')
      : secret)
    .update(signedData)
    .digest('base64');
  // timing-safe compare
  try {
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(providedSig);
    if (expectedBuf.length !== providedBuf.length) return { ok: false, reason: 'length mismatch' };
    const match = crypto.timingSafeEqual(expectedBuf, providedBuf);
    return match ? { ok: true } : { ok: false, reason: 'signature mismatch' };
  } catch (err) {
    return { ok: false, reason: 'compare error: ' + err.message };
  }
}

/** Normalize a Quo phone number ID (PNxxxx) or E.164 number into a display string. */
function formatPhoneE164(value = '') {
  const cleaned = String(value || '').replace(/[^0-9+]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  return cleaned;
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = {
  QUO_API_BASE,
  response,
  corsHeaders,
  requireEnv,
  getApiKey,
  getWebhookSecret,
  getSupabase,
  quoApi,
  verifyWebhookSignature,
  formatPhoneE164,
  safeDate
};
