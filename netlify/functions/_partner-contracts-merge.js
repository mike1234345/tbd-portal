/* build:1780028952622 */
// Merge field resolution helpers for Partner Contracts.
//
// Sources of values in priority order:
//   1. signer-provided values (from the signing UI when they type into a text field)
//   2. request.prefill_values (admin-entered or CRM auto-fill at create time)
//   3. derived defaults from the request itself (client_name, client_email, etc.)
//   4. derived defaults from the partner profile
//   5. blank
//
// CRM source keys recognized for auto-fill:
//   client_name, client_email, client_phone, client_first_name, client_last_name
//   address_full, address_street, address_city, address_state, address_zip
//   insurance_carrier, policy_number, claim_number
//   date_of_loss, date_of_commencement, date_today
//   partner_name, partner_business_name, partner_phone, partner_email
//   mortgage_company, mortgage_phone, mortgage_loan_number, mortgagor_name
//   property_address, execution_date

const SOURCE_LABELS = {
  client_name: 'Client name',
  client_email: 'Client email',
  client_phone: 'Client phone',
  client_first_name: 'Client first name',
  client_last_name: 'Client last name',
  address_full: 'Full property address',
  address_street: 'Street',
  address_city: 'City',
  address_state: 'State',
  address_zip: 'ZIP',
  insurance_carrier: 'Insurance carrier',
  policy_number: 'Policy number',
  claim_number: 'Claim number',
  date_of_loss: 'Date of loss',
  date_of_commencement: 'Date of commencement',
  date_today: 'Today\u2019s date',
  type_of_loss: 'Type of loss (damage type)',
  partner_name: 'Partner name',
  partner_business_name: 'Partner business name',
  partner_phone: 'Partner phone',
  partner_email: 'Partner email',
  mortgage_company: 'Mortgage company',
  mortgage_phone: 'Mortgage phone',
  mortgage_loan_number: 'Mortgage loan number',
  mortgagor_name: 'Mortgagor name',
  property_address: 'Property address',
  execution_date: 'Execution date'
};

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toISOString().slice(0, 10);
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

function buildSourceValues({ request = {}, partner = null, signedClient = null, lead = null }) {
  const prefill = request.prefill_values || {};
  const clientName = prefill.client_name || request.client_name || signedClient?.client_name || lead?.contact_name || '';
  const { first, last } = splitName(clientName);
  const todayIso = new Date().toISOString().slice(0, 10);

  const out = {
    client_name: clientName,
    client_first_name: prefill.client_first_name || first,
    client_last_name: prefill.client_last_name || last,
    client_email: prefill.client_email || request.client_email || signedClient?.email || lead?.email || '',
    client_phone: prefill.client_phone || signedClient?.phone || lead?.phone || '',
    address_full: prefill.address_full
      || signedClient?.property_address
      || [signedClient?.property_address, signedClient?.city, signedClient?.state, signedClient?.zip].filter(Boolean).join(', ')
      || [lead?.address, lead?.city, lead?.state, lead?.zip].filter(Boolean).join(', ')
      || '',
    address_street: prefill.address_street || signedClient?.property_address || lead?.address || '',
    address_city: prefill.address_city || signedClient?.city || lead?.city || '',
    address_state: prefill.address_state || signedClient?.state || lead?.state || '',
    address_zip: prefill.address_zip || signedClient?.zip || lead?.zip || '',
    insurance_carrier: prefill.insurance_carrier || signedClient?.insurance_carrier || '',
    policy_number: prefill.policy_number || signedClient?.policy_number || '',
    claim_number: prefill.claim_number || signedClient?.claim_number || '',
    date_of_loss: formatDate(prefill.date_of_loss || signedClient?.date_of_loss || lead?.date_of_loss || ''),
    type_of_loss: prefill.type_of_loss || signedClient?.damage_type || lead?.damage_type || '',
    date_of_commencement: formatDate(prefill.date_of_commencement || signedClient?.signed_date || todayIso),
    date_today: todayIso,
    partner_name: partner?.display_name || '',
    partner_business_name: partner?.business_name || '',
    partner_email: partner?.contact_email || partner?.email || '',
    partner_phone: partner?.contact_phone || partner?.phone || '',
    mortgage_company: prefill.mortgage_company || signedClient?.mortgage_company || '',
    mortgage_phone: prefill.mortgage_phone || signedClient?.mortgage_phone || '',
    mortgage_loan_number: prefill.mortgage_loan_number || signedClient?.mortgage_loan_number || '',
    mortgagor_name: prefill.mortgagor_name || signedClient?.mortgagor_name || clientName,
    property_address: prefill.property_address || prefill.address_full || signedClient?.property_address || lead?.address || '',
    execution_date: formatDate(prefill.execution_date || todayIso)
  };

  // Allow arbitrary admin overrides via prefill: any prefill key not in the standard
  // map is exposed verbatim so custom merge fields can reference it.
  Object.entries(prefill).forEach(([key, value]) => {
    if (out[key] === undefined) out[key] = String(value == null ? '' : value);
  });
  return out;
}

function resolveFieldValues({ merge_fields = [], request, partner, signedClient, lead, signerValues = {} }) {
  const sources = buildSourceValues({ request, partner, signedClient, lead });
  return (merge_fields || []).map((field) => {
    const id = field.id || '';
    const explicit = signerValues[id] || (request.prefill_values || {})[id];
    let value = explicit;
    if ((value === undefined || value === '') && field.prefill_source) {
      value = sources[field.prefill_source];
    }
    if (value === undefined || value === null) value = '';
    return {
      ...field,
      resolved_value: String(value),
      source: explicit ? 'override' : field.prefill_source ? 'crm' : 'blank'
    };
  });
}

function getSourceCatalog() {
  return Object.keys(SOURCE_LABELS).map((key) => ({ key, label: SOURCE_LABELS[key] }));
}

module.exports = {
  buildSourceValues,
  resolveFieldValues,
  getSourceCatalog,
  formatDate
};
