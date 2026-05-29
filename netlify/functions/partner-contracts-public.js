/* build:1780028952622 */
const {
  response,
  corsHeaders,
  readJsonBody,
  cleanText,
  getRequiredSupabase,
  insertContractEvent
} = require('./_partner-contracts-utils');

const {
  PARTNER_CONTRACTS_BUCKET,
  requestPdfObjectPath,
  uploadBuffer
} = require('./_partner-contracts-storage');
const { buildSignedPdf, buildAuditPdf } = require('./_partner-contracts-pdf');
const { resolveFieldValues, buildSourceValues } = require('./_partner-contracts-merge');
const { renderFinalPdf, downloadTemplatePdf } = require('./_partner-contracts-render');
const {
  isEmailConfigured,
  resolveBaseUrl,
  buildSigningUrl: buildSignerSigningUrl,
  buildSignerEmail,
  sendPostmarkEmail,
  applyTokens,
  textToHtml
} = require('./_partner-contracts-email');

// Sends the signing email to the next-up signer(s) after a previous signer signs.
// Called from completeSignerSession after promoteNextSignerGroup advances routing_order.
async function deliverEmailsToActiveSigners(sb, requestRow, signers, event) {
  try {
    if (!(await isEmailConfigured(sb))) {
      return { sent: 0, attempted: 0, skipped: true };
    }
    const baseUrl = await resolveBaseUrl(event, sb);
    const [{ data: partner }, { data: template }] = await Promise.all([
      sb.from('crm_partner_profiles').select('*').eq('id', requestRow.partner_profile_id).maybeSingle(),
      sb.from('crm_contract_templates').select('*').eq('id', requestRow.template_id).maybeSingle()
    ]);
    // Only target signers that are currently active (just got promoted to 'sent')
    // and haven't already been emailed in the last 10 seconds (idempotency guard).
    const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
    const targets = (signers || []).filter((row) => {
      if (!['sent', 'viewed'].includes(row.status)) return false;
      if (row.signed_at) return false;
      if (row.last_email_at && row.last_email_at > tenSecondsAgo) return false;
      return true;
    });
    let sentCount = 0;
    for (const signer of targets) {
      const signingUrl = buildSignerSigningUrl(baseUrl, signer.signing_token);
      const built = buildSignerEmail({ request: requestRow, signer, partner, template, signingUrl });
      const result = await sendPostmarkEmail({
        sb,
        to: signer.signer_email,
        cc: Array.isArray(requestRow.cc_emails) ? requestRow.cc_emails.join(',') : '',
        subject: built.subject,
        textBody: built.text,
        htmlBody: built.html
      });
      await insertContractEvent(sb, {
        owner_admin_id: requestRow.owner_admin_id,
        request_id: requestRow.id,
        signer_id: signer.id,
        template_id: requestRow.template_id,
        event_type: result.sent ? 'email_sent' : 'email_failed',
        actor_type: 'system',
        event_data: {
          provider: result.provider || 'postmark',
          signer_email: signer.signer_email,
          signer_name: signer.signer_name,
          routing_order: signer.routing_order,
          message_id: result.message_id || null,
          error: result.error || null,
          trigger: 'sequential_signing'
        }
      });
      if (result.sent) {
        sentCount += 1;
        await sb.from('crm_contract_signers').update({ last_email_at: new Date().toISOString() }).eq('id', signer.id);
      }
    }
    return { sent: sentCount, attempted: targets.length, skipped: false };
  } catch (err) {
    console.error('[partner-contracts-public] deliverEmailsToActiveSigners failed:', err);
    return { sent: 0, attempted: 0, error: err.message };
  }
}

