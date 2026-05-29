/* build:1780028952622 */
const {
  response,
  corsHeaders,
  readJsonBody,
  cleanEmail,
  cleanText,
  requireAdminSession,
  getRequiredSupabase,
  randomToken,
  uniqueSlug,
  asArray,
  requireField,
  assertPartnerScope,
  loadOwnedRequest,
  loadOwnedTemplate,
  insertContractEvent
} = require('./_partner-contracts-utils');

const {
  isEmailConfigured,
  resolveBaseUrl,
  buildSigningUrl,
  buildSignerEmail,
  sendPostmarkEmail
} = require('./_partner-contracts-email');

const {
  PARTNER_CONTRACTS_BUCKET,
  templateObjectPath,
  requestPdfObjectPath,
  dataUrlToBuffer,
  uploadBuffer,
  createSignedUrl
} = require('./_partner-contracts-storage');

const { buildSignedPdf, buildAuditPdf } = require('./_partner-contracts-pdf');
const { buildSourceValues, resolveFieldValues, getSourceCatalog } = require('./_partner-contracts-merge');
const { renderFinalPdf, downloadTemplatePdf } = require('./_partner-contracts-render');

async function updateTemplateAction(sb, session, body) {
  const templateId = requireField(cleanText(body.template_id), 'template_id');
  const template = await loadOwnedTemplate(sb, session, templateId);
  const patch = {};
  ['template_name', 'description', 'category'].forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      patch[field] = cleanText(body[field]);
    }
  });
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
    patch.is_active = Boolean(body.is_active);
  }
  if (!Object.keys(patch).length) {
    throw Object.assign(new Error('No editable fields were provided.'), { statusCode: 400 });
  }
  const { data, error } = await sb.from('crm_contract_templates').update(patch).eq('id', template.id).select('*').single();
  if (error) throw error;
  await insertContractEvent(sb, {
    owner_admin_id: template.owner_admin_id,
    template_id: template.id,
    event_type: 'template_updated',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { updated_fields: Object.keys(patch) }
  });
  return response(200, { template: data }, corsHeaders());
}

// Cancel a signature request (soft): keeps audit trail, invalidates signing tokens
// Update partner profile contact info (email + phone) so DocuMike can email them their copy
async function updatePartnerContactAction(sb, session, body) {
  const partnerProfileId = requireField(cleanText(body.partner_profile_id), 'partner_profile_id');
  const contactEmail = cleanText(body.contact_email || '');
  const contactPhone = cleanText(body.contact_phone || '');
  // Scope check: ensure caller can edit this partner
  const partner = await assertPartnerScope(sb, session, partnerProfileId);
  const patch = {};
  if (body.contact_email !== undefined) patch.contact_email = contactEmail || null;
  if (body.contact_phone !== undefined) patch.contact_phone = contactPhone || null;
  if (!Object.keys(patch).length) {
    return response(200, { ok: true, partner }, corsHeaders());
  }
  const { data, error } = await sb
    .from('crm_partner_profiles')
    .update(patch)
    .eq('id', partner.id)
    .select('*')
    .single();
  if (error) {
    // If column doesn't exist (V4 migration not run yet), gracefully report
    if (/column .* does not exist/i.test(String(error.message || ''))) {
      throw Object.assign(new Error('Run DocuMike Settings → Run Setup Now to add the contact_email column to partner profiles.'), { statusCode: 400 });
    }
    throw error;
  }
  return response(200, { ok: true, partner: data }, corsHeaders());
}

async function cancelRequestAction(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (['signed', 'cancelled', 'voided', 'expired'].includes(String(request.status || ''))) {
    throw Object.assign(new Error('Request is already ' + request.status + '; cannot cancel.'), { statusCode: 400 });
  }
  const reason = cleanText(body.reason) || 'Cancelled by admin';
  // Mark request cancelled
  const { error: updateErr } = await sb.from('crm_contract_requests')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq('id', request.id);
  if (updateErr) {
    // Fallback if cancelled_at / cancel_reason columns don't exist on older schemas
    const { error: fallbackErr } = await sb.from('crm_contract_requests').update({ status: 'cancelled' }).eq('id', request.id);
    if (fallbackErr) throw fallbackErr;
  }
  // Invalidate signing tokens so the public signing page returns "cancelled"
  await sb.from('crm_contract_signers')
    .update({ status: 'cancelled' })
    .eq('request_id', request.id)
    .in('status', ['draft', 'queued', 'sent', 'viewed']);
  // Log event
  try {
    await sb.from('crm_contract_events').insert({
      request_id: request.id,
      event_type: 'request_cancelled',
      event_data: { reason, cancelled_by: session.user.id }
    });
  } catch (e) { /* events table may not exist on older schemas */ }
  return response(200, { ok: true, cancelled_request_id: request.id, reason }, corsHeaders());
}

// Hard delete a signature request: removes signers, events, and the request row itself
async function deleteRequestAction(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  // Delete dependent rows first (in case ON DELETE CASCADE isn't set)
  try { await sb.from('crm_contract_signers').delete().eq('request_id', request.id); } catch (e) {}
  try { await sb.from('crm_contract_events').delete().eq('request_id', request.id); } catch (e) {}
  try { await sb.from('crm_contract_files').delete().eq('request_id', request.id); } catch (e) {}
  // Best-effort: delete rendered/signed PDFs from storage
  const pathsToDelete = [request.rendered_pdf_path, request.signed_pdf_path, request.audit_pdf_path].filter(Boolean);
  if (pathsToDelete.length) {
    try { await sb.storage.from('partner-contracts').remove(pathsToDelete); } catch (e) {}
  }
  const { error } = await sb.from('crm_contract_requests').delete().eq('id', request.id);
  if (error) throw error;
  return response(200, { ok: true, deleted_request_id: request.id }, corsHeaders());
}

