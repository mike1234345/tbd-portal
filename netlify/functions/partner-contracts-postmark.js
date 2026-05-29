/* build:1780028952622 */
// Postmark webhook endpoint for the partner contracts pipeline.
// Configure this URL in Postmark -> Servers -> [Server] -> Settings -> Webhooks:
//   https://<your-domain>/.netlify/functions/partner-contracts-postmark
//
// Recommended events to forward:
//   Delivery, Open, Bounce, SpamComplaint, SubscriptionChange, Click
//
// Optional secret check: set POSTMARK_WEBHOOK_SECRET in Netlify env, then add
// ?secret=<value> to the webhook URL.

const {
  response,
  corsHeaders,
  readJsonBody,
  cleanEmail,
  cleanText,
  getRequiredSupabase,
  insertContractEvent
} = require('./_partner-contracts-utils');

const POSTMARK_EVENT_MAP = {
  Delivery: 'email_delivered',
  Open: 'email_opened',
  Bounce: 'email_bounced',
  SpamComplaint: 'email_spam_complaint',
  Click: 'email_link_clicked'
};

function detectEventType(body) {
  if (body.RecordType) return body.RecordType;
  if (body.MessageEvent) return body.MessageEvent;
  if (body.Type) return body.Type;
  return '';
}

async function findSignerByMessageOrEmail(sb, { messageId, recipientEmail }) {
  if (messageId) {
    const { data, error } = await sb
      .from('crm_contract_events')
      .select('owner_admin_id, request_id, signer_id, template_id, event_data')
      .eq('event_type', 'email_sent')
      .contains('event_data', { message_id: messageId })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.signer_id) return data;
  }
  if (recipientEmail) {
    const { data, error } = await sb
      .from('crm_contract_signers')
      .select('id, owner_admin_id, request_id')
      .eq('signer_email', recipientEmail)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.id) {
      const { data: req, error: reqErr } = await sb
        .from('crm_contract_requests')
        .select('owner_admin_id, template_id')
        .eq('id', data.request_id)
        .maybeSingle();
      if (reqErr) throw reqErr;
      return {
        owner_admin_id: data.owner_admin_id,
        request_id: data.request_id,
        signer_id: data.id,
        template_id: req?.template_id || null
      };
    }
  }
  return null;
}

async function handleEvent(sb, body) {
  const recordType = detectEventType(body);
  const eventType = POSTMARK_EVENT_MAP[recordType];
  if (!eventType) return { skipped: true, reason: `Unsupported Postmark record: ${recordType || 'unknown'}` };
  const messageId = cleanText(body.MessageID || body.MessageId || '');
  const recipientEmail = cleanEmail(body.Recipient || body.Email || '');
  const match = await findSignerByMessageOrEmail(sb, { messageId, recipientEmail });
  if (!match) return { skipped: true, reason: 'No matching signer or request found for this webhook payload.' };

  await insertContractEvent(sb, {
    owner_admin_id: match.owner_admin_id,
    request_id: match.request_id,
    signer_id: match.signer_id,
    template_id: match.template_id,
    event_type: eventType,
    actor_type: 'system',
    event_data: {
      provider: 'postmark',
      record_type: recordType,
      message_id: messageId,
      recipient: recipientEmail,
      raw_summary: pickRelevantFields(body)
    }
  });

  if (eventType === 'email_bounced') {
    await sb.from('crm_contract_signers').update({ status: 'bounced' }).eq('id', match.signer_id);
  }
  if (eventType === 'email_opened' && match.signer_id) {
    const { data: signer } = await sb.from('crm_contract_signers').select('status, viewed_at').eq('id', match.signer_id).maybeSingle();
    if (signer && !signer.viewed_at && ['sent'].includes(signer.status)) {
      await sb.from('crm_contract_signers').update({ status: 'viewed', viewed_at: new Date().toISOString() }).eq('id', match.signer_id);
    }
  }

  return { processed: true, event_type: eventType };
}

function pickRelevantFields(body) {
  const keep = ['Tag', 'BouncedAt', 'DeliveredAt', 'Subject', 'Description', 'Details', 'ReceivedAt', 'Platform', 'Client', 'Geo', 'OriginalLink', 'OriginalLinkUrl'];
  const out = {};
  keep.forEach((key) => {
    if (body[key] !== undefined) out[key] = body[key];
  });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, '', corsHeaders());
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' }, corsHeaders());

  try {
    const sb = getRequiredSupabase();
    const { getWebhookSecret } = require('./_partner-contracts-email');
    const requiredSecret = await getWebhookSecret(sb);
    if (requiredSecret) {
      const provided = event.queryStringParameters?.secret || '';
      if (provided !== requiredSecret) {
        return response(401, { error: 'Invalid webhook secret.' }, corsHeaders());
      }
    }
    const body = await readJsonBody(event);
    // Postmark may batch events as an array
    const items = Array.isArray(body) ? body : [body];
    const results = [];
    for (const item of items) {
      results.push(await handleEvent(sb, item || {}));
    }
    return response(200, { received: results.length, results }, corsHeaders());
  } catch (error) {
    console.error('[partner-contracts-postmark] error:', error);
    return response(error.statusCode || 500, { error: error.message || 'Unexpected webhook error.' }, corsHeaders());
  }
};