// Sends a "contract fully signed" notification to client + partner + cosigners + admin
// once the request status flips to 'signed'. Includes the rendered PDF link if available.
async function deliverCompletionEmails(sb, requestRow, signers, event) {
  try {
    if (!(await isEmailConfigured(sb))) return { sent: 0, skipped: true };
    const baseUrl = await resolveBaseUrl(event, sb);

    // Build a signed-URL link to the rendered PDF (10 minutes is too short for an email;
    // use 7 days so partner/client can come back to it).
    let renderedPdfUrl = '';
    if (requestRow.rendered_pdf_path) {
      try {
        const { data: signedUrl } = await sb.storage
          .from(requestRow.rendered_pdf_storage_bucket || PARTNER_CONTRACTS_BUCKET)
          .createSignedUrl(requestRow.rendered_pdf_path, 60 * 60 * 24 * 7);
        renderedPdfUrl = signedUrl?.signedUrl || '';
      } catch (e) { /* non-fatal */ }
    }

    // Load partner + template + admin contact
    const [{ data: partner }, { data: template }, { data: adminUser }] = await Promise.all([
      sb.from('crm_partner_profiles').select('*').eq('id', requestRow.partner_profile_id).maybeSingle(),
      sb.from('crm_contract_templates').select('*').eq('id', requestRow.template_id).maybeSingle(),
      sb.from('crm_user_profiles').select('display_name, email').eq('id', requestRow.owner_admin_id).maybeSingle().catch(() => ({ data: null }))
    ]);

    // Recipient set: dedup by email
    const recipients = new Map();
    (signers || []).forEach((s) => {
      if (s.signer_email) recipients.set(String(s.signer_email).toLowerCase(), { name: s.signer_name, email: s.signer_email, role: s.signer_role });
    });
    const partnerEmail = partner?.contact_email || partner?.email;
    if (partnerEmail && !recipients.has(String(partnerEmail).toLowerCase())) {
      recipients.set(String(partnerEmail).toLowerCase(), { name: partner.display_name || partner.business_name || 'Partner', email: partnerEmail, role: 'partner_profile' });
    }
    if (adminUser?.email && !recipients.has(String(adminUser.email).toLowerCase())) {
      recipients.set(String(adminUser.email).toLowerCase(), { name: adminUser.display_name || 'Admin', email: adminUser.email, role: 'admin' });
    }

    const subject = `✅ Contract fully signed: ${requestRow.request_title || template?.template_name || 'Contract'}`;
    let sentCount = 0;
    for (const r of recipients.values()) {
      const greeting = r.name ? `Hello ${r.name},` : 'Hello,';
      const bodyLines = [
        greeting,
        '',
        `Great news — every signer has completed "${requestRow.request_title || template?.template_name || 'this contract'}".`,
        '',
        renderedPdfUrl
          ? `View / download the fully-signed PDF here (link expires in 7 days):\n${renderedPdfUrl}`
          : 'The fully-signed contract is now available in your DocuMike dashboard.',
        '',
        partner?.display_name ? `Partner: ${partner.display_name}` : '',
        `Signers: ${(signers || []).map((s) => `${s.signer_name} (${s.signer_role})`).join(', ')}`,
        '',
        'Thank you for using DocuMike.'
      ].filter(Boolean);
      const textBody = bodyLines.join('\n');
      const htmlBody = textToHtml(textBody);
      const result = await sendPostmarkEmail({
        sb,
        to: r.email,
        subject,
        textBody,
        htmlBody
      });
      await insertContractEvent(sb, {
        owner_admin_id: requestRow.owner_admin_id,
        request_id: requestRow.id,
        template_id: requestRow.template_id,
        event_type: result.sent ? 'email_sent' : 'email_failed',
        actor_type: 'system',
        event_data: {
          provider: result.provider || 'postmark',
          recipient_email: r.email,
          recipient_role: r.role,
          subject,
          rendered_pdf_url: renderedPdfUrl || null,
          error: result.error || null,
          trigger: 'completion_notification'
        }
      });
      if (result.sent) sentCount += 1;
    }
    return { sent: sentCount, attempted: recipients.size, skipped: false };
  } catch (err) {
    console.error('[partner-contracts-public] deliverCompletionEmails failed:', err);
    return { sent: 0, error: err.message };
  }
}