async function deleteTemplateAction(sb, session, body) {
  const templateId = requireField(cleanText(body.template_id), 'template_id');
  const template = await loadOwnedTemplate(sb, session, templateId);
  // Block deletion if any request was created from this template (preserves audit trail)
  const { count } = await sb.from('crm_contract_requests').select('id', { count: 'exact', head: true }).eq('template_id', template.id);
  if (Number(count || 0) > 0) {
    throw Object.assign(new Error('Cannot delete: this template has ' + count + ' signature request(s) attached. Archive it instead by setting is_active = false.'), { statusCode: 400 });
  }
  const { error } = await sb.from('crm_contract_templates').delete().eq('id', template.id);
  if (error) throw error;
  return response(200, { ok: true, deleted_template_id: template.id }, corsHeaders());
}

async function archiveTemplateVersionAction(sb, session, body) {
  const versionId = requireField(cleanText(body.template_version_id), 'template_version_id');
  const { data: version, error } = await sb
    .from('crm_contract_template_versions')
    .select('*')
    .eq('id', versionId)
    .maybeSingle();
  if (error) throw error;
  if (!version) throw Object.assign(new Error('Template version not found.'), { statusCode: 404 });
  await loadOwnedTemplate(sb, session, version.template_id);
  const nextStatus = body.status === 'archived' ? 'archived' : (body.status === 'ready' ? 'ready' : 'draft');
  const { error: updateErr } = await sb.from('crm_contract_template_versions').update({ status: nextStatus }).eq('id', version.id);
  if (updateErr) throw updateErr;
  return response(200, { ok: true, template_version_id: version.id, status: nextStatus }, corsHeaders());
}

async function regenerateRenderedPdfAction(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (!request.template_version_id) throw Object.assign(new Error('Request has no template version.'), { statusCode: 400 });
  const [{ data: version }, { data: signers }] = await Promise.all([
    sb.from('crm_contract_template_versions').select('*').eq('id', request.template_version_id).maybeSingle(),
    sb.from('crm_contract_signers').select('*').eq('request_id', request.id).order('routing_order', { ascending: true })
  ]);
  if (!version || !version.storage_object_path) throw Object.assign(new Error('Template version has no source PDF in storage.'), { statusCode: 400 });
  const mergeFields = Array.isArray(version.merge_fields) ? version.merge_fields : [];
  if (!mergeFields.length) throw Object.assign(new Error('Template version has no mapped fields. Open the field editor first.'), { statusCode: 400 });
  const [{ data: partner }, { data: signedClient }, { data: lead }] = await Promise.all([
    sb.from('crm_partner_profiles').select('*').eq('id', request.partner_profile_id).maybeSingle(),
    request.signed_client_id ? sb.from('crm_signed_clients').select('*').eq('id', request.signed_client_id).maybeSingle() : Promise.resolve({ data: null }),
    request.lead_id ? sb.from('crm_leads').select('*').eq('id', request.lead_id).maybeSingle() : Promise.resolve({ data: null })
  ]);
  const resolved = resolveFieldValues({
    merge_fields: mergeFields,
    request,
    partner: partner || null,
    signedClient: signedClient || null,
    lead: lead || null
  });
  const templatePdfBytes = await downloadTemplatePdf(sb, version);
  const finalBuffer = await renderFinalPdf({
    templatePdfBytes,
    mergeFields,
    signers: signers || [],
    resolvedFields: resolved,
    requestPrefill: request.prefill_values || {}
  });
  const path = `requests/${request.id}/signed/rendered-${request.id}.pdf`;
  const { error: uploadErr } = await sb.storage.from('partner-contracts').upload(path, finalBuffer, { contentType: 'application/pdf', upsert: true });
  if (uploadErr) throw uploadErr;
  const nowIso = new Date().toISOString();
  await sb.from('crm_contract_requests').update({
    rendered_pdf_path: path,
    rendered_pdf_storage_bucket: 'partner-contracts',
    rendered_pdf_generated_at: nowIso
  }).eq('id', request.id);
  await sb.from('crm_contract_files').insert({
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    template_id: request.template_id,
    file_kind: 'rendered_pdf',
    storage_bucket: 'partner-contracts',
    storage_object_path: path,
    file_name: `rendered-${request.id}.pdf`,
    file_mime_type: 'application/pdf',
    file_size_bytes: finalBuffer.length,
    created_by: session?.requester?.id || null
  });
  await insertContractEvent(sb, {
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    template_id: request.template_id,
    event_type: 'rendered_pdf_generated',
    actor_user_id: session?.requester?.id || null,
    actor_type: 'user',
    event_data: { path, size_bytes: finalBuffer.length, signer_count: (signers || []).length }
  });
  const bundle = await getRequestBundle(sb, session, request.id);
  return response(200, { ...bundle, rendered_pdf_path: path }, corsHeaders());
}

async function generateSignedPdf(sb, session, requestRow) {
  const { data: signers } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('request_id', requestRow.id)
    .order('routing_order', { ascending: true });
  const { data: events } = await sb
    .from('crm_contract_events')
    .select('*')
    .eq('request_id', requestRow.id)
    .order('created_at', { ascending: false })
    .limit(200);
  const [{ data: partner }, { data: template }] = await Promise.all([
    sb.from('crm_partner_profiles').select('*').eq('id', requestRow.partner_profile_id).maybeSingle(),
    sb.from('crm_contract_templates').select('*').eq('id', requestRow.template_id).maybeSingle()
  ]);

  const signedBuffer = buildSignedPdf({
    request: requestRow,
    signers: signers || [],
    events: events || [],
    partner,
    template
  });
  const auditBuffer = buildAuditPdf({
    request: requestRow,
    signers: signers || [],
    events: events || [],
    partner
  });

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

  await sb.from('crm_contract_files').insert([
    {
      owner_admin_id: requestRow.owner_admin_id,
      request_id: requestRow.id,
      template_id: requestRow.template_id,
      file_kind: 'signed_pdf',
      storage_bucket: PARTNER_CONTRACTS_BUCKET,
      storage_object_path: signedPath,
      file_name: `signed-${requestRow.id}.pdf`,
      file_mime_type: 'application/pdf',
      file_size_bytes: signedBuffer.length,
      created_by: session?.requester?.id || null
    },
    {
      owner_admin_id: requestRow.owner_admin_id,
      request_id: requestRow.id,
      template_id: requestRow.template_id,
      file_kind: 'audit_pdf',
      storage_bucket: PARTNER_CONTRACTS_BUCKET,
      storage_object_path: auditPath,
      file_name: `audit-${requestRow.id}.pdf`,
      file_mime_type: 'application/pdf',
      file_size_bytes: auditBuffer.length,
      created_by: session?.requester?.id || null
    }
  ]);

  await insertContractEvent(sb, {
    owner_admin_id: requestRow.owner_admin_id,
    request_id: requestRow.id,
    template_id: requestRow.template_id,
    event_type: 'signed_pdf_generated',
    actor_user_id: session?.requester?.id || null,
    actor_type: session ? 'user' : 'system',
    event_data: { signed_path: signedPath, audit_path: auditPath, signer_count: (signers || []).length }
  });
  return { signed_pdf_path: signedPath, audit_pdf_path: auditPath };
}

async function uploadTemplateFile(sb, session, body) {
  const templateId = requireField(cleanText(body.template_id), 'template_id');
  const versionId = cleanText(body.template_version_id || '');
  const filename = requireField(cleanText(body.filename), 'filename');
  const dataUrl = requireField(cleanText(body.data_url), 'data_url');
  const template = await loadOwnedTemplate(sb, session, templateId);
  const { mime, buffer } = dataUrlToBuffer(dataUrl);
  const path = templateObjectPath(template.partner_profile_id, template.id, versionId || 'pending', filename);
  await uploadBuffer(sb, { path, buffer, contentType: mime || 'application/pdf' });
  if (versionId) {
    await sb.from('crm_contract_template_versions').update({
      storage_bucket: PARTNER_CONTRACTS_BUCKET,
      storage_object_path: path,
      source_file_name: filename,
      source_file_mime_type: mime,
      file_size_bytes: buffer.length
    }).eq('id', versionId);
  }
  await sb.from('crm_contract_files').insert({
    owner_admin_id: template.owner_admin_id,
    template_id: template.id,
    template_version_id: versionId || null,
    file_kind: 'template_source',
    storage_bucket: PARTNER_CONTRACTS_BUCKET,
    storage_object_path: path,
    file_name: filename,
    file_mime_type: mime,
    file_size_bytes: buffer.length,
    created_by: session?.requester?.id || null
  });
  await insertContractEvent(sb, {
    owner_admin_id: template.owner_admin_id,
    template_id: template.id,
    event_type: 'file_attached',
    actor_user_id: session?.requester?.id || null,
    actor_type: 'user',
    event_data: { storage_object_path: path, filename, file_size_bytes: buffer.length, mime }
  });
  return response(200, { storage_object_path: path, storage_bucket: PARTNER_CONTRACTS_BUCKET, file_size_bytes: buffer.length, mime }, corsHeaders());
}

async function signObjectUrl(sb, session, body) {
  const bucket = cleanText(body.bucket || PARTNER_CONTRACTS_BUCKET);
  const path = requireField(cleanText(body.path), 'path');
  const expires = Math.min(Math.max(Number(body.expires_in_seconds || 600), 60), 3600);
  // Ensure the caller has access by checking that the file belongs to a record they own.
  const { data: fileRow, error } = await sb
    .from('crm_contract_files')
    .select('owner_admin_id')
    .eq('storage_object_path', path)
    .eq('storage_bucket', bucket)
    .maybeSingle();
  if (error) throw error;
  if (!fileRow) throw Object.assign(new Error('File not found.'), { statusCode: 404 });
  if (session.roleRow.role !== 'super_admin' && fileRow.owner_admin_id !== session.requester.id) {
    throw Object.assign(new Error('That file is outside your access scope.'), { statusCode: 403 });
  }
  const url = await createSignedUrl(sb, { bucket, path, expiresInSeconds: expires });
  return response(200, { url, expires_in_seconds: expires }, corsHeaders());
}

async function getTemplateVersionPdfUrlAction(sb, session, body) {
  const templateVersionId = requireField(cleanText(body.template_version_id), 'template_version_id');
  const { data: version, error } = await sb
    .from('crm_contract_template_versions')
    .select('*')
    .eq('id', templateVersionId)
    .maybeSingle();
  if (error) throw error;
  if (!version) throw Object.assign(new Error('Template version not found.'), { statusCode: 404 });
  await loadOwnedTemplate(sb, session, version.template_id);
  if (!version.storage_object_path || !version.storage_bucket) {
    return response(200, { url: '', merge_fields: version.merge_fields || [], template_version_id: version.id, has_pdf: false }, corsHeaders());
  }
  const { data: signed, error: signErr } = await sb.storage.from(version.storage_bucket).createSignedUrl(version.storage_object_path, 3600);
  if (signErr) throw signErr;
  return response(200, {
    url: signed?.signedUrl || '',
    template_version_id: version.id,
    merge_fields: version.merge_fields || [],
    has_pdf: true,
    source_file_name: version.source_file_name || ''
  }, corsHeaders());
}

async function resolveFieldsAction(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  const [{ data: version }, { data: partner }, signedClient, lead] = await Promise.all([
    sb.from('crm_contract_template_versions').select('*').eq('id', request.template_version_id).maybeSingle(),
    sb.from('crm_partner_profiles').select('*').eq('id', request.partner_profile_id).maybeSingle(),
    request.signed_client_id ? sb.from('crm_signed_clients').select('*').eq('id', request.signed_client_id).maybeSingle().then((r) => r.data) : Promise.resolve(null),
    request.lead_id ? sb.from('crm_leads').select('*').eq('id', request.lead_id).maybeSingle().then((r) => r.data) : Promise.resolve(null)
  ]);
  const merge_fields = Array.isArray(version?.merge_fields) ? version.merge_fields : [];
  const resolved = resolveFieldValues({
    merge_fields,
    request,
    partner: partner || null,
    signedClient: signedClient || null,
    lead: lead || null
  });
  return response(200, {
    request_id: request.id,
    template_version_id: request.template_version_id,
    fields: resolved,
    sources: buildSourceValues({ request, partner: partner || null, signedClient: signedClient || null, lead: lead || null })
  }, corsHeaders());
}