async function generateRenderedPdf(sb, requestRow) {
  if (!requestRow.template_version_id) return null;
  const [{ data: version }, { data: signers }] = await Promise.all([
    sb.from('crm_contract_template_versions').select('*').eq('id', requestRow.template_version_id).maybeSingle(),
    sb.from('crm_contract_signers').select('*').eq('request_id', requestRow.id).order('routing_order', { ascending: true })
  ]);
  if (!version || !version.storage_object_path || !version.storage_bucket) return null;
  const mergeFields = Array.isArray(version.merge_fields) ? version.merge_fields : [];
  if (!mergeFields.length) return null;
  const [{ data: partner }, { data: signedClient }, { data: lead }] = await Promise.all([
    sb.from('crm_partner_profiles').select('*').eq('id', requestRow.partner_profile_id).maybeSingle(),
    requestRow.signed_client_id ? sb.from('crm_signed_clients').select('*').eq('id', requestRow.signed_client_id).maybeSingle() : Promise.resolve({ data: null }),
    requestRow.lead_id ? sb.from('crm_leads').select('*').eq('id', requestRow.lead_id).maybeSingle() : Promise.resolve({ data: null })
  ]);
  const resolved = resolveFieldValues({
    merge_fields: mergeFields,
    request: requestRow,
    partner: partner || null,
    signedClient: signedClient || null,
    lead: lead || null
  });
  try {
    const templatePdfBytes = await downloadTemplatePdf(sb, version);
    const finalBuffer = await renderFinalPdf({
      templatePdfBytes,
      mergeFields,
      signers: signers || [],
      resolvedFields: resolved,
      requestPrefill: requestRow.prefill_values || {}
    });
    const path = `requests/${requestRow.id}/signed/rendered-${requestRow.id}.pdf`;
    const { error: uploadErr } = await sb.storage.from('partner-contracts').upload(path, finalBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw uploadErr;
    const nowIso = new Date().toISOString();
    await sb.from('crm_contract_requests').update({
      rendered_pdf_path: path,
      rendered_pdf_storage_bucket: 'partner-contracts',
      rendered_pdf_generated_at: nowIso
    }).eq('id', requestRow.id);
    await sb.from('crm_contract_files').insert({
      owner_admin_id: requestRow.owner_admin_id,
      request_id: requestRow.id,
      template_id: requestRow.template_id,
      file_kind: 'rendered_pdf',
      storage_bucket: 'partner-contracts',
      storage_object_path: path,
      file_name: `rendered-${requestRow.id}.pdf`,
      file_mime_type: 'application/pdf',
      file_size_bytes: finalBuffer.length
    });
    await insertContractEvent(sb, {
      owner_admin_id: requestRow.owner_admin_id,
      request_id: requestRow.id,
      template_id: requestRow.template_id,
      event_type: 'rendered_pdf_generated',
      actor_type: 'system',
      event_data: { path, size_bytes: finalBuffer.length }
    });
    return { rendered_pdf_path: path };
  } catch (err) {
    console.error('[partner-contracts-public] rendered PDF failed:', err);
    await insertContractEvent(sb, {
      owner_admin_id: requestRow.owner_admin_id,
      request_id: requestRow.id,
      template_id: requestRow.template_id,
      event_type: 'rendered_pdf_generated',
      actor_type: 'system',
      event_data: { error: err.message || String(err) }
    });
    return null;
  }
}

async function generateCompletedPdfs(sb, requestRow) {
  const [{ data: signers }, { data: events }, { data: partner }, { data: template }] = await Promise.all([
    sb.from('crm_contract_signers').select('*').eq('request_id', requestRow.id).order('routing_order', { ascending: true }),
    sb.from('crm_contract_events').select('*').eq('request_id', requestRow.id).order('created_at', { ascending: false }).limit(200),
    sb.from('crm_partner_profiles').select('*').eq('id', requestRow.partner_profile_id).maybeSingle(),
    sb.from('crm_contract_templates').select('*').eq('id', requestRow.template_id).maybeSingle()
  ]);
  const signedBuffer = buildSignedPdf({ request: requestRow, signers: signers || [], events: events || [], partner, template });
  const auditBuffer = buildAuditPdf({ request: requestRow, signers: signers || [], events: events || [], partner });
  const signedPath = requestPdfObjectPath(requestRow.id, 'signed', `signed-${requestRow.id}.pdf`);
  const auditPath = requestPdfObjectPath(requestRow.id, 'audit', `audit-${requestRow.id}.pdf`);
  await uploadBuffer(sb, { path: signedPath, buffer: signedBuffer, contentType: 'application/pdf' });
  await uploadBuffer(sb, { path: auditPath, buffer: auditBuffer, contentType: 'application/pdf' });
  const nowIso = new Date().toISOString();
  await sb.from('crm_contract_requests').update({
    signed_pdf_path: signedPath,
    audit_pdf_path: auditPath,
    signed_pdf_storage_bucket: PARTNER_CONTRACTS_BUCKET,
    audit_pdf_storage_bucket: PARTNER_CONTRACTS_BUCKET,
    signed_pdf_generated_at: nowIso,
    audit_pdf_generated_at: nowIso
  }).eq('id', requestRow.id);
  await insertContractEvent(sb, {
    owner_admin_id: requestRow.owner_admin_id,
    request_id: requestRow.id,
    template_id: requestRow.template_id,
    event_type: 'signed_pdf_generated',
    actor_type: 'system',
    event_data: { signed_path: signedPath, audit_path: auditPath }
  });
  return { signed_pdf_path: signedPath, audit_pdf_path: auditPath };
}

async function recalcRequestStatus(sb, requestId) {
  const { error } = await sb.rpc('crm_contracts_recalc_request_status', { target_request_id: requestId });
  if (error) throw error;
}

async function loadSignerBundleByToken(sb, token) {
  const { data: signer, error } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('signing_token', token)
    .maybeSingle();
  if (error) throw error;
  if (!signer) throw Object.assign(new Error('Signing token not found.'), { statusCode: 404 });

  const { data: requestRow, error: reqErr } = await sb
    .from('crm_contract_requests')
    .select('*')
    .eq('id', signer.request_id)
    .maybeSingle();
  if (reqErr) throw reqErr;
  if (!requestRow) throw Object.assign(new Error('Contract request not found.'), { statusCode: 404 });

  const { data: template, error: tplErr } = await sb
    .from('crm_contract_templates')
    .select('id, template_name, partner_profile_id')
    .eq('id', requestRow.template_id)
    .maybeSingle();
  if (tplErr) throw tplErr;

  const { data: partner, error: partnerErr } = await sb
    .from('crm_partner_profiles')
    .select('id, display_name, business_name')
    .eq('id', requestRow.partner_profile_id)
    .maybeSingle();
  if (partnerErr) throw partnerErr;

  const { data: signers, error: signersErr } = await sb
    .from('crm_contract_signers')
    .select('id, signer_role, signer_name, signer_email, routing_order, status, sent_at, viewed_at, signed_at, declined_at, signature_placements')
    .eq('request_id', requestRow.id)
    .order('routing_order', { ascending: true });
  if (signersErr) throw signersErr;

  const { data: version } = requestRow.template_version_id
    ? await sb.from('crm_contract_template_versions').select('*').eq('id', requestRow.template_version_id).maybeSingle()
    : { data: null };

  return { signer, request: requestRow, template: template || null, version: version || null, partner: partner || null, signers: signers || [] };
}

function canActOnSigner(bundle) {
  if (['signed', 'declined', 'voided', 'expired', 'cancelled'].includes(bundle.request.status)) {
    return false;
  }
  if (bundle.request.expires_at && new Date(bundle.request.expires_at).getTime() < Date.now()) {
    return false;
  }
  return true;
}

function signerActionable(bundle) {
  return ['sent', 'viewed'].includes(bundle.signer.status);
}

async function promoteNextSignerGroup(sb, bundle) {
  const actionable = bundle.signers.filter((row) => ['sent', 'viewed'].includes(row.status));
  if (actionable.length) return [];
  const queued = bundle.signers.filter((row) => row.status === 'queued');
  if (!queued.length) return [];
  const nextOrder = Math.min(...queued.map((row) => Number(row.routing_order || 0)).filter(Boolean));
  const nextRows = queued.filter((row) => Number(row.routing_order || 0) === nextOrder);
  if (!nextRows.length) return [];
  const now = new Date().toISOString();
  const ids = nextRows.map((row) => row.id);
  const { error } = await sb.from('crm_contract_signers').update({ status: 'sent', sent_at: now, last_email_at: now }).in('id', ids);
  if (error) throw error;
  for (const row of nextRows) {
    await insertContractEvent(sb, {
      owner_admin_id: bundle.request.owner_admin_id,
      request_id: bundle.request.id,
      signer_id: row.id,
      template_id: bundle.request.template_id,
      event_type: 'email_queued',
      actor_type: 'system',
      event_data: { signer_email: row.signer_email, signer_name: row.signer_name, routing_order: row.routing_order }
    });
  }
  return nextRows;
}

async function handleGet(sb, event) {
  const token = cleanText(event.queryStringParameters?.token || '');
  if (!token) return response(400, { error: 'token is required.' }, corsHeaders());
  const bundle = await loadSignerBundleByToken(sb, token);

  if (bundle.request.expires_at && new Date(bundle.request.expires_at).getTime() < Date.now() && bundle.request.status !== 'expired') {
    await sb.from('crm_contract_requests').update({ status: 'expired' }).eq('id', bundle.request.id);
    await recalcRequestStatus(sb, bundle.request.id);
  }

  // Build resolved fields so the signer page can render auto-filled values
  const mergeFields = Array.isArray(bundle.version?.merge_fields) ? bundle.version.merge_fields : [];
  const resolved = mergeFields.length
    ? resolveFieldValues({
        merge_fields: mergeFields,
        request: bundle.request,
        partner: bundle.partner,
        signedClient: null,
        lead: null
      })
    : [];

  // Prefer the final rendered PDF when available (after signing). Falls back to the template PDF.
  let templatePdfUrl = '';
  if (bundle.request.rendered_pdf_path && bundle.request.rendered_pdf_storage_bucket) {
    try {
      const { data: signedUrl } = await sb.storage.from(bundle.request.rendered_pdf_storage_bucket).createSignedUrl(bundle.request.rendered_pdf_path, 3600);
      templatePdfUrl = signedUrl?.signedUrl || '';
    } catch { /* ignore */ }
  }
  if (!templatePdfUrl && bundle.version?.storage_object_path && bundle.version?.storage_bucket) {
    try {
      const { data: signedUrl } = await sb.storage.from(bundle.version.storage_bucket).createSignedUrl(bundle.version.storage_object_path, 3600);
      templatePdfUrl = signedUrl?.signedUrl || '';
    } catch { /* ignore */ }
  }

  return response(200, {
    signer: {
      id: bundle.signer.id,
      signer_role: bundle.signer.signer_role,
      signer_name: bundle.signer.signer_name,
      signer_email: bundle.signer.signer_email,
      routing_order: bundle.signer.routing_order,
      status: bundle.signer.status,
      signature_placements: bundle.signer.signature_placements || []
    },
    request: {
      id: bundle.request.id,
      request_title: bundle.request.request_title,
      email_subject: bundle.request.email_subject,
      email_message: bundle.request.email_message,
      client_name: bundle.request.client_name,
      client_email: bundle.request.client_email,
      status: bundle.request.status,
      expires_at: bundle.request.expires_at,
      public_signing_slug: bundle.request.public_signing_slug,
      prefill_values: bundle.request.prefill_values || {}
    },
    template: bundle.template,
    template_version: bundle.version ? {
      id: bundle.version.id,
      version_label: bundle.version.version_label,
      merge_fields: mergeFields,
      pdf_url: templatePdfUrl
    } : null,
    fields: resolved,
    partner: bundle.partner,
    signers: bundle.signers
  }, corsHeaders());
}

async function handleView(sb, bundle) {
  if (!canActOnSigner(bundle)) throw Object.assign(new Error('This request can no longer be viewed.'), { statusCode: 409 });
  if (!['sent', 'viewed'].includes(bundle.signer.status)) {
    throw Object.assign(new Error('This signer is not yet active in the routing order.'), { statusCode: 409 });
  }
  if (bundle.signer.status !== 'viewed') {
    const now = new Date().toISOString();
    const { error } = await sb.from('crm_contract_signers').update({ status: 'viewed', viewed_at: now }).eq('id', bundle.signer.id);
    if (error) throw error;
    await insertContractEvent(sb, {
      owner_admin_id: bundle.request.owner_admin_id,
      request_id: bundle.request.id,
      signer_id: bundle.signer.id,
      template_id: bundle.request.template_id,
      event_type: 'signer_viewed',
      actor_type: 'signer',
      event_data: { signer_email: bundle.signer.signer_email, signer_name: bundle.signer.signer_name }
    });
    await recalcRequestStatus(sb, bundle.request.id);
  }
  return handleGet(sb, { queryStringParameters: { token: bundle.signer.signing_token } });
}

async function handleSign(sb, bundle, body, event) {
  // body.field_values = { fieldId: value } from inline text/date inputs on the signing page
  if (body && body.field_values && typeof body.field_values === 'object') {
    const merged = { ...(bundle.request.prefill_values || {}), ...body.field_values };
    await sb.from('crm_contract_requests').update({ prefill_values: merged }).eq('id', bundle.request.id);
    bundle.request.prefill_values = merged;
  }
  // body.signature_image_data = base64 PNG of the drawn signature
  if (body && body.signature_image_data) {
    await sb.from('crm_contract_signers').update({ signature_image_data: body.signature_image_data }).eq('id', bundle.signer.id);
  }
  // v3.5.1: body.initials_image_data = optional base64 PNG of separately-drawn initials.
  // Stored inside signature_payload.initials_image_data so we don't need a new DB column.
  if (body && body.initials_image_data) {
    const existingPayload = bundle.signer.signature_payload && typeof bundle.signer.signature_payload === 'object'
      ? bundle.signer.signature_payload
      : {};
    const mergedPayload = Object.assign({}, existingPayload, body.signature_payload || {}, {
      initials_image_data: body.initials_image_data
    });
    body.signature_payload = mergedPayload;
  }

  if (!canActOnSigner(bundle)) throw Object.assign(new Error('This request can no longer be signed.'), { statusCode: 409 });
  if (!signerActionable(bundle)) throw Object.assign(new Error('This signer is not yet active in the routing order.'), { statusCode: 409 });
  const now = new Date().toISOString();
  const patch = {
    status: 'signed',
    signed_at: now,
    viewed_at: bundle.signer.viewed_at || now,
    signature_payload: body.signature_payload || {}
  };
  const { error } = await sb.from('crm_contract_signers').update(patch).eq('id', bundle.signer.id);
  if (error) throw error;
  await insertContractEvent(sb, {
    owner_admin_id: bundle.request.owner_admin_id,
    request_id: bundle.request.id,
    signer_id: bundle.signer.id,
    template_id: bundle.request.template_id,
    event_type: 'signer_signed',
    actor_type: 'signer',
    event_data: { signer_email: bundle.signer.signer_email, signer_name: bundle.signer.signer_name }
  });
  await recalcRequestStatus(sb, bundle.request.id);
  const refreshed = await loadSignerBundleByToken(sb, bundle.signer.signing_token);
  const promotedSigners = await promoteNextSignerGroup(sb, refreshed);
  await recalcRequestStatus(sb, bundle.request.id);

  // ✅ v3.5.0 FIX: Actually email the next signer(s) after promoting them.
  // Previously the system only marked them as 'sent' in the DB — no email was ever delivered.
  if (promotedSigners && promotedSigners.length) {
    try {
      const postPromoteBundle = await loadSignerBundleByToken(sb, bundle.signer.signing_token);
      await deliverEmailsToActiveSigners(sb, postPromoteBundle.request, postPromoteBundle.signers, event);
    } catch (emailErr) {
      console.error('[partner-contracts-public] failed to email next signer:', emailErr);
    }
  }

  const done = await loadSignerBundleByToken(sb, bundle.signer.signing_token);
  if (done.request.status === 'signed') {
    await insertContractEvent(sb, {
      owner_admin_id: done.request.owner_admin_id,
      request_id: done.request.id,
      template_id: done.request.template_id,
      event_type: 'request_completed',
      actor_type: 'system',
      event_data: { completed_via: 'public_signing_endpoint' }
    });
    try {
      await generateCompletedPdfs(sb, done.request);
    } catch (pdfError) {
      console.error('[partner-contracts-public] PDF generation failed:', pdfError);
    }
    try {
      await generateRenderedPdf(sb, done.request);
    } catch (renderError) {
      console.error('[partner-contracts-public] rendered PDF failed:', renderError);
    }
    // ✅ v3.5.0: Email everyone the completed PDF
    try {
      const finalBundle = await loadSignerBundleByToken(sb, bundle.signer.signing_token);
      await deliverCompletionEmails(sb, finalBundle.request, finalBundle.signers, event);
    } catch (completeErr) {
      console.error('[partner-contracts-public] completion email failed:', completeErr);
    }
  }
  return handleGet(sb, { queryStringParameters: { token: bundle.signer.signing_token } });
}

async function handleDecline(sb, bundle, body) {
  if (!canActOnSigner(bundle)) throw Object.assign(new Error('This request can no longer be declined.'), { statusCode: 409 });
  if (!signerActionable(bundle)) throw Object.assign(new Error('This signer is not yet active in the routing order.'), { statusCode: 409 });
  const now = new Date().toISOString();
  const { error } = await sb
    .from('crm_contract_signers')
    .update({ status: 'declined', declined_at: now, decision_note: cleanText(body.decision_note || '') })
    .eq('id', bundle.signer.id);
  if (error) throw error;
  await insertContractEvent(sb, {
    owner_admin_id: bundle.request.owner_admin_id,
    request_id: bundle.request.id,
    signer_id: bundle.signer.id,
    template_id: bundle.request.template_id,
    event_type: 'signer_declined',
    actor_type: 'signer',
    event_data: { signer_email: bundle.signer.signer_email, signer_name: bundle.signer.signer_name, decision_note: cleanText(body.decision_note || '') }
  });
  await recalcRequestStatus(sb, bundle.request.id);
  return handleGet(sb, { queryStringParameters: { token: bundle.signer.signing_token } });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, '', corsHeaders());
  try {
    const sb = getRequiredSupabase();
    if (event.httpMethod === 'GET') return await handleGet(sb, event);
    if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' }, corsHeaders());

    const body = await readJsonBody(event);
    const token = cleanText(body.token || '');
    const action = cleanText(body.action || '');
    if (!token) return response(400, { error: 'token is required.' }, corsHeaders());
    const bundle = await loadSignerBundleByToken(sb, token);

    if (action === 'view') return await handleView(sb, bundle);
    if (action === 'sign') return await handleSign(sb, bundle, body, event);
    if (action === 'decline') return await handleDecline(sb, bundle, body);
    return response(400, { error: `Unsupported action: ${action}` }, corsHeaders());
  } catch (error) {
    console.error('[partner-contracts-public] error:', error);
    return response(error.statusCode || 500, { error: error.message || 'Unexpected public Partner Contracts error.' }, corsHeaders());
  }
};