async function saveTemplateFieldsAction(sb, session, body) {
  const templateVersionId = requireField(cleanText(body.template_version_id), 'template_version_id');
  const merge_fields = Array.isArray(body.merge_fields) ? body.merge_fields : [];
  const { data: version, error } = await sb
    .from('crm_contract_template_versions')
    .select('*')
    .eq('id', templateVersionId)
    .maybeSingle();
  if (error) throw error;
  if (!version) throw Object.assign(new Error('Template version not found.'), { statusCode: 404 });
  await loadOwnedTemplate(sb, session, version.template_id);
  const { error: updateErr } = await sb
    .from('crm_contract_template_versions')
    .update({ merge_fields })
    .eq('id', templateVersionId);
  if (updateErr) throw updateErr;
  await insertContractEvent(sb, {
    owner_admin_id: version.owner_admin_id,
    template_id: version.template_id,
    event_type: 'template_fields_mapped',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { template_version_id: templateVersionId, field_count: merge_fields.length }
  });
  return response(200, { ok: true, template_version_id: templateVersionId, merge_fields }, corsHeaders());
}

async function generateRequestPdf(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (request.status !== 'signed') {
    throw Object.assign(new Error('Signed PDF export is only available once all signers have signed.'), { statusCode: 400 });
  }
  const result = await generateSignedPdf(sb, session, request);
  const bundle = await getRequestBundle(sb, session, request.id);
  return response(200, { ...bundle, pdf: result }, corsHeaders());
}

async function dispatchSignerEmails(sb, session, requestRow, signers, event) {
  if (!(await isEmailConfigured(sb))) return { sent: 0, attempted: 0, skipped: true };
  const baseUrl = await resolveBaseUrl(event, sb);
  const [{ data: partner }, { data: template }] = await Promise.all([
    sb.from('crm_partner_profiles').select('*').eq('id', requestRow.partner_profile_id).maybeSingle(),
    sb.from('crm_contract_templates').select('*').eq('id', requestRow.template_id).maybeSingle()
  ]);
  const targets = (signers || []).filter((row) => ['sent', 'viewed'].includes(row.status));
  let sent = 0;
  for (const signer of targets) {
    const signingUrl = buildSigningUrl(baseUrl, signer.signing_token);
    const built = buildSignerEmail({ request: requestRow, signer, partner, template, signingUrl });
    const result = await sendPostmarkEmail({
      sb,
      to: signer.signer_email,
      cc: Array.isArray(requestRow.cc_emails) ? requestRow.cc_emails.join(',') : '',
      subject: built.subject,
      textBody: built.text,
      htmlBody: built.html
    });
    // Detect Postmark pending-approval rejection and decorate the error with a hint
    if (!result.sent && /pending approval/i.test(String(result.error || ''))) {
      result.pending_approval = true;
      result.hint = 'Postmark account is pending approval and can only send to the same domain as the From address. Use the Email Launchpad to open a mailto draft for this signer, or request Postmark approval.';
    }
    await insertContractEvent(sb, {
      owner_admin_id: requestRow.owner_admin_id,
      request_id: requestRow.id,
      signer_id: signer.id,
      template_id: requestRow.template_id,
      event_type: result.sent ? 'email_sent' : 'email_failed',
      actor_user_id: session?.requester?.id || null,
      actor_type: session ? 'user' : 'system',
      event_data: {
        provider: result.provider || 'postmark',
        signer_email: signer.signer_email,
        signer_name: signer.signer_name,
        routing_order: signer.routing_order,
        message_id: result.message_id || null,
        error: result.error || null,
        signing_url: signingUrl
      }
    });
    if (result.sent) {
      sent += 1;
      await sb.from('crm_contract_signers').update({ last_email_at: new Date().toISOString() }).eq('id', signer.id);
    }
  }
  return { sent, attempted: targets.length, skipped: false };
}

function baseSlug(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'template';
}

async function recalcRequestStatus(sb, requestId) {
  const { error } = await sb.rpc('crm_contracts_recalc_request_status', { target_request_id: requestId });
  if (error) throw error;
}

async function getVisiblePartnerProfiles(sb, session) {
  let query = sb.from('crm_partner_profiles').select('*').order('display_name', { ascending: true });
  if (session.roleRow.role !== 'super_admin') query = query.eq('admin_user_id', session.requester.id);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getVisibleTemplates(sb, session, partnerProfileId = '') {
  let query = sb.from('crm_contract_templates').select('*').order('updated_at', { ascending: false });
  if (session.roleRow.role !== 'super_admin') query = query.eq('owner_admin_id', session.requester.id);
  if (partnerProfileId) query = query.eq('partner_profile_id', partnerProfileId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getVisibleRequests(sb, session, partnerProfileId = '') {
  let query = sb.from('v_contract_request_summary').select('*').order('created_at', { ascending: false }).limit(200);
  if (session.roleRow.role !== 'super_admin') query = query.eq('owner_admin_id', session.requester.id);
  if (partnerProfileId) query = query.eq('partner_profile_id', partnerProfileId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getVisibleEvents(sb, session, requestId = '') {
  let query = sb.from('crm_contract_events').select('*').order('created_at', { ascending: false }).limit(100);
  if (session.roleRow.role !== 'super_admin') query = query.eq('owner_admin_id', session.requester.id);
  if (requestId) query = query.eq('request_id', requestId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getRequestBundle(sb, session, requestId) {
  const request = await loadOwnedRequest(sb, session, requestId);
  const [{ data: signers, error: signersErr }, { data: events, error: eventsErr }] = await Promise.all([
    sb.from('crm_contract_signers').select('*').eq('request_id', requestId).order('routing_order', { ascending: true }),
    sb.from('crm_contract_events').select('*').eq('request_id', requestId).order('created_at', { ascending: false }).limit(200)
  ]);
  if (signersErr) throw signersErr;
  if (eventsErr) throw eventsErr;
  return { request, signers: signers || [], events: events || [] };
}

async function getTemplateBundle(sb, session, templateId) {
  const template = await loadOwnedTemplate(sb, session, templateId);
  const { data: versions, error } = await sb
    .from('crm_contract_template_versions')
    .select('*')
    .eq('template_id', templateId)
    .order('version_number', { ascending: false });
  if (error) throw error;
  return { template, versions: versions || [] };
}

function normalizeSignerInput(signers = []) {
  return asArray(signers)
    .map((signer, index) => ({
      signer_role: ['client', 'co_signer', 'partner', 'custom'].includes(String(signer.signer_role || '').trim()) ? String(signer.signer_role).trim() : 'client',
      signer_name: cleanText(signer.signer_name),
      signer_email: cleanEmail(signer.signer_email),
      signer_phone: cleanText(signer.signer_phone || ''),
      routing_order: Number(signer.routing_order || index + 1) || index + 1
    }))
    .filter((signer) => signer.signer_name && signer.signer_email)
    .sort((a, b) => a.routing_order - b.routing_order);
}

async function promoteNextSignerGroup(sb, requestId, ownerAdminId, actorUserId = null) {
  const { data: signers, error } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('request_id', requestId)
    .order('routing_order', { ascending: true });
  if (error) throw error;
  const rows = signers || [];
  const actionable = rows.filter((row) => ['sent', 'viewed'].includes(row.status));
  if (actionable.length) return { promoted: [] };
  const queued = rows.filter((row) => row.status === 'queued');
  if (!queued.length) return { promoted: [] };
  const nextOrder = Math.min(...queued.map((row) => Number(row.routing_order || 0)).filter(Boolean));
  const targetRows = queued.filter((row) => Number(row.routing_order || 0) === nextOrder);
  if (!targetRows.length) return { promoted: [] };

  const now = new Date().toISOString();
  const ids = targetRows.map((row) => row.id);
  const { error: updateError } = await sb
    .from('crm_contract_signers')
    .update({ status: 'sent', sent_at: now, last_email_at: now })
    .in('id', ids);
  if (updateError) throw updateError;

  for (const signer of targetRows) {
    await insertContractEvent(sb, {
      owner_admin_id: ownerAdminId,
      request_id: requestId,
      signer_id: signer.id,
      event_type: 'email_queued',
      actor_user_id: actorUserId,
      actor_type: actorUserId ? 'user' : 'system',
      event_data: { signer_email: signer.signer_email, signer_name: signer.signer_name, routing_order: signer.routing_order }
    });
  }

  return { promoted: targetRows.map((row) => ({ ...row, status: 'sent', sent_at: now, last_email_at: now })) };
}

async function handleBootstrap(sb, session, event) {
  const partnerProfileId = cleanText(event.queryStringParameters?.partner_profile_id || '');
  if (partnerProfileId) await assertPartnerScope(sb, session, partnerProfileId);
  const [partnerProfiles, templates, requests, recentEvents] = await Promise.all([
    getVisiblePartnerProfiles(sb, session),
    getVisibleTemplates(sb, session, partnerProfileId),
    getVisibleRequests(sb, session, partnerProfileId),
    getVisibleEvents(sb, session, '')
  ]);
  return response(200, { partnerProfiles, templates, requests, recentEvents }, corsHeaders());
}

async function handleGetResource(sb, session, event) {
  const resource = cleanText(event.queryStringParameters?.resource || 'bootstrap') || 'bootstrap';
  const id = cleanText(event.queryStringParameters?.id || '');
  const partnerProfileId = cleanText(event.queryStringParameters?.partner_profile_id || '');

  if (resource === 'bootstrap') return handleBootstrap(sb, session, event);
  if (resource === 'templates') {
    if (partnerProfileId) await assertPartnerScope(sb, session, partnerProfileId);
    return response(200, { templates: await getVisibleTemplates(sb, session, partnerProfileId) }, corsHeaders());
  }
  if (resource === 'requests') {
    if (partnerProfileId) await assertPartnerScope(sb, session, partnerProfileId);
    return response(200, { requests: await getVisibleRequests(sb, session, partnerProfileId) }, corsHeaders());
  }
  if (resource === 'request') {
    requireField(id, 'id');
    return response(200, await getRequestBundle(sb, session, id), corsHeaders());
  }
  if (resource === 'template') {
    requireField(id, 'id');
    return response(200, await getTemplateBundle(sb, session, id), corsHeaders());
  }
  return response(400, { error: `Unsupported resource: ${resource}` }, corsHeaders());
}

async function createTemplate(sb, session, body) {
  const partnerProfileId = requireField(cleanText(body.partner_profile_id), 'partner_profile_id');
  const templateName = requireField(cleanText(body.template_name), 'template_name');
  const partner = await assertPartnerScope(sb, session, partnerProfileId);
  const slugBase = baseSlug(body.template_slug || templateName);
  const templateSlug = `${slugBase}-${Date.now().toString(36).slice(-4)}`;

  const payload = {
    owner_admin_id: partner.admin_user_id,
    partner_profile_id: partner.id,
    template_name: templateName,
    template_slug: templateSlug,
    description: cleanText(body.description || ''),
    category: cleanText(body.category || ''),
    created_by: session.requester.id,
    is_active: body.is_active !== false
  };

  const { data, error } = await sb.from('crm_contract_templates').insert(payload).select('*').single();
  if (error) throw error;

  await insertContractEvent(sb, {
    owner_admin_id: data.owner_admin_id,
    template_id: data.id,
    event_type: 'template_created',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { template_name: data.template_name, partner_profile_id: data.partner_profile_id }
  });

  return response(200, { template: data }, corsHeaders());
}

async function createTemplateVersion(sb, session, body) {
  const templateId = requireField(cleanText(body.template_id), 'template_id');
  const template = await loadOwnedTemplate(sb, session, templateId);
  const { data: latestRows, error: latestError } = await sb
    .from('crm_contract_template_versions')
    .select('version_number')
    .eq('template_id', templateId)
    .order('version_number', { ascending: false })
    .limit(1);
  if (latestError) throw latestError;
  const nextVersion = Number(latestRows?.[0]?.version_number || 0) + 1;

  const payload = {
    owner_admin_id: template.owner_admin_id,
    partner_profile_id: template.partner_profile_id,
    template_id: template.id,
    version_number: nextVersion,
    version_label: cleanText(body.version_label || `v${nextVersion}`),
    status: ['draft', 'ready', 'archived'].includes(String(body.status || '').trim()) ? String(body.status).trim() : 'draft',
    storage_bucket: cleanText(body.storage_bucket || 'partner-contracts'),
    storage_object_path: cleanText(body.storage_object_path || ''),
    source_file_url: cleanText(body.source_file_url || ''),
    source_file_name: cleanText(body.source_file_name || ''),
    source_file_mime_type: cleanText(body.source_file_mime_type || ''),
    file_size_bytes: body.file_size_bytes || null,
    sha256: cleanText(body.sha256 || ''),
    field_manifest: body.field_manifest || [],
    merge_tokens: body.merge_tokens || [],
    notes: cleanText(body.notes || ''),
    created_by: session.requester.id
  };

  const { data, error } = await sb.from('crm_contract_template_versions').insert(payload).select('*').single();
  if (error) throw error;

  const templateUpdate = {
    latest_version_number: nextVersion,
    active_version_id: data.id
  };
  const { error: templateErr } = await sb.from('crm_contract_templates').update(templateUpdate).eq('id', template.id);
  if (templateErr) throw templateErr;

  await insertContractEvent(sb, {
    owner_admin_id: data.owner_admin_id,
    template_id: template.id,
    event_type: 'template_version_created',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { version_number: data.version_number, version_label: data.version_label, source_file_name: data.source_file_name }
  });

  return response(200, { templateVersion: data }, corsHeaders());
}

async function createRequest(sb, session, body) {
  const partnerProfileId = requireField(cleanText(body.partner_profile_id), 'partner_profile_id');
  const templateId = requireField(cleanText(body.template_id), 'template_id');
  const partner = await assertPartnerScope(sb, session, partnerProfileId);
  const template = await loadOwnedTemplate(sb, session, templateId);
  if (template.partner_profile_id !== partner.id) {
    throw Object.assign(new Error('Template does not belong to the selected partner.'), { statusCode: 400 });
  }

  const templateVersionId = cleanText(body.template_version_id || template.active_version_id || '');
  if (!templateVersionId) {
    throw Object.assign(new Error('Template needs at least one version before a request can be created.'), { statusCode: 400 });
  }

  const requestPayload = {
    owner_admin_id: template.owner_admin_id,
    partner_profile_id: template.partner_profile_id,
    template_id: template.id,
    template_version_id: templateVersionId,
    lead_id: cleanText(body.lead_id || '') || null,
    signed_client_id: cleanText(body.signed_client_id || '') || null,
    created_by: session.requester.id,
    request_title: cleanText(body.request_title || `${template.template_name} Request`),
    email_subject: cleanText(body.email_subject || ''),
    email_message: cleanText(body.email_message || ''),
    client_name: cleanText(body.client_name || ''),
    client_email: cleanEmail(body.client_email || ''),
    cc_emails: asArray(body.cc_emails).map(cleanEmail).filter(Boolean),
    expires_at: cleanText(body.expires_at || '') || null,
    public_signing_slug: uniqueSlug('contract'),
    request_payload: body.request_payload || {},
    prefill_values: body.prefill_values || {}
  };

  const { data: requestRow, error: requestError } = await sb
    .from('crm_contract_requests')
    .insert(requestPayload)
    .select('*')
    .single();
  if (requestError) throw requestError;

  const signers = normalizeSignerInput(body.signers || []);
  if (signers.length) {
    const signerRows = signers.map((signer) => ({
      owner_admin_id: requestRow.owner_admin_id,
      request_id: requestRow.id,
      signer_role: signer.signer_role,
      signer_name: signer.signer_name,
      signer_email: signer.signer_email,
      signer_phone: signer.signer_phone,
      routing_order: signer.routing_order,
      status: 'draft',
      signing_token: randomToken(24)
    }));
    const { error: signerError } = await sb.from('crm_contract_signers').insert(signerRows);
    if (signerError) throw signerError;
  }

  await insertContractEvent(sb, {
    owner_admin_id: requestRow.owner_admin_id,
    request_id: requestRow.id,
    template_id: requestRow.template_id,
    event_type: 'request_created',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { request_title: requestRow.request_title, signer_count: signers.length }
  });

  return response(200, await getRequestBundle(sb, session, requestRow.id), corsHeaders());
}

async function replaceSigners(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (request.status !== 'draft') {
    throw Object.assign(new Error('Signer order can only be replaced while the request is still in draft.'), { statusCode: 400 });
  }
  const signers = normalizeSignerInput(body.signers || []);
  if (!signers.length) throw Object.assign(new Error('At least one signer is required.'), { statusCode: 400 });

  const { error: deleteErr } = await sb.from('crm_contract_signers').delete().eq('request_id', request.id);
  if (deleteErr) throw deleteErr;

  const rows = signers.map((signer) => ({
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    signer_role: signer.signer_role,
    signer_name: signer.signer_name,
    signer_email: signer.signer_email,
    signer_phone: signer.signer_phone,
    routing_order: signer.routing_order,
    status: 'draft',
    signing_token: randomToken(24)
  }));
  const { error: insertErr } = await sb.from('crm_contract_signers').insert(rows);
  if (insertErr) throw insertErr;

  await insertContractEvent(sb, {
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    template_id: request.template_id,
    event_type: 'request_updated',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { change: 'replace_signers', signer_count: rows.length }
  });

  return response(200, await getRequestBundle(sb, session, request.id), corsHeaders());
}

async function updateRequest(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (['signed', 'declined', 'voided', 'expired'].includes(request.status)) {
    throw Object.assign(new Error(`Request can no longer be edited while status is ${request.status}.`), { statusCode: 400 });
  }

  const patch = {};
  ['request_title', 'email_subject', 'email_message', 'client_name'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = cleanText(body[field]);
  });
  if (Object.prototype.hasOwnProperty.call(body, 'client_email')) patch.client_email = cleanEmail(body.client_email || '');
  if (Object.prototype.hasOwnProperty.call(body, 'expires_at')) patch.expires_at = cleanText(body.expires_at || '') || null;
  if (Object.prototype.hasOwnProperty.call(body, 'cc_emails')) patch.cc_emails = asArray(body.cc_emails).map(cleanEmail).filter(Boolean);
  if (Object.prototype.hasOwnProperty.call(body, 'request_payload')) patch.request_payload = body.request_payload || {};
  if (Object.prototype.hasOwnProperty.call(body, 'prefill_values')) patch.prefill_values = body.prefill_values || {};
  if (Object.prototype.hasOwnProperty.call(body, 'status') && ['draft', 'voided', 'expired'].includes(String(body.status || '').trim())) {
    patch.status = String(body.status).trim();
    if (patch.status === 'voided') patch.voided_at = new Date().toISOString();
  }
  if (!Object.keys(patch).length) throw Object.assign(new Error('No editable fields were provided.'), { statusCode: 400 });

  const { error } = await sb.from('crm_contract_requests').update(patch).eq('id', request.id);
  if (error) throw error;

  await insertContractEvent(sb, {
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    template_id: request.template_id,
    event_type: patch.status === 'voided' ? 'request_voided' : 'request_updated',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { updated_fields: Object.keys(patch) }
  });

  return response(200, await getRequestBundle(sb, session, request.id), corsHeaders());
}

async function sendRequest(sb, session, body, event) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (['signed', 'declined', 'voided', 'expired'].includes(request.status)) {
    throw Object.assign(new Error(`Cannot send a request in ${request.status} status.`), { statusCode: 400 });
  }

  const { data: signers, error: signersErr } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('request_id', request.id)
    .order('routing_order', { ascending: true });
  if (signersErr) throw signersErr;
  const rows = signers || [];
  if (!rows.length) throw Object.assign(new Error('Add at least one signer before sending the request.'), { statusCode: 400 });

  const firstOrder = Math.min(...rows.map((row) => Number(row.routing_order || 0)).filter(Boolean));
  const now = new Date().toISOString();

  for (const signer of rows) {
    const patch = Number(signer.routing_order || 0) === firstOrder
      ? { status: 'sent', sent_at: now, last_email_at: now }
      : { status: 'queued' };
    const { error } = await sb.from('crm_contract_signers').update(patch).eq('id', signer.id);
    if (error) throw error;
    if (patch.status === 'sent') {
      await insertContractEvent(sb, {
        owner_admin_id: request.owner_admin_id,
        request_id: request.id,
        signer_id: signer.id,
        template_id: request.template_id,
        event_type: 'email_queued',
        actor_user_id: session.requester.id,
        actor_type: 'user',
        event_data: { signer_email: signer.signer_email, signer_name: signer.signer_name, routing_order: signer.routing_order }
      });
    }
  }

  const { error: reqErr } = await sb
    .from('crm_contract_requests')
    .update({ status: 'sent', sent_at: now })
    .eq('id', request.id);
  if (reqErr) throw reqErr;

  await recalcRequestStatus(sb, request.id);
  await insertContractEvent(sb, {
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    template_id: request.template_id,
    event_type: 'request_sent',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { signer_count: rows.length }
  });

  const { data: refreshedSigners } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('request_id', request.id)
    .order('routing_order', { ascending: true });
  const delivery = await dispatchSignerEmails(sb, session, { ...request, ...{ email_subject: request.email_subject, email_message: request.email_message, cc_emails: request.cc_emails } }, refreshedSigners || [], event);

  const bundle = await getRequestBundle(sb, session, request.id);
  return response(200, { ...bundle, delivery }, corsHeaders());
}

async function resendRequestEmails(sb, session, body, event) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (['voided', 'expired', 'signed', 'declined'].includes(String(request.status || ''))) {
    throw Object.assign(new Error(`Cannot resend emails while status is ${request.status}.`), { statusCode: 400 });
  }
  const { data: signers, error } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('request_id', request.id)
    .order('routing_order', { ascending: true });
  if (error) throw error;
  const targets = (signers || []).filter((row) => ['sent', 'viewed'].includes(row.status));
  if (!targets.length) throw Object.assign(new Error('No active signers to resend emails to.'), { statusCode: 400 });
  const delivery = await dispatchSignerEmails(sb, session, request, targets, event);
  await insertContractEvent(sb, {
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    template_id: request.template_id,
    event_type: 'request_resent',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { delivery }
  });
  const bundle = await getRequestBundle(sb, session, request.id);
  return response(200, { ...bundle, delivery }, corsHeaders());
}

async function markSignerInPerson(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const signerId = requireField(cleanText(body.signer_id), 'signer_id');
  const request = await loadOwnedRequest(sb, session, requestId);
  if (['voided', 'expired', 'declined'].includes(String(request.status || ''))) {
    throw Object.assign(new Error(`Cannot launch in-person signing while status is ${request.status}.`), { statusCode: 400 });
  }
  const { data: signer, error } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('id', signerId)
    .eq('request_id', request.id)
    .maybeSingle();
  if (error) throw error;
  if (!signer) throw Object.assign(new Error('Signer not found for this request.'), { statusCode: 404 });

  const now = new Date().toISOString();
  const patch = { status: 'sent', sent_at: signer.sent_at || now, last_email_at: now };
  await sb.from('crm_contract_signers').update(patch).eq('id', signer.id);
  if (request.status === 'draft') {
    await sb.from('crm_contract_requests').update({ status: 'sent', sent_at: now }).eq('id', request.id);
  }
  await recalcRequestStatus(sb, request.id);
  await insertContractEvent(sb, {
    owner_admin_id: request.owner_admin_id,
    request_id: request.id,
    signer_id: signer.id,
    template_id: request.template_id,
    event_type: 'in_person_session_started',
    actor_user_id: session.requester.id,
    actor_type: 'user',
    event_data: { signer_email: signer.signer_email, signer_name: signer.signer_name, routing_order: signer.routing_order }
  });
  const bundle = await getRequestBundle(sb, session, request.id);
  return response(200, { ...bundle, in_person: { signer_id: signer.id, signing_token: signer.signing_token } }, corsHeaders());
}

async function updateSignerStatus(sb, session, body) {
  const requestId = requireField(cleanText(body.request_id), 'request_id');
  const signerId = requireField(cleanText(body.signer_id), 'signer_id');
  const nextStatus = requireField(cleanText(body.status), 'status');
  const request = await loadOwnedRequest(sb, session, requestId);
  const { data: signer, error: signerErr } = await sb
    .from('crm_contract_signers')
    .select('*')
    .eq('id', signerId)
    .eq('request_id', request.id)
    .maybeSingle();
  if (signerErr) throw signerErr;
  if (!signer) throw Object.assign(new Error('Signer not found for this request.'), { statusCode: 404 });

  const allowed = ['draft', 'queued', 'sent', 'viewed', 'signed', 'declined', 'expired', 'bounced', 'skipped'];
  if (!allowed.includes(nextStatus)) throw Object.assign(new Error(`Unsupported signer status: ${nextStatus}`), { statusCode: 400 });

  const now = new Date().toISOString();
  const patch = { status: nextStatus };
  if (nextStatus === 'sent') patch.sent_at = now;
  if (nextStatus === 'viewed') patch.viewed_at = now;
  if (nextStatus === 'signed') patch.signed_at = now;
  if (nextStatus === 'declined') patch.declined_at = now;
  if (['sent', 'viewed'].includes(nextStatus)) patch.last_email_at = now;
  if (Object.prototype.hasOwnProperty.call(body, 'decision_note')) patch.decision_note = cleanText(body.decision_note || '');
  if (Object.prototype.hasOwnProperty.call(body, 'signature_payload')) patch.signature_payload = body.signature_payload || {};

  const { error: updateErr } = await sb.from('crm_contract_signers').update(patch).eq('id', signer.id);
  if (updateErr) throw updateErr;

  const eventTypeMap = {
    viewed: 'signer_viewed',
    signed: 'signer_signed',
    declined: 'signer_declined',
    bounced: 'signer_bounced'
  };
  if (eventTypeMap[nextStatus]) {
    await insertContractEvent(sb, {
      owner_admin_id: request.owner_admin_id,
      request_id: request.id,
      signer_id: signer.id,
      template_id: request.template_id,
      event_type: eventTypeMap[nextStatus],
      actor_user_id: session.requester.id,
      actor_type: 'user',
      event_data: { signer_email: signer.signer_email, signer_name: signer.signer_name, status: nextStatus }
    });
  }

  if (nextStatus === 'signed') {
    await promoteNextSignerGroup(sb, request.id, request.owner_admin_id, session.requester.id);
  }
  await recalcRequestStatus(sb, request.id);

  return response(200, await getRequestBundle(sb, session, request.id), corsHeaders());
}

async function handlePostAction(sb, session, body, eventContext) {
  const action = cleanText(body.action || '');
  if (action === 'create_template') return createTemplate(sb, session, body);
  if (action === 'create_template_version') return createTemplateVersion(sb, session, body);
  if (action === 'create_request') return createRequest(sb, session, body);
  if (action === 'replace_signers') return replaceSigners(sb, session, body);
  if (action === 'update_request') return updateRequest(sb, session, body);
  if (action === 'send_request') return sendRequest(sb, session, body, eventContext);
  if (action === 'resend_emails') return resendRequestEmails(sb, session, body, eventContext);
  if (action === 'mark_in_person') return markSignerInPerson(sb, session, body);
  if (action === 'update_signer_status') return updateSignerStatus(sb, session, body);
  if (action === 'upload_template_file') return uploadTemplateFile(sb, session, body);
  if (action === 'sign_object_url') return signObjectUrl(sb, session, body);
  if (action === 'generate_signed_pdf') return generateRequestPdf(sb, session, body);
  if (action === 'resolve_fields') return resolveFieldsAction(sb, session, body);
  if (action === 'save_template_fields') return saveTemplateFieldsAction(sb, session, body);
  if (action === 'get_merge_sources') return response(200, { sources: getSourceCatalog() }, corsHeaders());
  if (action === 'get_template_version_pdf_url') return getTemplateVersionPdfUrlAction(sb, session, body);
  if (action === 'regenerate_rendered_pdf') return regenerateRenderedPdfAction(sb, session, body);
  if (action === 'update_template') return updateTemplateAction(sb, session, body);
  if (action === 'delete_template') return deleteTemplateAction(sb, session, body);
  if (action === 'archive_template_version') return archiveTemplateVersionAction(sb, session, body);
  if (action === 'cancel_request') return cancelRequestAction(sb, session, body);
  if (action === 'delete_request') return deleteRequestAction(sb, session, body);
  if (action === 'update_partner_contact') return updatePartnerContactAction(sb, session, body);
  return response(400, { error: `Unsupported action: ${action}` }, corsHeaders());
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, '', corsHeaders());
  try {
    const session = await requireAdminSession(event);
    const sb = getRequiredSupabase();

    if (event.httpMethod === 'GET') return await handleGetResource(sb, session, event);
    if (event.httpMethod === 'POST') {
      const body = await readJsonBody(event);
      return await handlePostAction(sb, session, body, event);
    }
    return response(405, { error: 'Method not allowed' }, corsHeaders());
  } catch (error) {
    console.error('[partner-contracts] error:', error);
    return response(error.statusCode || 500, { error: error.message || 'Unexpected Partner Contracts error.' }, corsHeaders());
  }
};
