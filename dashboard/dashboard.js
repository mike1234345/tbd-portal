// =====================================================
// TBD Marketing Solutions — Agent Dashboard
// Tracks leads, call attempts, and appointments via Supabase
// =====================================================

const SUPABASE_URL = 'https://wzqlvyjhbdqflypdzcxs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4tFDFSPT636VfKCRiFn3Aw_0qcH04yv';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== STATE ======
let currentUser = null;
let currentUserRole = 'agent';
let roleDirectory = [];
let managedAgents = [];
let allLeads = [];
let allCalls = [];
let allAppts = [];
let totalLeadCount = 0;
let filteredLeadCount = 0;
let leadPageSize = 100;
let currentLeadPage = 1;
let leadFilterTimer = null;
let leadStateOptions = [];
let leadCountyOptions = [];
let leadTableSort = {
  key: '',
  direction: 'asc'
};
let leadCache = new Map();
let leadCallsMap = new Map();
let leadLastCallMap = new Map();
let activeLeadId = null;
let editingLeadId = null;
let editingCallId = null;
let editingCallSessionId = null;
let messageConversations = [];
let messageThreads = new Map();
let messageParticipants = new Map();
let activeConversationId = null;
let messageRealtimeChannel = null;
let messagesMode = 'live';
const MESSAGES_FALLBACK_STORAGE_KEY = 'tbdMessagesFallbackV1';
let deferredInstallPrompt = null;

// ====== DOM ======
const $ = (id) => document.getElementById(id);
const loginScreen = $('loginScreen');
const dashScreen = $('dashboardScreen');

let leadFilterLoadPromise = null;
let messagesLoadPromise = null;
let trainingLoadPromise = null;
let stormIntelLoadPromise = null;
let dashboardWarmupScheduled = false;

const lazyFeatureState = {
  leadFiltersLoaded: false,
  messagesLoaded: false,
  trainingLoaded: false,
  stormIntelLoaded: false
};

const TEAM_LABEL_OPTIONS = ["Mike's Team", 'Chay Team'];
const TEAM_LABEL_ALIASES = {
  'Your Team': "Mike's Team",
  'Mikes Team': "Mike's Team",
  'Mike Team': "Mike's Team"
};
const HARDCODED_TEAM_MATCHERS = {
  'Chay Team': [
    'chay',
    'jennifer',
    'john',
    'jhon',
    'libby',
    'jennifer@pyro.com',
    'jhon@pyro.com',
    'libby@pyro.com'
  ],
  "Mike's Team": [
    'mike',
    'augchy',
    'kim',
    'jake',
    'mbporizza01@gmail.com',
    'mbpo.kimmm@gmail.com',
    'mbpo.mike@gmail.com'
  ]
};

function syncRuntimeGlobals() {
  window.sb = sb;
  window.currentUser = currentUser;
  window.currentUserRole = currentUserRole;
  window.roleDirectory = roleDirectory;
}

syncRuntimeGlobals();

function getActiveView() {
  return document.querySelector('.nav-item.active')?.dataset.view || 'overview';
}

function isViewActive(viewName) {
  return getActiveView() == viewName;
}

function isMapModeActive() {
  return isViewActive('map');
}

function applyDashboardVisualState(viewName = getActiveView()) {
  if (!document.body) return;
  document.body.dataset.activeView = viewName || 'overview';
  document.body.dataset.screen = dashScreen.classList.contains('hidden') ? 'login' : 'dashboard';
}

function showView(viewName) {
  let targetView = viewName || 'overview';
  if (targetView === 'agent-admin' && !isSuperAdmin()) targetView = 'overview';
  if (targetView === 'partner-contracts' && !isAdmin()) targetView = 'overview';
  if (targetView === 'contracts-setup' && !isSuperAdmin()) targetView = 'overview';
  if (targetView === 'signed-clients' && !isAdmin()) targetView = 'overview';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === targetView);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.remove('active');
    view.classList.add('hidden');
  });
  const nextView = $('view-' + targetView);
  if (nextView) {
    nextView.classList.remove('hidden');
    nextView.classList.add('active');
  }
  applyDashboardVisualState(targetView);

  if (targetView === 'leads') {
    ensureLeadFilterOptionsLoaded().catch(() => null);
  }

  if (targetView === 'map') {
    renderMapMode();
    ensureStormIntelLoaded().catch(() => null);
  }


  if (targetView === 'training') {
    initTrainingTab();
    activateTrainingModule(activeTrainingModule);
    renderTrainingMode();
    ensureTrainingProgressLoaded()
      .then(() => {
        if (isViewActive('training')) renderTrainingMode();
      })
      .catch(() => null);
  }

  if (targetView === 'messages') {
    renderMessagesView();
    ensureMessagesDataLoaded({ preserveSelection: true })
      .then(() => {
        if (isViewActive('messages')) {
          renderMessagesView();
          markConversationRead(activeConversationId);
        }
      })
      .catch(() => null);
  }

  if (targetView === 'partner-contracts') {
    window.loadPartnerContractsViewData?.({ force: false });
  }

  if (targetView === 'contracts-setup') {
    window.loadContractsSetupView?.({ force: true });
  }

  if (targetView === 'signed-clients') {
    window.loadSignedClientsViewData?.({ force: false });
  }

  if (targetView === 'dialer') {
    window.loadDialerViewData?.({ force: false });
  }
}

function scheduleIdleWork(task, delay = 180) {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout: Math.max(600, delay * 6) });
    return;
  }
  window.setTimeout(task, delay);
}

function scheduleDashboardWarmup() {
  if (dashboardWarmupScheduled) return;
  dashboardWarmupScheduled = true;
  scheduleIdleWork(() => {
    ensureLeadFilterOptionsLoaded().catch(() => null);
    window.loadDialerViewData?.({ force: false });
    if (isSuperAdmin()) {
      loadManagedAgents().then(renderManagedAgents).catch(() => null);
    }
    if (isAdmin()) {
      window.loadPartnerContractsViewData?.({ force: false });
      window.loadSignedClientsViewData?.({ force: false });
    }
  }, 420);
}

// ====== AUTH ======
async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) showDashboard(session.user);
  else showLogin();
}

function showLogin() {
  loginScreen.classList.remove('hidden');
  dashScreen.classList.add('hidden');
  syncRuntimeGlobals();
  applyDashboardVisualState('overview');
}

async function showDashboard(user) {
  currentUser = user;
  syncRuntimeGlobals();
  loginScreen.classList.add('hidden');
  dashScreen.classList.remove('hidden');
  applyDashboardVisualState(getActiveView());
  $('userName').textContent = (user.email || 'agent').split('@')[0];
  $('userEmail').textContent = user.email;
  $('settingsEmail').textContent = user.email;
  $('settingsUserId').textContent = user.id;
  await loadCurrentUserRole();
  await loadAll();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').classList.add('hidden');
  const email = $('loginEmail').value;
  const password = $('loginPassword').value;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    $('loginError').textContent = '❌ ' + error.message;
    $('loginError').classList.remove('hidden');
    return;
  }
  showDashboard(data.user);
});

$('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  currentUser = null;
  currentUserRole = 'agent';
  roleDirectory = [];
  syncRuntimeGlobals();
  teardownMessageRealtime();
  showLogin();
});

// ====== NAV ======
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', async (e) => {
    e.preventDefault();
    showView(item.dataset.view);
  });
});

const TRAINING_MODULES = {
  roofing: {
    title: 'Roofing Call Sheet',
    subtitle: 'Updated Rapid Roofing roofing script with a tighter storm-based opener and embedded training video.',
    href: '/dashboard/training/roofing_callsheet.html',
    statLabel: 'Roofing',
    drills: [
      {
        title: 'Roofing opener sprint',
        body: 'Practice a short opener that leads with the storm event, the free assessment, and the insurance benefit — then close straight into scheduling.',
        cues: ['Lead with the most recent local storm activity in one line.', 'Mention the free roof assessment and that insurance covers any repairs.', 'Close with a scheduling question — never a qualifying question.']
      },
      {
        title: 'Qualify the homeowner fast',
        body: 'Confirm owner status, roof age, and visible concerns without sounding like an interrogation.',
        cues: ['Ask whether they own the home.', 'Bridge into roof age or recent leaks.', 'Transition into why a quick exterior check is helpful.']
      },
      {
        title: 'Book the inspection',
        body: 'Lock in the appointment with a simple time choice and a confidence-building close.',
        cues: ['Offer two short appointment windows.', 'Repeat that the inspection is free.', 'Confirm address and best callback number.']
      }
    ],
    objections: [
      {
        title: 'We already have a roofer',
        response: 'Totally fair — a lot of homeowners still let Rapid Roofing give a free second opinion so they know what the recent storms actually did before they commit.'
      },
      {
        title: 'I’m not interested',
        response: 'No problem. The only reason I called is the recent local weather and the fact that Rapid Roofing can do a free inspection while we are already working nearby.'
      },
      {
        title: 'Call me later',
        response: 'Absolutely — what part of the day works best so I can call back briefly with the local storm update and not keep chasing you?' 
      }
    ]
  },
  plumbing: {
    title: 'Plumbing Call Sheet',
    subtitle: 'Plumbing assessment training page with call structure, objections, and booking prompts.',
    href: '/dashboard/training/plumbing_callsheet.html',
    statLabel: 'Plumbing',
    drills: [
      {
        title: 'Water-loss opener',
        body: 'Lead with urgency around leaks, moisture, and prevention while staying calm and trustworthy.',
        cues: ['Open with a quick local plumbing concern.', 'Position the assessment as preventive, not salesy.', 'Ask a short question about active leaks or water pressure issues.']
      },
      {
        title: 'Discovery questions',
        body: 'Use short discovery prompts to uncover hidden damage, backups, or repeated fixture issues.',
        cues: ['Ask about recurring leaks or slow drains.', 'Identify urgency: active, recent, or just preventive.', 'Bridge into why a technician visit helps.']
      },
      {
        title: 'Close the plumbing appointment',
        body: 'Use a soft but direct schedule close that makes the next step feel easy.',
        cues: ['Offer two simple visit windows.', 'Reconfirm the visit is an assessment.', 'Repeat what the tech will check on arrival.']
      }
    ],
    objections: [
      {
        title: 'We don’t need plumbing help',
        response: 'Understood — a lot of people say that until a small leak or pressure issue turns into a bigger cleanup. That is exactly why the check is useful.'
      },
      {
        title: 'We have to ask my spouse',
        response: 'That makes sense. Let’s do this the easy way — what time should I circle back so both decision-makers can hear the quick overview together?'
      },
      {
        title: 'Send me information first',
        response: 'Happy to. I can send a quick summary, and while I have you, is there a better time for a short call in case any leak or water issue is already active?'
      }
    ]
  }
};
let activeTrainingModule = 'roofing';
let trainingDrillIndex = {
  roofing: 0,
  plumbing: 0
};
let stormIntel = {
  alerts: [],
  states: ['FL'],
  loadedAt: null,
  radarUpdatedAt: null,
  radarFrames: 0,
  severeReports: [],
  summary: null,
  countyBreakdown: [],
  monthlyBreakdown: []
};

let stormMap = null;
let stormMapLayers = {
  counties: null,
  reports: null,
  selected: null,
  leads: null
};
let selectedStormCounty = '';
let selectedStormCity = '';
let stormReportFilter = 'all';
let stormReportSearch = '';
let stormLeadOverlayTimer = null;
let stormLeadGeoCache = loadStormLeadGeoCache();
let stormLeadOverlayState = {
  loading: false,
  queued: false,
  geocoded: 0,
  totalCandidates: 0,
  checkedTotal: 0,
  visible: 0,
  lastRun: null
};

let crmLeadOverlayScanCount = 0;

const FLORIDA_STATE_ALIASES = new Set(['FL', 'FLORIDA']);

const LEAD_LOCATION_FIELD_ALIASES = {
  address: ['address', 'street', 'streetaddress', 'street_address', 'propertyaddress', 'property_address', 'serviceaddress', 'service_address', 'jobaddress', 'job_address', 'siteaddress', 'site_address', 'mailingaddress', 'mailing_address', 'address1', 'address_1', 'addressline1', 'address_line_1', 'fulladdress', 'full_address', 'location', 'leadlocation', 'lead_location'],
  city: ['city', 'cityname', 'city_name', 'town', 'municipality'],
  county: ['county', 'countyname', 'county_name', 'parish'],
  state: ['state', 'statename', 'state_name', 'province', 'region'],
  zip: ['zip', 'zipcode', 'zip_code', 'postal', 'postalcode', 'postal_code']
};

function normalizeLeadFieldKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function getLeadLocationContainers(lead = {}) {
  return [lead, lead.custom_fields, lead.customFields, lead.metadata, lead.extra, lead.raw, lead.raw_data]
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function getLeadFieldByAliases(lead = {}, aliases = []) {
  const normalizedAliases = new Set((aliases || []).map((alias) => normalizeLeadFieldKey(alias)));
  if (!normalizedAliases.size) return '';

  for (const container of getLeadLocationContainers(lead)) {
    for (const [key, value] of Object.entries(container)) {
      if (value === null || value === undefined) continue;
      const normalizedKey = normalizeLeadFieldKey(key);
      if (!normalizedAliases.has(normalizedKey)) continue;
      const trimmed = typeof value === 'string' ? value.trim() : String(value).trim();
      if (trimmed) return trimmed;
    }
  }

  return '';
}

function getLeadDerivedLocation(lead = {}) {
  return {
    address: getLeadFieldByAliases(lead, LEAD_LOCATION_FIELD_ALIASES.address),
    city: getLeadFieldByAliases(lead, LEAD_LOCATION_FIELD_ALIASES.city),
    county: normalizeStormCounty(getLeadFieldByAliases(lead, LEAD_LOCATION_FIELD_ALIASES.county)),
    state: normalizeStormState(getLeadFieldByAliases(lead, LEAD_LOCATION_FIELD_ALIASES.state)),
    zip: getLeadFieldByAliases(lead, LEAD_LOCATION_FIELD_ALIASES.zip)
  };
}

function getStormLeadGeoStorageKey() {
  return 'tbd-storm-lead-geo-v2';
}

function loadStormLeadGeoCache() {
  try {
    const raw = window.localStorage.getItem(getStormLeadGeoStorageKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveStormLeadGeoCache() {
  try {
    window.localStorage.setItem(getStormLeadGeoStorageKey(), JSON.stringify(stormLeadGeoCache));
  } catch (error) {
    console.warn('Could not persist storm lead overlay cache', error);
  }
}

function normalizeStormState(value = '') {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'FLORIDA') return 'FL';
  return raw;
}

function normalizeStormCounty(value = '') {
  return String(value || '')
    .replace(/\s+county$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocationToken(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STORM_LOCATION_NOISE_TOKENS = new Set([
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  'north', 'south', 'east', 'west',
  'road', 'rd', 'street', 'st.', 'avenue', 'ave', 'boulevard', 'blvd', 'drive', 'dr', 'lane', 'ln',
  'highway', 'hwy', 'route', 'rt', 'interstate', 'jct', 'junction', 'exit', 'mile', 'marker', 'mm',
  'airport', 'airpark', 'parkway', 'pkwy', 'trail', 'trl', 'circle', 'cir', 'court', 'ct', 'place', 'pl',
  'near', 'at', 'of', 'county', 'ar'
]);

function normalizeCityComparableLabel(value = '') {
  const tokens = normalizeLocationToken(value)
    .split(' ')
    .filter(Boolean)
    .filter(token => !STORM_LOCATION_NOISE_TOKENS.has(token));
  return tokens.join(' ');
}

function cityLabelsLikelyMatch(left = '', right = '') {
  const leftNormalized = normalizeLocationToken(left);
  const rightNormalized = normalizeLocationToken(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized) return true;

  const leftComparable = normalizeCityComparableLabel(left);
  const rightComparable = normalizeCityComparableLabel(right);
  if (leftComparable && rightComparable) {
    if (leftComparable === rightComparable) return true;
    if (leftComparable.startsWith(`${rightComparable} `) || leftComparable.includes(` ${rightComparable} `)) return true;
    if (rightComparable.startsWith(`${leftComparable} `) || rightComparable.includes(` ${leftComparable} `)) return true;
  }

  if (leftNormalized.startsWith(`${rightNormalized} `) || leftNormalized.includes(` ${rightNormalized} `)) return true;
  if (rightNormalized.startsWith(`${leftNormalized} `) || rightNormalized.includes(` ${leftNormalized} `)) return true;
  return false;
}

function isFloridaLead(lead = {}) {
  const location = getLeadDerivedLocation(lead);
  return !location.state || FLORIDA_STATE_ALIASES.has(location.state);
}

function getLeadLocationQuery(lead = {}) {
  const location = getLeadDerivedLocation(lead);
  const state = location.state || ((location.address || location.city || location.county || location.zip) ? 'FL' : '');
  return [location.address, location.city, state, location.zip]
    .filter(Boolean)
    .map(value => String(value).trim())
    .filter(Boolean)
    .join(', ');
}

function getLeadGeoCacheKey(lead = {}) {
  const location = getLeadDerivedLocation(lead);
  const state = location.state || 'FL';
  const zipKey = normalizeLocationToken(location.zip || '');
  const cityKey = normalizeLocationToken(location.city || '');
  const addressKey = normalizeLocationToken(location.address || '');
  if (addressKey) return `${state}|addr|${addressKey}|${cityKey}|${zipKey}`;
  if (zipKey && cityKey) return `${state}|zipcity|${zipKey}|${cityKey}`;
  if (zipKey) return `${state}|zip|${zipKey}`;
  if (cityKey) return `${state}|city|${cityKey}`;
  return `${state}|id|${lead.id || 'unknown'}`;
}

let stormGeoSeedMemo = {
  key: '',
  cityLookup: new Map(),
  countyLookup: new Map(),
  countyCityLookup: new Map()
};

function getStormGeoSeedLookups() {
  const reports = getStormReportsWithCoords();
  const memoKey = `${stormIntel.loadedAt || ''}:${reports.length}`;
  if (stormGeoSeedMemo.key === memoKey) return stormGeoSeedMemo;

  const countyLookup = new Map();
  buildStormCountyZones().forEach((zone) => {
    countyLookup.set(normalizeLocationToken(zone.county), zone);
  });

  const rawCityLookup = new Map();
  const rawCountyCityLookup = new Map();
  reports.forEach((report) => {
    const cityKey = normalizeLocationToken(report.city || '');
    const countyKey = normalizeLocationToken(normalizeStormCounty(report.county || ''));
    if (!cityKey) return;
    const entry = rawCityLookup.get(cityKey) || {
      total: 0,
      latTotal: 0,
      lonTotal: 0,
      reports: [],
      countyCounts: new Map(),
      displayCity: report.city || ''
    };
    entry.total += 1;
    entry.latTotal += Number(report.lat);
    entry.lonTotal += Number(report.lon);
    entry.reports.push(report);
    if (countyKey) entry.countyCounts.set(countyKey, (entry.countyCounts.get(countyKey) || 0) + 1);
    rawCityLookup.set(cityKey, entry);

    if (countyKey) {
      const countyCityKey = `${countyKey}|${cityKey}`;
      const countyCityEntry = rawCountyCityLookup.get(countyCityKey) || {
        total: 0,
        latTotal: 0,
        lonTotal: 0,
        reports: [],
        county: normalizeStormCounty(report.county || ''),
        city: report.city || ''
      };
      countyCityEntry.total += 1;
      countyCityEntry.latTotal += Number(report.lat);
      countyCityEntry.lonTotal += Number(report.lon);
      countyCityEntry.reports.push(report);
      rawCountyCityLookup.set(countyCityKey, countyCityEntry);
    }
  });

  const cityLookup = new Map();
  rawCityLookup.forEach((entry, cityKey) => {
    const centerLat = entry.total ? entry.latTotal / entry.total : null;
    const centerLon = entry.total ? entry.lonTotal / entry.total : null;
    const anchor = entry.reports.reduce((best, report) => {
      const score = Math.abs(Number(report.lat) - centerLat) + Math.abs(Number(report.lon) - centerLon);
      if (!best || score < best.score) return { report, score };
      return best;
    }, null)?.report || entry.reports[0];

    const bestCountyKey = [...entry.countyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const countyZone = countyLookup.get(bestCountyKey) || null;
    cityLookup.set(cityKey, {
      lat: Number(anchor?.lat),
      lon: Number(anchor?.lon),
      county: countyZone?.county || normalizeStormCounty(anchor?.county || ''),
      label: entry.displayCity || anchor?.city || ''
    });
  });

  const countyCityLookup = new Map();
  rawCountyCityLookup.forEach((entry, countyCityKey) => {
    const centerLat = entry.total ? entry.latTotal / entry.total : null;
    const centerLon = entry.total ? entry.lonTotal / entry.total : null;
    const anchor = entry.reports.reduce((best, report) => {
      const score = Math.abs(Number(report.lat) - centerLat) + Math.abs(Number(report.lon) - centerLon);
      if (!best || score < best.score) return { report, score };
      return best;
    }, null)?.report || entry.reports[0];

    countyCityLookup.set(countyCityKey, {
      lat: Number(anchor?.lat ?? centerLat),
      lon: Number(anchor?.lon ?? centerLon),
      county: normalizeStormCounty(entry.county || anchor?.county || ''),
      label: entry.city || anchor?.city || ''
    });
  });

  stormGeoSeedMemo = { key: memoKey, cityLookup, countyLookup, countyCityLookup };
  return stormGeoSeedMemo;
}

function getLeadGeocodeSeedFromStormData(lead = {}) {
  const location = getLeadDerivedLocation(lead);
  const cityLabel = String(location.city || '').trim();
  const cityKey = normalizeLocationToken(cityLabel);
  const countyKey = normalizeLocationToken(location.county || '');
  if (!cityKey) return null;
  const lookups = getStormGeoSeedLookups();
  const exactMatch = countyKey ? lookups.countyCityLookup.get(`${countyKey}|${cityKey}`) : null;

  let cityMatch = exactMatch || lookups.cityLookup.get(cityKey) || null;

  if (!cityMatch && countyKey) {
    for (const [compoundKey, entry] of lookups.countyCityLookup.entries()) {
      if (!compoundKey.startsWith(`${countyKey}|`)) continue;
      if (cityLabelsLikelyMatch(entry.label || '', cityLabel)) {
        cityMatch = entry;
        break;
      }
    }
  }

  if (!cityMatch) {
    for (const entry of lookups.cityLookup.values()) {
      if (cityLabelsLikelyMatch(entry.label || '', cityLabel)) {
        cityMatch = entry;
        break;
      }
    }
  }

  if (!cityMatch || !Number.isFinite(Number(cityMatch.lat)) || !Number.isFinite(Number(cityMatch.lon))) return null;
  return {
    lat: Number(cityMatch.lat),
    lon: Number(cityMatch.lon),
    label: cityMatch.label || getLeadLocationQuery(lead),
    county: normalizeStormCounty(cityMatch.county || ''),
    updatedAt: new Date().toISOString(),
    inferred: true
  };
}

function getCachedLeadCoords(lead = {}) {
  const cached = stormLeadGeoCache[getLeadGeoCacheKey(lead)] || null;
  if (cached) {
    const lat = Number(cached.lat);
    const lon = Number(cached.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return {
        lat,
        lon,
        label: cached.label || '',
        county: normalizeStormCounty(cached.county || ''),
        updatedAt: cached.updatedAt || null,
        inferred: Boolean(cached.inferred)
      };
    }
  }
  return getLeadGeocodeSeedFromStormData(lead);
}

function getLeadOverlayCandidates() {
  const seen = new Map();
  [...leadCache.values(), ...allLeads].forEach((lead) => {
    if (!lead?.id || seen.has(lead.id)) return;
    seen.set(lead.id, lead);
  });
  stormLeadOverlayState.checkedTotal = seen.size || crmLeadOverlayScanCount || totalLeadCount || 0;
  return [...seen.values()].filter((lead) => {
    const location = getLeadDerivedLocation(lead);
    return Boolean(location.address || location.city || location.county || location.zip);
  });
}

function countGeocodedLeadCandidates(candidates = []) {
  return candidates.filter((lead) => getCachedLeadCoords(lead)).length;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * (Math.PI / 180);
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a));
}

function getLeadDisplayLocation(lead = {}, coords = null) {
  const location = getLeadDerivedLocation(lead);
  return [location.address, [location.city, location.state || 'FL'].filter(Boolean).join(', '), location.zip]
    .filter(Boolean)
    .join(' · ') || coords?.label || 'Florida lead';
}

function getLeadOverlayCountyLabel(lead = {}) {
  const location = getLeadDerivedLocation(lead);
  if (location.county) return location.county;
  const cached = stormLeadGeoCache[getLeadGeoCacheKey(lead)] || null;
  return normalizeStormCounty(cached?.county || '');
}

function getZoneCityBreakdown(zone) {
  if (!zone?.reports?.length) return [];
  const cityLookup = new Map();
  zone.reports.forEach((report) => {
    const cityLabel = String(report.city || '').trim() || 'City not listed';
    const cityKey = normalizeLocationToken(cityLabel) || 'city-not-listed';
    if (!cityLookup.has(cityKey)) {
      cityLookup.set(cityKey, {
        city: cityLabel,
        total: 0,
        hail: 0,
        wind: 0,
        latestDate: report.beginDate,
        latTotal: 0,
        lonTotal: 0,
        points: 0,
        reports: []
      });
    }
    const entry = cityLookup.get(cityKey);
    entry.total += 1;
    if (report.kind === 'hail') entry.hail += 1;
    if (report.kind === 'wind') entry.wind += 1;
    if (Number.isFinite(Number(report.lat)) && Number.isFinite(Number(report.lon))) {
      entry.latTotal += Number(report.lat);
      entry.lonTotal += Number(report.lon);
      entry.points += 1;
    }
    if (new Date(report.beginDate || 0).getTime() > new Date(entry.latestDate || 0).getTime()) entry.latestDate = report.beginDate;
    entry.reports.push(report);
  });
  return [...cityLookup.values()]
    .map((entry) => ({
      ...entry,
      lat: entry.points ? entry.latTotal / entry.points : Number(zone.lat),
      lon: entry.points ? entry.lonTotal / entry.points : Number(zone.lon),
      reports: entry.reports.sort((a, b) => new Date(b.beginDate || 0) - new Date(a.beginDate || 0))
    }))
    .sort((a, b) => b.total - a.total || b.wind - a.wind || b.hail - a.hail || a.city.localeCompare(b.city));
}

function getSelectedStormCityContext(zone) {
  if (!zone) return null;
  const cityOptions = getZoneCityBreakdown(zone);
  if (!cityOptions.length) return null;
  const selectedKey = normalizeLocationToken(selectedStormCity || '');
  return cityOptions.find((city) => normalizeLocationToken(city.city) === selectedKey) || cityOptions[0] || null;
}

function getZoneLeadMatches(zone, cityContext = getSelectedStormCityContext(zone)) {
  if (!zone) return [];
  const cityLabel = String(cityContext?.city || '').trim();
  const countyKey = normalizeLocationToken(zone.county || '');
  const targetLat = Number(cityContext?.lat ?? zone.lat);
  const targetLon = Number(cityContext?.lon ?? zone.lon);
  const matchRadiusMiles = Number.isFinite(targetLat) && Number.isFinite(targetLon)
    ? Math.max(8, Math.min(26, 6 + ((cityContext?.total || zone.total || 0) * 0.55)))
    : null;

  return getLeadOverlayCandidates()
    .map((lead) => {
      if (!isFloridaLead(lead)) {
        return {
          lead,
          countyMatch: false,
          cityMatch: false,
          geoMatch: false,
          geoMiles: null,
          include: false,
          overlayScore: -1
        };
      }

      const location = getLeadDerivedLocation(lead);
      const leadCountyLabel = getLeadOverlayCountyLabel(lead);
      const leadCountyKey = normalizeLocationToken(leadCountyLabel);
      const countyMatch = countyKey ? leadCountyKey === countyKey : false;
      const cityMatch = cityLabel ? cityLabelsLikelyMatch(location.city || '', cityLabel) : false;
      let geoMiles = null;
      let geoMatch = false;
      if (!countyMatch && !cityMatch && Number.isFinite(targetLat) && Number.isFinite(targetLon) && Number.isFinite(matchRadiusMiles)) {
        const coords = getCachedLeadCoords(lead);
        geoMiles = coords ? haversineMiles(targetLat, targetLon, Number(coords.lat), Number(coords.lon)) : null;
        geoMatch = Number.isFinite(geoMiles) && geoMiles <= matchRadiusMiles;
      }
      const include = countyMatch || (cityMatch && (!leadCountyKey || countyMatch || !countyKey)) || geoMatch;
      const overlayScore = (countyMatch ? 1000 : 0)
        + (cityMatch ? 220 : 0)
        + (geoMatch && Number.isFinite(geoMiles) ? Math.max(0, 120 - Math.round(geoMiles * 3)) : 0)
        + (location.zip ? 10 : 0)
        + (location.address ? 5 : 0);

      return {
        lead,
        countyMatch,
        cityMatch,
        geoMatch,
        geoMiles,
        include,
        overlayScore
      };
    })
    .filter((item) => item.include)
    .sort((a, b) => b.overlayScore - a.overlayScore || (a.geoMiles ?? Number.POSITIVE_INFINITY) - (b.geoMiles ?? Number.POSITIVE_INFINITY) || String(a.lead.contact_name || '').localeCompare(String(b.lead.contact_name || '')));
}

function renderStormLeadOverlayStatus() {
  const el = $('stormMapLeadStatus');
  if (!el) return;
  const checked = Number(stormLeadOverlayState.checkedTotal || crmLeadOverlayScanCount || totalLeadCount) || 0;
  const total = Number(stormLeadOverlayState.totalCandidates) || 0;
  if (!checked && !total) {
    el.textContent = 'No CRM leads loaded for overlay scan yet';
    return;
  }
  const checkedLabel = totalLeadCount
    ? `${checked}/${totalLeadCount} CRM leads checked`
    : `${checked} CRM leads checked`;
  const parts = [checkedLabel, `${total} location-ready`];
  if (selectedStormCounty) {
    parts.push(`${stormLeadOverlayState.visible || 0} matching ${selectedStormCounty}`);
    if (selectedStormCity) parts.push(`${selectedStormCity} prioritized`);
  }
  parts.push('county → city → geo overlay mode');
  el.textContent = parts.join(' · ');
}

function scheduleLeadOverlayGeocode(force = false) {
  stormLeadOverlayState.loading = false;
  stormLeadOverlayState.queued = false;
  if (stormLeadOverlayTimer) {
    window.clearTimeout(stormLeadOverlayTimer);
    stormLeadOverlayTimer = null;
  }
  return;
}

async function geocodeLeadOverlays(force = false) {
  if (stormLeadOverlayState.loading) return;
  const candidates = getLeadOverlayCandidates();

  let seededUpdates = 0;
  candidates.forEach((lead) => {
    const cacheKey = getLeadGeoCacheKey(lead);
    const cached = stormLeadGeoCache[cacheKey] || null;
    if (cached && Number.isFinite(Number(cached.lat)) && Number.isFinite(Number(cached.lon))) return;
    const seed = getLeadGeocodeSeedFromStormData(lead);
    if (!seed) return;
    stormLeadGeoCache[cacheKey] = {
      lat: Number(seed.lat),
      lon: Number(seed.lon),
      label: seed.label || getLeadLocationQuery(lead),
      county: normalizeStormCounty(seed.county || ''),
      updatedAt: new Date().toISOString(),
      inferred: true
    };
    seededUpdates += 1;
  });
  if (seededUpdates) saveStormLeadGeoCache();

  stormLeadOverlayState.totalCandidates = candidates.length;
  stormLeadOverlayState.geocoded = countGeocodedLeadCandidates(candidates);
  renderStormLeadOverlayStatus();

  if (!candidates.length) {
    if (isStormMapActive()) refreshActiveStormSelectionPanels();
    return;
  }

  const unresolved = candidates.filter((lead) => {
    const cached = stormLeadGeoCache[getLeadGeoCacheKey(lead)] || null;
    if (!cached) return true;
    if (Number.isFinite(Number(cached.lat)) && Number.isFinite(Number(cached.lon))) return false;
    if (!force && cached.failedAt && (Date.now() - new Date(cached.failedAt).getTime()) < 24 * 60 * 60 * 1000) return false;
    return true;
  });

  if (!unresolved.length) {
    stormLeadOverlayState.geocoded = countGeocodedLeadCandidates(candidates);
    stormLeadOverlayState.lastRun = new Date().toISOString();
    renderStormLeadOverlayStatus();
    if (isStormMapActive()) refreshActiveStormSelectionPanels();
    return;
  }

  stormLeadOverlayState.loading = true;
  renderStormLeadOverlayStatus();

  const batchSize = force ? 18 : 10;
  for (const lead of unresolved.slice(0, batchSize)) {
    const cacheKey = getLeadGeoCacheKey(lead);
    const city = String(lead.city || '').trim();
    const state = normalizeStormState(lead.state);
    const zip = String(lead.zip || '').trim();
    const address = String(lead.address || '').trim();
    const query = city
      ? [address && !zip ? address : '', city, state, zip].filter(Boolean).join(', ')
      : getLeadLocationQuery(lead);
    if (!query) continue;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&addressdetails=1&q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('Lead geocode request failed');
      const data = await res.json();
      const match = Array.isArray(data) ? data[0] : null;
      if (match) {
        stormLeadGeoCache[cacheKey] = {
          lat: Number(match.lat),
          lon: Number(match.lon),
          label: match.display_name || query,
          county: normalizeStormCounty(match.address?.county || ''),
          updatedAt: new Date().toISOString(),
          inferred: false
        };
      } else {
        stormLeadGeoCache[cacheKey] = {
          failedAt: new Date().toISOString(),
          label: query
        };
      }
      saveStormLeadGeoCache();
    } catch (error) {
      stormLeadGeoCache[cacheKey] = {
        failedAt: new Date().toISOString(),
        label: query
      };
      saveStormLeadGeoCache();
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }

  stormLeadOverlayState.loading = false;
  stormLeadOverlayState.geocoded = countGeocodedLeadCandidates(candidates);
  stormLeadOverlayState.lastRun = new Date().toISOString();
  renderStormLeadOverlayStatus();
  if (($('organizeBy')?.value || 'default') === 'county' && allLeads.length) renderLeadsTable(allLeads, 'county');
  if (isStormMapActive()) refreshActiveStormSelectionPanels();

  const remaining = candidates.some((lead) => {
    const cached = stormLeadGeoCache[getLeadGeoCacheKey(lead)] || null;
    return !cached || (!Number.isFinite(Number(cached.lat)) && !cached.failedAt);
  });
  if (remaining) {
    window.setTimeout(() => geocodeLeadOverlays(false), isStormMapActive() ? 450 : 900);
  }
}

function isStormMapActive() {
  return document.querySelector('.nav-item.active')?.dataset.view === 'storm-map';
}

function getStormReportsWithCoords() {
  return (Array.isArray(stormIntel.severeReports) ? stormIntel.severeReports : [])
    .filter(report => Number.isFinite(Number(report.lat)) && Number.isFinite(Number(report.lon)))
    .map(report => ({
      ...report,
      lat: Number(report.lat),
      lon: Number(report.lon)
    }));
}

function buildStormCountyZones() {
  const countyLookup = new Map();
  const reports = Array.isArray(stormIntel.severeReports) ? stormIntel.severeReports : [];

  reports.forEach((report) => {
    const key = normalizeStormCounty(report.county || '') || 'Unknown County';
    if (!countyLookup.has(key)) {
      countyLookup.set(key, {
        county: key,
        latTotal: 0,
        lonTotal: 0,
        points: 0,
        total: 0,
        hail: 0,
        wind: 0,
        latestDate: report.beginDate,
        maxHail: 0,
        maxWind: 0,
        reports: [],
        clusters: new Map()
      });
    }
    const zone = countyLookup.get(key);
    zone.total += 1;
    if (report.kind === 'hail') zone.hail += 1;
    if (report.kind === 'wind') zone.wind += 1;
    if ((report.magnitude || 0) > zone.maxHail && report.kind === 'hail') zone.maxHail = Number(report.magnitude || 0);
    if ((report.magnitudeMph || 0) > zone.maxWind && report.kind === 'wind') zone.maxWind = Number(report.magnitudeMph || 0);
    if (new Date(report.beginDate || 0).getTime() > new Date(zone.latestDate || 0).getTime()) zone.latestDate = report.beginDate;
    zone.reports.push(report);

    if (!Number.isFinite(Number(report.lat)) || !Number.isFinite(Number(report.lon))) return;

    zone.latTotal += Number(report.lat);
    zone.lonTotal += Number(report.lon);
    zone.points += 1;

    const clusterKey = `${Math.round(Number(report.lat) * 7)}:${Math.round(Number(report.lon) * 7)}`;
    if (!zone.clusters.has(clusterKey)) {
      zone.clusters.set(clusterKey, {
        latTotal: 0,
        lonTotal: 0,
        points: 0,
        wind: 0,
        hail: 0,
        reports: []
      });
    }
    const cluster = zone.clusters.get(clusterKey);
    cluster.latTotal += Number(report.lat);
    cluster.lonTotal += Number(report.lon);
    cluster.points += 1;
    if (report.kind === 'hail') cluster.hail += 1;
    if (report.kind === 'wind') cluster.wind += 1;
    cluster.reports.push(report);
  });

  return [...countyLookup.values()].map((zone) => {
    const clusters = [...zone.clusters.values()].map((cluster) => ({
      ...cluster,
      lat: cluster.points ? cluster.latTotal / cluster.points : null,
      lon: cluster.points ? cluster.lonTotal / cluster.points : null,
      score: (cluster.wind * 2) + cluster.hail + (cluster.points * 1.5)
    })).filter((cluster) => Number.isFinite(cluster.lat) && Number.isFinite(cluster.lon));

    const bestCluster = clusters.sort((a, b) => b.score - a.score || b.points - a.points)[0] || null;
    const centerLat = bestCluster?.lat ?? (zone.points ? zone.latTotal / zone.points : null);
    const centerLon = bestCluster?.lon ?? (zone.points ? zone.lonTotal / zone.points : null);
    const anchorReport = bestCluster?.reports?.reduce((best, report) => {
      const score = Math.abs(Number(report.lat) - centerLat) + Math.abs(Number(report.lon) - centerLon);
      if (!best || score < best.score) return { report, score };
      return best;
    }, null)?.report || zone.reports.find((report) => Number.isFinite(Number(report.lat)) && Number.isFinite(Number(report.lon))) || zone.reports[0] || null;

    return {
      ...zone,
      lat: Number.isFinite(Number(anchorReport?.lat ?? centerLat)) ? Number(anchorReport?.lat ?? centerLat) : null,
      lon: Number.isFinite(Number(anchorReport?.lon ?? centerLon)) ? Number(anchorReport?.lon ?? centerLon) : null,
      score: (zone.wind * 2) + zone.hail,
      hotspotReports: bestCluster?.points || zone.points || 0,
      reports: zone.reports.sort((a, b) => new Date(b.beginDate || 0) - new Date(a.beginDate || 0))
    };
  }).sort((a, b) => b.score - a.score || b.total - a.total || a.county.localeCompare(b.county));
}

function getZoneRadius(zone) {
  return Math.min(42000, 12000 + (zone.total * 1600));
}

function getZoneColor(zone) {
  if ((zone.wind || 0) > (zone.hail || 0)) return '#f97316';
  if ((zone.hail || 0) > 0) return '#38bdf8';
  return '#a855f7';
}

function ensureStormMap() {
  const mapEl = $('stormCoverageMap');
  if (!mapEl) return null;
  if (!stormMap) stormMap = { el: mapEl, mode: 'static-florida' };
  return stormMap;
}

const FLORIDA_MAP_BOUNDS = {
  north: 31.000888,
  south: 24.544701,
  west: -87.634938,
  east: -80.031362
};

const FLORIDA_STATIC_VIEWBOX = {
  width: 1000,
  height: 760,
  scale: 104.086204,
  offsetX: 104.286317,
  offsetY: 44.000000
};

const FLORIDA_STATIC_SVG_PATH = `M 872.9 633.0 L 872.4 633.6 L 871.9 634.8 L 871.1 635.2 L 869.0 639.2 L 867.0 641.8 L 862.4 648.8 L 862.1 649.4 L 862.6 651.0 L 861.7 652.6 L 859.7 655.0 L 857.4 657.3 L 854.4 658.7 L 854.1 659.3 L 852.8 660.7 L 850.9 661.3 L 849.7 662.3 L 847.6 664.6 L 848.1 665.4 L 847.5 666.2 L 843.0 669.6 L 840.1 673.0 L 839.5 673.4 L 837.7 673.7 L 836.9 674.0 L 835.3 675.0 L 832.8 677.7 L 830.3 679.3 L 830.1 679.0 L 830.3 678.5 L 831.2 678.2 L 832.2 677.5 L 834.0 675.8 L 834.1 675.3 L 834.0 675.0 L 834.3 674.4 L 836.8 672.9 L 838.5 672.3 L 838.8 672.5 L 839.6 672.5 L 840.8 671.6 L 842.3 668.6 L 842.4 667.8 L 842.1 667.1 L 844.4 666.8 L 846.0 665.7 L 846.8 664.3 L 847.4 663.7 L 848.1 663.4 L 848.9 662.7 L 851.0 660.4 L 850.5 659.6 L 850.0 659.3 L 848.8 659.0 L 847.5 658.0 L 848.6 657.2 L 849.3 657.4 L 849.4 658.3 L 850.7 658.9 L 852.1 659.4 L 852.7 658.9 L 853.8 657.5 L 853.9 656.7 L 852.4 653.2 L 852.5 652.9 L 856.0 654.3 L 857.0 653.9 L 857.8 652.9 L 858.7 650.8 L 858.6 649.6 L 858.2 648.6 L 858.7 648.0 L 860.5 647.1 L 861.6 647.1 L 862.6 646.7 L 863.9 644.5 L 864.2 642.2 L 864.0 641.4 L 863.3 640.7 L 860.7 639.2 L 861.1 638.8 L 863.6 638.4 L 864.1 638.8 L 864.8 638.8 L 866.1 638.0 L 868.5 635.9 L 868.8 634.8 L 870.3 632.8 L 871.4 631.7 L 872.2 631.0 L 872.5 629.0 L 872.8 627.9 L 873.3 627.1 L 875.4 626.3 L 876.2 625.8 L 876.7 625.2 L 877.5 623.4 L 878.2 620.9 L 879.0 619.3 L 879.2 618.0 L 879.0 617.1 L 879.3 615.8 L 880.3 614.6 L 880.8 614.7 L 880.9 618.4 L 879.8 619.8 L 877.7 625.7 L 875.9 627.2 L 874.2 630.9 L 874.0 632.5 L 873.0 632.9 L 872.9 633.0 Z M 734.2 704.1 L 734.5 703.0 L 736.3 700.6 L 736.9 700.6 L 738.5 701.8 L 739.2 702.0 L 740.9 701.1 L 741.1 699.8 L 741.6 699.4 L 743.8 698.8 L 745.3 698.7 L 745.5 699.2 L 746.0 699.4 L 747.1 699.1 L 747.6 698.7 L 747.9 698.3 L 747.8 696.1 L 747.4 695.7 L 747.9 694.9 L 749.0 696.2 L 749.2 697.0 L 749.5 697.3 L 749.9 697.5 L 750.9 696.5 L 751.0 695.9 L 750.4 695.1 L 750.1 694.9 L 750.0 694.4 L 750.6 694.3 L 753.0 694.7 L 754.0 695.3 L 754.3 695.8 L 754.4 696.6 L 754.8 697.1 L 757.4 698.9 L 758.9 699.0 L 761.7 699.7 L 762.1 700.7 L 762.2 701.8 L 762.7 703.5 L 763.9 704.3 L 763.8 704.6 L 763.3 704.9 L 760.2 706.1 L 753.8 708.1 L 753.1 707.8 L 752.9 706.1 L 751.8 705.3 L 749.9 705.5 L 748.2 706.1 L 745.9 705.9 L 744.8 705.5 L 744.7 705.3 L 745.1 705.1 L 745.3 704.7 L 744.9 704.0 L 743.0 703.5 L 742.5 703.9 L 742.3 704.6 L 741.9 705.6 L 741.9 707.0 L 741.7 707.6 L 740.9 708.1 L 738.0 708.7 L 732.1 711.7 L 725.8 713.0 L 724.7 714.0 L 723.6 714.5 L 722.9 714.4 L 718.6 714.8 L 715.2 715.2 L 713.1 715.8 L 710.5 716.0 L 710.3 715.8 L 710.1 714.0 L 710.4 713.4 L 711.6 713.3 L 712.2 711.7 L 714.3 711.8 L 717.0 711.3 L 717.9 711.3 L 718.4 711.9 L 718.9 712.1 L 720.4 711.5 L 720.4 711.0 L 721.5 710.5 L 722.1 710.5 L 722.6 711.1 L 723.4 711.0 L 724.3 710.5 L 725.3 709.4 L 726.6 708.5 L 728.6 708.0 L 730.9 705.8 L 730.9 705.0 L 732.7 704.5 L 733.7 704.4 L 734.2 704.1 Z M 675.1 712.7 L 675.9 710.9 L 676.7 710.6 L 677.8 710.5 L 680.0 711.5 L 680.3 711.8 L 680.5 713.1 L 679.9 714.3 L 678.6 715.5 L 674.2 715.6 L 673.6 715.2 L 673.7 714.1 L 675.1 712.7 Z M 768.9 702.6 L 769.3 702.4 L 769.6 702.5 L 769.4 703.0 L 765.6 704.6 L 765.9 704.0 L 767.8 702.5 L 768.9 702.6 Z M 804.3 691.4 L 804.6 692.6 L 804.0 693.1 L 801.3 692.8 L 793.2 697.8 L 792.4 698.1 L 791.9 697.7 L 791.5 697.0 L 791.3 697.0 L 788.2 698.2 L 787.5 698.6 L 787.0 699.4 L 786.7 700.2 L 786.7 700.6 L 783.6 701.0 L 782.0 699.3 L 781.8 699.0 L 783.7 698.5 L 783.9 698.7 L 784.6 698.6 L 787.9 697.3 L 789.6 695.9 L 790.5 695.4 L 791.1 695.4 L 791.2 695.7 L 792.6 696.4 L 793.1 696.2 L 795.5 695.3 L 796.3 694.3 L 799.0 693.2 L 804.2 691.3 L 804.3 691.4 Z M 761.8 693.9 L 763.1 693.9 L 764.6 696.0 L 764.9 697.7 L 763.4 698.4 L 762.5 697.0 L 761.7 696.8 L 760.9 696.9 L 758.4 695.0 L 757.7 693.9 L 759.2 694.0 L 760.8 693.3 L 761.1 692.8 L 761.8 693.9 Z M 806.3 690.3 L 806.9 690.3 L 807.0 690.4 L 806.1 690.9 L 804.6 691.1 L 806.3 690.3 Z M 816.9 686.9 L 816.7 687.6 L 816.1 688.2 L 813.4 688.1 L 810.9 689.1 L 810.5 689.2 L 810.4 689.0 L 810.9 688.6 L 812.6 687.9 L 814.2 686.5 L 816.5 684.9 L 817.7 685.2 L 816.9 686.9 Z M 823.1 682.6 L 824.0 682.7 L 825.8 681.0 L 827.0 680.5 L 827.1 680.9 L 825.8 682.2 L 824.9 682.8 L 819.7 685.7 L 819.1 685.7 L 821.4 684.2 L 821.9 683.5 L 822.8 682.7 L 823.1 682.6 Z M 664.2 491.3 L 664.2 490.8 L 665.1 491.0 L 665.6 492.3 L 665.2 492.8 L 665.1 493.4 L 666.1 495.6 L 668.1 499.3 L 668.5 501.8 L 670.4 506.3 L 671.3 509.6 L 672.3 512.2 L 673.5 513.6 L 675.3 514.8 L 677.1 514.9 L 678.3 515.2 L 681.6 517.1 L 682.8 516.0 L 684.3 515.6 L 686.8 517.0 L 689.2 517.2 L 689.4 517.2 L 689.4 517.5 L 684.2 520.2 L 683.0 520.6 L 682.2 520.6 L 680.6 520.3 L 677.6 519.1 L 675.3 517.1 L 672.8 515.8 L 672.4 515.4 L 672.0 515.0 L 671.4 513.6 L 669.8 506.6 L 669.4 505.6 L 667.7 503.1 L 665.9 498.3 L 664.9 496.4 L 663.4 494.4 L 662.9 493.5 L 663.3 491.8 L 664.2 491.3 Z M 401.7 178.6 L 406.7 175.4 L 408.0 174.3 L 410.1 172.1 L 410.4 172.7 L 410.3 173.0 L 408.3 175.1 L 403.0 179.4 L 401.8 180.2 L 399.5 181.3 L 393.8 183.1 L 390.6 184.4 L 382.9 188.5 L 374.8 191.0 L 373.2 191.2 L 372.9 190.6 L 371.3 189.3 L 368.6 187.5 L 368.4 187.2 L 368.7 186.9 L 371.6 188.8 L 374.5 189.9 L 376.1 190.1 L 376.8 189.4 L 379.8 188.7 L 381.8 188.0 L 385.6 185.9 L 386.3 185.1 L 386.8 184.8 L 389.4 183.8 L 392.9 182.3 L 398.0 180.8 L 399.6 179.5 L 401.7 178.6 Z M 362.3 181.5 L 364.2 181.0 L 364.5 180.8 L 366.7 180.6 L 368.8 181.0 L 369.8 181.6 L 370.5 182.4 L 369.0 184.8 L 368.4 186.4 L 365.5 186.9 L 363.7 186.1 L 361.6 184.6 L 359.3 183.2 L 357.3 182.2 L 355.4 181.7 L 355.6 181.5 L 356.8 181.3 L 359.3 181.2 L 361.0 181.2 L 362.3 181.5 Z M 605.3 360.1 L 604.4 359.6 L 604.6 354.3 L 605.1 353.2 L 605.1 351.7 L 604.8 350.8 L 604.2 349.8 L 603.8 348.7 L 604.1 347.8 L 604.4 347.5 L 604.8 347.6 L 605.1 349.2 L 605.6 350.4 L 606.1 352.5 L 606.0 355.0 L 605.3 355.5 L 605.3 356.1 L 605.7 357.2 L 606.0 359.1 L 605.3 360.1 Z M 554.5 82.1 L 554.5 82.1 L 554.5 82.1 L 560.1 82.5 L 567.2 82.9 L 568.6 83.0 L 569.7 83.0 L 570.5 83.1 L 572.5 83.2 L 599.3 84.8 L 599.5 84.8 L 618.1 85.9 L 618.1 85.9 L 619.0 86.0 L 619.1 86.0 L 630.0 86.6 L 631.6 86.7 L 631.9 86.7 L 633.2 86.8 L 634.1 86.8 L 635.0 86.9 L 636.2 87.0 L 642.9 87.4 L 643.0 87.4 L 647.2 87.6 L 651.8 87.9 L 660.9 88.5 L 663.9 88.7 L 664.8 88.8 L 668.4 89.2 L 668.5 89.2 L 668.7 96.2 L 669.4 100.8 L 668.9 104.0 L 669.6 106.4 L 671.1 109.0 L 673.0 110.7 L 673.6 110.9 L 677.8 110.0 L 685.6 110.5 L 685.6 110.4 L 689.1 96.4 L 689.0 94.1 L 690.2 89.5 L 689.4 86.2 L 686.9 82.3 L 685.7 80.0 L 685.6 77.8 L 688.4 66.8 L 690.8 66.1 L 700.6 62.6 L 704.5 65.7 L 707.4 66.3 L 708.8 66.1 L 710.9 66.0 L 715.9 67.9 L 717.7 68.8 L 718.6 70.1 L 720.0 70.7 L 728.6 71.8 L 729.9 71.6 L 731.8 73.4 L 738.2 74.0 L 748.7 74.3 L 749.9 75.0 L 750.4 75.5 L 750.0 78.5 L 748.8 85.6 L 748.8 90.4 L 749.7 93.8 L 748.8 95.1 L 748.4 95.8 L 749.1 96.4 L 750.6 96.5 L 752.1 98.0 L 752.5 104.3 L 753.5 106.5 L 753.6 112.8 L 754.1 116.6 L 754.8 119.7 L 755.4 121.9 L 757.9 131.3 L 762.7 151.4 L 764.2 155.6 L 764.8 157.0 L 766.1 158.5 L 766.7 160.3 L 767.3 162.9 L 767.5 166.8 L 768.2 170.6 L 769.8 175.3 L 771.1 177.9 L 772.7 182.5 L 772.9 182.8 L 777.9 194.5 L 782.0 202.9 L 784.3 207.8 L 790.0 220.2 L 795.4 230.8 L 798.4 236.9 L 800.7 240.7 L 804.5 245.6 L 806.0 248.5 L 807.6 251.2 L 817.1 265.2 L 822.8 274.0 L 824.7 277.0 L 824.8 277.0 L 824.8 277.1 L 825.1 277.6 L 825.2 277.7 L 829.0 282.5 L 829.9 283.7 L 831.5 285.7 L 831.6 285.7 L 831.6 285.8 L 831.8 286.0 L 832.2 286.7 L 832.5 287.0 L 833.3 288.2 L 834.8 290.3 L 838.2 294.1 L 839.1 295.4 L 839.9 297.8 L 840.6 301.1 L 843.2 306.5 L 844.3 308.5 L 844.2 309.3 L 840.4 310.8 L 839.2 311.8 L 837.8 313.6 L 836.9 315.7 L 836.2 318.5 L 835.8 321.3 L 835.7 324.0 L 836.1 329.5 L 837.6 337.8 L 840.0 346.4 L 842.0 351.3 L 846.0 359.4 L 852.5 370.7 L 852.4 370.8 L 852.4 371.0 L 859.0 383.4 L 862.4 393.5 L 862.5 395.0 L 863.1 396.3 L 864.5 398.2 L 865.2 401.2 L 865.5 402.4 L 866.5 405.8 L 867.6 408.4 L 868.5 408.4 L 871.3 416.7 L 872.6 420.9 L 874.7 424.9 L 875.4 426.8 L 878.2 433.1 L 878.9 434.5 L 882.2 440.4 L 883.0 442.8 L 882.4 443.4 L 883.4 445.5 L 884.6 448.8 L 886.8 452.9 L 889.2 458.5 L 890.7 463.5 L 892.0 468.0 L 894.2 475.1 L 895.7 481.6 L 895.6 484.2 L 895.2 484.2 L 895.1 484.8 L 895.6 490.1 L 895.6 491.6 L 895.3 494.2 L 895.3 500.8 L 894.9 505.3 L 893.7 511.5 L 892.7 518.2 L 891.6 529.5 L 891.5 529.6 L 891.2 531.1 L 891.1 531.4 L 890.7 537.0 L 890.1 538.6 L 889.7 540.4 L 888.4 549.1 L 888.0 554.5 L 887.9 554.8 L 887.6 555.3 L 887.6 555.5 L 887.3 559.0 L 886.7 565.9 L 886.7 567.1 L 886.7 573.3 L 886.4 576.7 L 886.5 581.1 L 886.3 583.5 L 885.7 586.3 L 885.7 588.2 L 884.7 590.5 L 884.0 591.5 L 883.1 595.5 L 882.9 597.5 L 883.1 598.2 L 882.8 599.3 L 882.2 599.4 L 880.6 597.3 L 881.2 594.6 L 881.9 593.5 L 881.7 592.7 L 881.0 591.8 L 879.8 591.0 L 878.4 591.1 L 875.1 592.4 L 874.0 593.2 L 873.5 594.0 L 872.9 597.0 L 871.3 600.1 L 871.2 600.8 L 870.1 602.3 L 869.0 603.0 L 868.1 603.8 L 867.6 604.8 L 867.2 606.9 L 867.2 608.7 L 867.5 609.5 L 866.3 612.5 L 865.2 612.9 L 864.8 613.2 L 863.6 616.6 L 863.6 618.8 L 863.9 620.1 L 864.8 622.5 L 865.6 623.1 L 865.0 624.6 L 865.1 627.2 L 865.6 627.9 L 866.7 628.0 L 867.0 628.6 L 866.7 629.8 L 864.1 633.4 L 862.3 634.3 L 861.3 634.5 L 860.0 635.6 L 859.1 637.2 L 858.8 638.6 L 855.3 641.2 L 853.4 642.3 L 852.4 642.8 L 850.8 644.0 L 850.3 644.4 L 850.2 644.5 L 850.1 644.6 L 848.7 646.1 L 848.2 647.0 L 848.2 647.1 L 848.2 647.1 L 847.4 647.8 L 847.3 647.8 L 847.1 647.8 L 847.1 647.8 L 846.6 647.5 L 846.6 647.5 L 846.1 647.1 L 846.1 647.1 L 846.1 647.1 L 845.6 646.1 L 845.4 645.9 L 845.3 645.9 L 844.8 645.6 L 844.5 645.7 L 844.3 645.9 L 843.8 646.1 L 842.7 645.9 L 842.6 645.5 L 842.7 645.2 L 842.7 644.7 L 841.9 644.0 L 840.9 643.7 L 839.6 643.7 L 837.7 645.3 L 837.8 647.0 L 838.1 647.7 L 838.1 647.7 L 837.1 648.5 L 836.4 649.0 L 835.5 649.7 L 835.5 649.7 L 834.5 650.2 L 834.5 650.2 L 833.0 650.2 L 832.4 650.2 L 832.3 650.2 L 832.3 650.3 L 832.1 650.3 L 831.8 650.5 L 831.8 650.5 L 831.7 650.5 L 831.5 650.9 L 831.4 651.0 L 830.6 651.1 L 830.2 651.1 L 829.2 651.2 L 828.8 651.2 L 828.2 651.3 L 827.8 651.3 L 827.3 651.5 L 826.6 652.2 L 826.0 653.3 L 825.7 654.1 L 824.5 653.9 L 823.8 653.5 L 823.1 653.6 L 822.5 653.7 L 822.1 653.7 L 821.7 653.8 L 821.3 653.1 L 821.3 652.4 L 820.7 651.6 L 820.1 651.3 L 816.2 650.7 L 816.1 650.7 L 814.1 651.4 L 813.9 651.5 L 813.3 651.8 L 813.0 651.9 L 812.9 651.9 L 812.9 651.9 L 812.9 651.8 L 812.8 651.7 L 812.7 651.5 L 812.6 651.1 L 811.7 650.4 L 811.2 650.3 L 810.9 650.2 L 810.9 650.2 L 809.7 650.2 L 809.6 650.2 L 808.0 650.4 L 807.9 650.5 L 807.9 650.5 L 807.8 650.5 L 807.5 650.6 L 807.5 650.7 L 806.2 651.3 L 805.4 651.7 L 805.3 651.7 L 805.3 651.8 L 805.2 652.3 L 805.1 652.6 L 805.1 652.6 L 805.3 652.9 L 805.4 653.2 L 805.2 654.1 L 805.2 654.1 L 805.2 654.1 L 805.1 654.1 L 804.6 654.0 L 803.6 653.9 L 803.6 653.9 L 802.0 654.3 L 801.5 654.4 L 801.2 654.5 L 801.0 654.6 L 800.8 654.6 L 800.8 654.6 L 799.6 654.5 L 799.5 654.5 L 799.5 654.5 L 799.3 654.5 L 799.2 654.5 L 798.3 654.6 L 798.3 654.6 L 798.2 654.6 L 798.2 654.6 L 798.0 654.6 L 797.9 654.7 L 797.9 654.7 L 797.8 654.7 L 797.8 654.7 L 797.8 654.7 L 797.7 654.7 L 797.3 654.9 L 795.7 655.4 L 795.5 655.5 L 795.0 655.7 L 794.9 655.7 L 793.9 655.6 L 792.5 655.1 L 792.3 655.2 L 791.4 655.2 L 790.9 655.2 L 789.8 655.3 L 789.8 655.3 L 789.7 655.3 L 789.7 655.3 L 789.6 655.3 L 786.6 656.2 L 785.1 655.4 L 783.2 653.5 L 782.3 652.8 L 781.0 652.3 L 780.2 651.6 L 780.1 649.6 L 780.1 649.5 L 780.0 649.4 L 779.6 648.5 L 778.7 647.0 L 778.7 646.9 L 778.7 646.9 L 777.4 645.8 L 777.1 645.5 L 777.0 645.5 L 777.0 645.3 L 777.0 644.2 L 777.1 644.0 L 777.1 643.1 L 777.1 643.0 L 777.2 642.7 L 777.2 642.6 L 777.3 642.5 L 777.4 642.3 L 778.0 638.4 L 778.3 637.5 L 779.0 636.8 L 779.4 635.5 L 779.1 634.8 L 779.5 634.0 L 780.3 633.1 L 781.0 632.9 L 782.3 633.4 L 782.6 632.7 L 782.7 631.7 L 781.5 629.0 L 780.2 628.9 L 779.2 628.3 L 779.2 627.1 L 779.6 626.5 L 779.6 626.2 L 777.3 620.3 L 776.2 619.1 L 774.9 618.2 L 773.2 616.1 L 773.0 614.8 L 773.7 613.0 L 773.6 612.5 L 773.1 611.5 L 771.4 610.5 L 770.7 608.9 L 770.6 607.6 L 769.9 606.3 L 769.8 604.7 L 768.5 602.2 L 766.9 600.2 L 766.0 599.4 L 764.7 597.0 L 760.7 594.0 L 760.0 594.1 L 758.9 593.5 L 758.9 591.9 L 759.1 590.8 L 758.8 590.1 L 757.9 589.5 L 757.5 588.8 L 757.2 588.2 L 759.0 587.2 L 759.5 586.7 L 759.3 585.9 L 759.0 585.0 L 758.5 583.6 L 758.2 583.0 L 757.2 582.8 L 754.7 581.2 L 753.8 579.9 L 751.4 578.6 L 750.7 578.3 L 750.2 578.5 L 748.9 578.7 L 747.2 578.2 L 745.8 576.8 L 745.6 576.1 L 744.1 576.1 L 742.7 576.6 L 741.9 576.6 L 741.5 576.3 L 741.6 575.3 L 741.2 574.9 L 740.0 574.8 L 738.6 574.9 L 734.8 576.1 L 734.1 576.1 L 730.9 575.6 L 730.0 575.2 L 728.3 575.2 L 727.8 575.1 L 726.8 575.6 L 725.8 576.4 L 724.9 579.4 L 724.3 580.6 L 723.6 580.4 L 723.1 579.9 L 720.7 575.2 L 720.2 574.7 L 719.2 574.2 L 718.7 571.7 L 718.1 570.6 L 717.3 569.8 L 716.9 568.6 L 717.1 565.1 L 716.8 564.7 L 716.1 564.5 L 715.5 563.9 L 711.4 555.3 L 710.7 548.7 L 710.1 546.5 L 709.9 543.0 L 709.5 539.9 L 708.2 533.9 L 707.0 530.4 L 706.9 530.1 L 704.4 525.1 L 701.0 521.8 L 700.9 521.2 L 700.0 520.1 L 698.8 519.1 L 697.2 518.2 L 695.3 517.4 L 694.5 516.9 L 694.2 516.3 L 694.3 516.1 L 694.0 514.9 L 692.8 514.5 L 691.1 514.1 L 689.9 514.1 L 689.4 513.4 L 689.9 511.9 L 688.2 511.2 L 686.3 510.4 L 683.8 511.1 L 683.3 513.3 L 680.9 514.2 L 679.8 514.2 L 679.1 508.2 L 678.4 506.1 L 678.1 504.2 L 676.5 498.2 L 675.2 496.4 L 671.9 493.6 L 672.1 492.0 L 672.7 491.5 L 675.0 491.2 L 676.3 491.4 L 677.7 491.7 L 678.4 492.6 L 679.7 495.1 L 680.4 495.5 L 681.1 495.2 L 681.8 493.2 L 682.0 491.4 L 682.5 489.9 L 683.9 487.2 L 684.3 484.3 L 684.4 483.9 L 684.4 482.4 L 685.1 481.0 L 684.8 479.0 L 684.7 477.2 L 684.9 475.1 L 684.7 473.3 L 683.9 472.7 L 681.4 472.0 L 681.1 470.2 L 681.4 468.4 L 682.1 468.0 L 683.8 468.0 L 684.4 467.6 L 684.4 466.8 L 684.2 465.6 L 682.9 464.8 L 679.6 464.8 L 679.0 465.0 L 678.6 465.2 L 677.8 466.1 L 676.5 468.1 L 673.9 468.2 L 673.2 468.4 L 672.6 469.1 L 672.8 471.1 L 674.5 475.9 L 675.5 482.3 L 675.1 483.0 L 672.8 483.5 L 672.2 484.1 L 669.0 484.2 L 667.7 484.2 L 666.6 483.0 L 666.5 482.9 L 666.4 483.0 L 665.6 483.9 L 664.7 485.8 L 663.8 489.9 L 663.3 489.0 L 663.3 485.7 L 662.8 482.8 L 662.5 482.3 L 661.5 480.1 L 660.7 478.4 L 659.4 476.9 L 654.2 470.0 L 651.7 466.1 L 649.1 462.0 L 647.2 458.3 L 644.4 454.1 L 642.9 450.0 L 642.4 448.9 L 642.0 448.6 L 641.2 445.7 L 637.5 438.8 L 634.6 434.0 L 634.1 433.3 L 632.6 432.5 L 631.5 431.4 L 631.6 429.4 L 630.8 428.2 L 628.6 425.5 L 625.9 422.7 L 623.9 419.9 L 623.9 419.9 L 620.5 416.3 L 618.8 414.9 L 618.9 414.2 L 617.1 409.7 L 616.4 408.4 L 615.4 407.0 L 613.5 405.2 L 613.2 404.4 L 613.5 404.3 L 617.1 405.9 L 616.8 408.2 L 617.2 408.6 L 618.9 408.8 L 619.4 408.7 L 619.3 407.6 L 619.7 407.0 L 620.6 406.4 L 621.9 406.0 L 623.1 406.0 L 623.6 404.9 L 625.0 403.0 L 627.1 401.0 L 627.0 399.8 L 627.0 399.7 L 627.1 399.5 L 628.7 398.6 L 630.0 398.4 L 631.4 397.1 L 631.9 396.4 L 632.7 394.0 L 633.1 393.3 L 634.9 390.4 L 637.3 387.0 L 639.3 385.6 L 640.6 385.5 L 641.1 385.2 L 641.2 384.5 L 641.1 383.9 L 640.6 383.1 L 641.0 382.8 L 643.2 382.1 L 645.6 380.9 L 645.8 380.5 L 645.6 379.9 L 647.2 377.8 L 647.3 376.8 L 648.0 376.0 L 648.9 375.8 L 649.9 373.3 L 649.4 371.8 L 648.9 368.6 L 647.7 366.6 L 645.8 366.6 L 643.8 366.0 L 642.9 365.6 L 643.0 365.0 L 642.7 364.7 L 641.0 363.9 L 639.8 364.7 L 639.7 365.3 L 640.1 367.3 L 640.0 370.6 L 640.8 371.6 L 641.7 372.2 L 642.0 372.7 L 641.6 374.8 L 641.3 375.0 L 639.8 374.8 L 637.6 374.3 L 633.1 372.1 L 633.3 370.6 L 634.7 370.4 L 635.3 369.8 L 635.6 369.1 L 634.7 368.3 L 634.3 367.7 L 634.4 367.4 L 635.0 367.0 L 635.5 366.4 L 635.3 363.3 L 634.5 361.7 L 633.2 359.8 L 629.5 359.4 L 626.3 359.5 L 623.3 359.9 L 616.2 360.7 L 615.8 361.0 L 615.4 361.8 L 615.7 362.4 L 615.7 362.6 L 615.8 362.9 L 615.9 363.0 L 616.9 363.8 L 618.8 364.2 L 619.5 365.1 L 620.9 365.4 L 625.4 365.7 L 624.8 366.4 L 625.0 367.7 L 627.3 369.5 L 631.7 368.5 L 631.7 368.7 L 631.8 371.1 L 628.5 371.2 L 628.9 372.7 L 629.5 373.5 L 629.8 375.4 L 627.6 377.3 L 626.0 379.3 L 625.2 382.0 L 625.7 384.2 L 625.7 384.8 L 624.9 386.5 L 624.2 387.2 L 622.9 387.5 L 621.8 387.3 L 621.8 387.3 L 621.3 387.1 L 621.2 387.1 L 621.0 387.0 L 621.0 387.0 L 620.9 387.0 L 620.9 387.0 L 620.9 387.0 L 620.7 387.0 L 620.6 386.9 L 620.3 386.9 L 620.1 388.0 L 620.1 388.1 L 618.6 387.6 L 616.5 387.7 L 616.0 388.4 L 615.5 390.6 L 615.7 391.3 L 616.2 392.6 L 616.6 393.1 L 618.1 393.9 L 617.4 395.4 L 614.5 396.6 L 614.1 396.2 L 614.1 395.6 L 614.0 395.2 L 613.9 394.1 L 614.0 386.9 L 613.7 385.7 L 613.1 384.3 L 612.4 383.8 L 611.6 382.9 L 610.7 380.5 L 609.3 378.9 L 608.6 378.0 L 605.4 375.7 L 604.6 374.9 L 602.7 371.5 L 602.4 370.6 L 602.2 368.2 L 602.6 365.7 L 603.3 362.9 L 604.3 360.3 L 604.9 360.5 L 605.2 360.8 L 604.3 363.5 L 603.5 365.8 L 604.2 365.8 L 605.4 363.9 L 606.6 361.2 L 607.0 360.5 L 607.8 357.3 L 608.3 355.2 L 608.3 353.0 L 609.3 350.5 L 609.2 345.3 L 609.4 343.8 L 609.5 343.1 L 608.9 341.3 L 608.5 340.5 L 607.6 340.6 L 606.7 340.2 L 607.0 338.4 L 607.8 336.8 L 611.4 333.6 L 611.2 333.4 L 611.3 330.9 L 611.8 329.9 L 613.1 329.2 L 614.5 326.0 L 614.3 325.1 L 614.7 322.5 L 616.3 320.4 L 617.3 318.0 L 617.3 314.6 L 618.2 312.6 L 619.6 311.8 L 620.2 311.2 L 620.3 311.1 L 620.6 310.3 L 620.0 308.8 L 620.8 308.0 L 621.6 305.9 L 621.6 305.5 L 621.4 304.6 L 621.1 304.2 L 621.1 302.2 L 621.3 301.4 L 621.7 301.2 L 622.5 299.6 L 621.9 299.1 L 621.9 298.7 L 622.4 297.2 L 622.7 294.9 L 621.7 293.2 L 622.5 291.4 L 622.3 290.1 L 622.7 286.8 L 623.5 284.1 L 623.6 283.7 L 622.8 282.9 L 622.5 282.2 L 622.8 281.5 L 622.5 280.6 L 621.9 279.6 L 623.0 278.6 L 623.6 276.5 L 623.9 274.9 L 623.9 274.1 L 623.3 273.5 L 623.1 272.6 L 622.8 269.9 L 624.3 268.6 L 623.9 266.8 L 624.2 265.1 L 623.7 263.8 L 622.5 262.8 L 620.7 262.6 L 619.1 262.1 L 617.7 259.2 L 617.0 258.9 L 615.5 257.1 L 614.2 255.0 L 614.0 252.7 L 611.8 253.0 L 611.6 253.0 L 611.3 252.3 L 611.8 251.6 L 612.4 249.5 L 611.7 246.6 L 609.3 245.5 L 609.6 244.6 L 605.8 244.3 L 605.1 242.0 L 606.5 241.4 L 607.4 241.3 L 607.6 240.7 L 607.7 240.3 L 606.9 238.7 L 607.0 237.0 L 604.7 235.8 L 601.5 235.4 L 598.5 235.4 L 594.8 234.6 L 593.8 234.8 L 592.4 234.8 L 589.4 234.5 L 588.9 234.4 L 588.1 233.5 L 587.6 233.5 L 587.1 233.7 L 584.8 236.5 L 584.7 237.6 L 583.5 238.3 L 581.2 238.6 L 580.8 237.0 L 579.6 236.3 L 580.4 234.5 L 580.4 233.9 L 579.9 233.1 L 578.5 231.8 L 577.6 229.7 L 578.9 226.5 L 578.7 225.7 L 577.5 224.5 L 575.5 224.3 L 573.6 223.2 L 573.4 222.8 L 571.5 222.2 L 571.1 222.1 L 570.0 222.4 L 569.4 222.2 L 569.1 222.0 L 568.3 219.6 L 568.2 218.1 L 568.3 218.0 L 568.5 216.4 L 567.0 214.4 L 565.8 213.4 L 565.6 211.2 L 564.0 208.5 L 561.7 207.2 L 559.2 206.9 L 558.4 207.3 L 556.0 206.7 L 554.8 204.4 L 554.7 203.5 L 554.3 202.8 L 553.1 202.6 L 552.3 202.8 L 550.3 201.3 L 549.6 200.2 L 548.2 200.2 L 547.2 199.9 L 546.8 198.9 L 545.1 198.4 L 544.9 197.8 L 545.1 196.8 L 544.5 192.1 L 544.6 190.3 L 545.1 188.5 L 544.7 185.6 L 543.8 182.8 L 543.8 182.7 L 543.6 182.5 L 541.3 181.8 L 540.4 181.8 L 540.1 182.0 L 539.3 181.9 L 536.4 180.4 L 536.4 179.6 L 535.3 178.5 L 533.4 177.7 L 530.8 177.0 L 529.8 176.1 L 529.0 175.0 L 527.8 173.0 L 526.5 172.3 L 525.9 171.5 L 525.7 170.6 L 526.0 170.3 L 526.2 169.8 L 525.7 167.8 L 524.7 166.1 L 523.7 165.2 L 522.3 164.6 L 520.3 160.0 L 518.0 158.6 L 516.0 156.7 L 515.3 156.1 L 507.9 152.6 L 504.6 150.6 L 500.5 149.9 L 498.7 148.4 L 489.8 144.1 L 489.5 143.9 L 489.7 143.6 L 489.6 143.4 L 486.8 141.4 L 483.5 139.4 L 482.6 138.2 L 480.1 137.4 L 477.6 137.4 L 476.1 137.6 L 474.7 138.2 L 474.0 138.6 L 473.6 138.6 L 472.8 138.3 L 471.9 138.4 L 470.8 139.3 L 469.6 138.7 L 468.5 139.5 L 466.3 140.6 L 465.2 140.7 L 464.0 140.6 L 462.0 139.0 L 461.7 139.0 L 461.5 139.2 L 461.0 139.4 L 458.0 139.3 L 457.1 138.5 L 456.9 137.7 L 455.9 137.4 L 454.6 138.0 L 454.3 138.6 L 454.1 139.5 L 454.5 140.3 L 454.4 141.1 L 453.8 141.9 L 452.5 142.2 L 451.6 142.2 L 449.8 140.9 L 447.0 141.5 L 445.3 142.1 L 444.5 145.6 L 445.0 149.5 L 445.2 149.8 L 446.4 149.8 L 446.9 150.8 L 447.1 152.3 L 447.3 153.8 L 447.6 154.2 L 447.9 156.1 L 447.7 157.2 L 446.9 158.6 L 446.3 158.9 L 443.2 159.3 L 440.5 158.5 L 438.5 158.3 L 437.4 157.9 L 436.5 157.2 L 435.6 155.6 L 433.7 156.0 L 431.2 157.1 L 429.3 156.9 L 426.9 157.5 L 422.5 159.9 L 419.8 161.1 L 418.8 161.9 L 415.2 164.1 L 414.3 165.0 L 414.3 165.4 L 412.9 166.0 L 411.4 165.7 L 410.6 166.0 L 406.6 168.3 L 404.0 170.2 L 403.2 170.2 L 396.8 173.3 L 395.5 173.6 L 392.3 175.0 L 390.9 175.9 L 390.2 177.1 L 389.7 177.0 L 388.8 175.7 L 390.0 173.6 L 391.3 171.8 L 389.6 170.5 L 388.5 170.4 L 387.4 170.7 L 386.8 171.8 L 385.0 174.2 L 384.1 174.7 L 382.3 175.0 L 381.8 176.6 L 380.9 177.2 L 379.2 177.8 L 374.7 178.3 L 371.0 177.4 L 368.0 177.5 L 365.9 177.8 L 362.6 178.5 L 360.1 179.4 L 355.9 179.9 L 354.9 180.1 L 351.5 181.4 L 348.3 181.1 L 345.3 181.3 L 342.8 182.3 L 342.4 182.8 L 342.7 184.1 L 341.8 183.6 L 340.1 181.4 L 339.0 179.6 L 337.1 175.2 L 335.5 169.0 L 335.0 166.0 L 335.2 164.6 L 335.5 163.5 L 336.3 162.1 L 337.7 161.6 L 337.0 162.8 L 336.4 165.9 L 336.3 168.8 L 337.4 172.9 L 339.2 178.4 L 340.7 180.1 L 341.7 181.0 L 342.6 181.0 L 345.5 180.3 L 346.1 179.7 L 347.2 169.3 L 347.1 168.2 L 346.8 167.8 L 346.1 167.5 L 345.8 166.7 L 345.8 165.8 L 346.0 165.6 L 345.5 164.9 L 344.7 164.3 L 344.0 164.2 L 343.5 163.9 L 342.4 161.5 L 340.7 158.7 L 338.5 156.4 L 338.1 156.1 L 336.4 154.6 L 334.2 153.4 L 330.6 152.4 L 329.7 152.6 L 327.8 152.2 L 325.6 151.1 L 322.2 148.6 L 319.0 145.4 L 318.0 144.2 L 317.3 142.4 L 316.0 142.3 L 314.2 141.4 L 312.2 140.5 L 310.6 140.1 L 306.0 138.1 L 302.6 135.9 L 300.5 134.0 L 297.8 131.9 L 294.1 129.6 L 287.1 125.7 L 282.5 123.4 L 274.9 120.2 L 274.5 120.0 L 265.1 116.6 L 251.3 112.4 L 243.4 110.4 L 236.6 109.2 L 233.1 108.8 L 232.8 108.7 L 231.6 108.6 L 229.8 108.5 L 227.1 108.3 L 227.0 108.3 L 226.9 108.3 L 225.5 108.2 L 225.1 108.2 L 221.8 108.4 L 219.4 107.9 L 208.6 106.9 L 196.3 107.4 L 191.2 108.0 L 185.9 108.5 L 179.8 109.4 L 178.8 109.6 L 154.2 114.1 L 148.9 114.8 L 142.5 115.3 L 140.9 115.0 L 139.6 114.5 L 137.1 115.1 L 133.9 115.6 L 126.7 117.3 L 116.4 119.0 L 123.3 116.9 L 123.5 115.8 L 123.4 112.1 L 123.4 110.0 L 124.5 107.4 L 125.9 105.7 L 126.7 105.5 L 125.6 97.1 L 123.7 94.8 L 123.6 94.6 L 123.5 94.6 L 129.3 83.1 L 129.3 81.4 L 129.1 80.1 L 128.0 78.3 L 123.6 75.4 L 120.3 73.6 L 118.6 73.2 L 118.0 73.0 L 114.9 70.8 L 105.4 60.2 L 104.3 58.1 L 105.6 54.8 L 107.8 50.7 L 108.5 46.6 L 108.0 44.4 L 108.0 44.4 L 110.9 44.3 L 113.3 44.3 L 120.4 44.3 L 120.4 44.3 L 120.5 44.3 L 121.8 44.3 L 121.8 44.3 L 122.3 44.3 L 122.3 44.3 L 122.6 44.3 L 122.9 44.3 L 123.6 44.3 L 125.4 44.3 L 126.1 44.3 L 132.1 44.3 L 132.5 44.3 L 133.4 44.3 L 135.6 44.3 L 137.9 44.3 L 138.7 44.3 L 139.0 44.3 L 140.1 44.3 L 140.3 44.3 L 142.7 44.3 L 143.3 44.3 L 143.3 44.3 L 143.5 44.3 L 143.6 44.3 L 143.8 44.3 L 143.8 44.3 L 153.4 44.2 L 153.4 44.2 L 163.2 44.2 L 163.7 44.2 L 164.8 44.2 L 166.2 44.1 L 166.6 44.2 L 167.6 44.2 L 182.0 44.3 L 183.6 44.3 L 187.9 44.4 L 188.0 44.4 L 192.7 44.4 L 192.7 44.4 L 198.6 44.4 L 198.8 44.4 L 199.0 44.4 L 202.8 44.6 L 203.9 44.7 L 205.3 44.7 L 215.4 44.6 L 215.8 44.6 L 220.3 44.8 L 221.1 44.7 L 226.8 44.7 L 227.1 44.7 L 232.3 44.7 L 233.7 44.7 L 234.0 44.7 L 234.0 44.7 L 235.5 44.7 L 236.0 44.7 L 236.5 44.7 L 242.8 44.7 L 244.4 44.7 L 255.0 44.7 L 255.7 44.7 L 256.2 44.7 L 256.9 44.7 L 257.5 44.8 L 268.6 44.8 L 269.0 44.8 L 270.8 44.8 L 326.7 44.4 L 326.7 44.4 L 327.7 44.4 L 362.5 44.0 L 362.7 44.0 L 362.7 44.0 L 363.4 44.0 L 372.6 44.0 L 372.8 44.0 L 373.1 44.0 L 375.3 44.0 L 375.4 44.0 L 375.7 44.0 L 376.0 44.0 L 378.3 44.0 L 378.7 47.1 L 380.3 50.8 L 382.7 53.4 L 384.6 55.8 L 389.4 70.1 L 392.6 74.1 L 392.8 74.1 L 419.5 75.3 L 419.5 75.3 L 426.5 75.7 L 426.9 75.7 L 443.0 76.4 L 453.2 76.8 L 453.4 76.9 L 473.9 77.8 L 476.7 78.0 L 477.8 78.0 L 478.3 78.0 L 478.5 78.0 L 481.9 78.2 L 481.9 78.2 L 495.1 78.9 L 495.1 78.9 L 497.7 79.0 L 501.3 79.2 L 502.4 79.3 L 509.3 79.6 L 516.3 80.0 L 516.6 80.0 L 523.0 80.4 L 523.1 80.4 L 540.0 81.3 L 540.9 81.4 L 542.0 81.4 L 542.0 81.4 L 546.1 81.6 L 547.2 81.7 L 549.5 81.8 L 551.2 81.9 L 551.2 81.9 L 554.3 82.1 L 554.5 82.1 Z`;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function projectFloridaPoint(lat, lon) {
  const x = FLORIDA_STATIC_VIEWBOX.offsetX + ((Number(lon) - FLORIDA_MAP_BOUNDS.west) * FLORIDA_STATIC_VIEWBOX.scale);
  const y = FLORIDA_STATIC_VIEWBOX.offsetY + ((FLORIDA_MAP_BOUNDS.north - Number(lat)) * FLORIDA_STATIC_VIEWBOX.scale);
  return {
    x: clampNumber((x / FLORIDA_STATIC_VIEWBOX.width) * 100, 2, 98),
    y: clampNumber((y / FLORIDA_STATIC_VIEWBOX.height) * 100, 2, 98)
  };
}

function getStaticZoneSize(zone) {
  return clampNumber(24 + ((Number(zone?.total) || 0) * 1.15) + ((Number(zone?.hotspotReports) || 0) * 1.65), 24, 84);
}

function getStaticZoneOpacity(zone) {
  return clampNumber(0.18 + ((Number(zone?.hotspotReports) || 0) / 80), 0.18, 0.44);
}

function getStaticFloridaSvg() {
  return `
    <svg class="storm-static-florida-svg" viewBox="0 0 1000 760" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="stormFloridaFill" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#17335c"></stop>
          <stop offset="100%" stop-color="#10243f"></stop>
        </linearGradient>
      </defs>
      <path class="storm-static-florida-shape" d="${FLORIDA_STATIC_SVG_PATH}"></path>
      <path class="storm-static-florida-outline" d="${FLORIDA_STATIC_SVG_PATH}"></path>
    </svg>
  `;
}

function renderStormMapAssignments(zones) {
  const el = $('stormMapAssignments');
  if (!el) return;
  if (!zones.length) {
    el.innerHTML = '<div class="empty-state small"><i class="fas fa-bullseye"></i><p>Affected counties will populate after the storm feed loads.</p></div>';
    return;
  }
  el.innerHTML = zones.map((zone, index) => {
    const cityCount = getZoneCityBreakdown(zone).length;
    return `
      <article class="storm-map-assignment-item ${selectedStormCounty === zone.county ? 'active' : ''}" data-county="${escapeHtml(zone.county)}">
        <div>
          <strong>County ${index + 1}: ${escapeHtml(zone.county)}</strong>
          <p>${escapeHtml(String(zone.total))} reports · ${escapeHtml(String(cityCount))} affected cities</p>
          <small>${escapeHtml(String(zone.wind))} wind · ${escapeHtml(String(zone.hail))} hail · latest ${escapeHtml(formatDateTime(zone.latestDate))}</small>
        </div>
        <span class="storm-map-assignment-score">${escapeHtml(String(zone.score))}</span>
      </article>
    `;
  }).join('');
  el.querySelectorAll('[data-county]').forEach((item) => {
    item.addEventListener('click', () => focusStormCounty(item.dataset.county || '', ''));
  });
}

function renderStormMapPins(reports, activeCounty = '', activeCity = '') {
  const el = $('stormMapPins');
  const label = $('stormMapPinsLabel');
  if (!el) return;
  const activeCountyName = normalizeStormCounty(activeCounty);
  const activeCityKey = normalizeLocationToken(activeCity || '');
  const items = reports.filter((report) => {
    const countyMatch = activeCountyName ? normalizeStormCounty(report.county || '') === activeCountyName : true;
    const cityMatch = activeCityKey ? normalizeLocationToken(report.city || 'City not listed') === activeCityKey : true;
    return countyMatch && cityMatch;
  });
  if (label) {
    label.textContent = activeCity
      ? `${items.length} reports pinned in ${activeCity}`
      : activeCounty
        ? `${items.length} reports pinned in ${activeCounty}`
        : `${items.length} reports with coordinates`;
  }
  if (!items.length) {
    el.innerHTML = '<div class="empty-state small"><i class="fas fa-cloud-bolt"></i><p>Storm reports will appear here after you choose a county and city.</p></div>';
    return;
  }
  el.innerHTML = items.map((report) => {
    const reportCounty = normalizeStormCounty(report.county || '');
    const reportCity = String(report.city || '').trim() || 'City not listed';
    const active = activeCityKey && normalizeLocationToken(reportCity) === activeCityKey;
    return `
      <article class="storm-map-pin-item ${active ? 'active' : ''}" data-report-county="${escapeHtml(reportCounty)}" data-report-city="${escapeHtml(reportCity)}">
        <strong>${escapeHtml(reportCity)} · ${escapeHtml(formatStormMagnitude(report))}</strong>
        <p>${escapeHtml(report.eventType || 'Storm report')} · ${escapeHtml(reportCounty || 'Florida')}</p>
        <small>${escapeHtml(formatDateTime(report.beginDate))}</small>
      </article>
    `;
  }).join('');
  el.querySelectorAll('[data-report-county]').forEach((item) => {
    item.addEventListener('click', () => focusStormCounty(item.dataset.reportCounty || '', item.dataset.reportCity || ''));
  });
}

function renderStormLeadOverlayList(zone, cityContext = getSelectedStormCityContext(zone)) {
  const el = $('stormMapLeadList');
  if (!el) return;
  if (!zone) {
    stormLeadOverlayState.visible = 0;
    renderStormLeadOverlayStatus();
    el.innerHTML = '<div class="empty-state small"><i class="fas fa-location-crosshairs"></i><p>Select an affected county and city to see matching Florida leads.</p></div>';
    return;
  }
  const matches = getZoneLeadMatches(zone, cityContext);
  const cityLabel = cityContext?.city || zone.county;
  stormLeadOverlayState.visible = matches.length;
  renderStormLeadOverlayStatus();
  if (!matches.length) {
    el.innerHTML = `<div class="empty-state small"><i class="fas fa-house-circle-check"></i><p>No Florida leads are matching ${escapeHtml(cityLabel)} yet. This build now checks every CRM lead, normalizes alternate location fields, and ranks county matches first, city matches second, then geo distance.</p></div>`;
    return;
  }
  el.innerHTML = matches.map(({ lead, cityMatch, countyMatch, geoMatch, geoMiles }) => {
    const matchLabel = countyMatch && cityMatch
      ? 'county + city match'
      : countyMatch
        ? 'county match'
        : cityMatch
          ? 'city match'
          : geoMatch
            ? `${Math.round(geoMiles || 0)} mi geo match`
            : 'lead match';
    return `
      <article class="storm-map-lead-item">
        <strong>${escapeHtml(lead.contact_name || 'Unnamed lead')}</strong>
        <p>${escapeHtml(getLeadDisplayLocation(lead))}</p>
        <small>${escapeHtml([lead.phone, lead.damage_type, lead.status].filter(Boolean).join(' · ') || 'CRM lead')} · ${escapeHtml(matchLabel)}</small>
      </article>
    `;
  }).join('');
}

function renderSelectedStormZone(zone, cityContext = getSelectedStormCityContext(zone)) {
  const badge = $('stormMapZoneBadge');
  const summary = $('stormMapZoneSummary');
  if (!summary || !badge) return;
  if (!zone) {
    badge.textContent = 'Awaiting county data';
    summary.innerHTML = '<div class="empty-state small"><i class="fas fa-map-pin"></i><p>Choose an affected county and city to inspect that territory.</p></div>';
    renderStormLeadOverlayList(null, null);
    return;
  }
  const cityOptions = getZoneCityBreakdown(zone);
  const resolvedCity = cityContext || cityOptions[0] || null;
  const matchingLeads = getZoneLeadMatches(zone, resolvedCity);
  const scopedReports = resolvedCity?.reports?.length ? resolvedCity.reports : zone.reports;
  badge.textContent = resolvedCity ? `${zone.county} · ${resolvedCity.city}` : (zone.county || 'Selected area');
  summary.innerHTML = `
    <div class="storm-map-zone-kpis">
      <div class="storm-map-zone-kpi"><span>County reports</span><strong>${escapeHtml(String(zone.total || 0))}</strong></div>
      <div class="storm-map-zone-kpi"><span>Affected cities</span><strong>${escapeHtml(String(cityOptions.length || 0))}</strong></div>
      <div class="storm-map-zone-kpi"><span>Selected city reports</span><strong>${escapeHtml(String(resolvedCity?.total || 0))}</strong></div>
      <div class="storm-map-zone-kpi"><span>Lead overlays</span><strong>${escapeHtml(String(matchingLeads.length || 0))}</strong></div>
      <div class="storm-map-zone-kpi wide"><span>Latest hit</span><strong>${escapeHtml((resolvedCity?.latestDate || zone.latestDate) ? formatDateTime(resolvedCity?.latestDate || zone.latestDate) : '—')}</strong></div>
    </div>
    <div class="storm-map-zone-note">
      <strong>Assignment note</strong>
      <p>Strategic Lead Mapping now uses county and city selectors. Pick a county, then a city, and the lead overlay will reference the selected city first instead of the whole county.</p>
    </div>
    <div class="storm-map-zone-list">
      ${scopedReports.slice(0, 12).map((report) => `
        <article class="storm-map-zone-report">
          <strong>${escapeHtml(formatStormMagnitude(report))}</strong>
          <p>${escapeHtml(report.eventType || 'Storm report')} · ${escapeHtml(report.city || report.county || 'Florida')}</p>
          <small>${escapeHtml(formatDateTime(report.beginDate))}</small>
        </article>
      `).join('')}
    </div>
  `;
  renderStormLeadOverlayList(zone, resolvedCity);
}

function highlightSelectedStormZone() {
  return;
}

function focusStormCounty(countyName, cityName = '') {
  selectedStormCounty = countyName || '';
  selectedStormCity = cityName || '';
  renderStormCoverageMap();
}

function focusStormCity(cityName = '') {
  selectedStormCity = cityName || '';
  renderStormCoverageMap();
}

function refreshActiveStormSelectionPanels() {
  const zones = buildStormCountyZones();
  const reports = getStormReportsWithCoords();
  const zone = zones.find((item) => item.county === selectedStormCounty) || zones[0] || null;

  if (!zone) {
    renderSelectedStormZone(null, null);
    renderStormMapPins(reports);
    renderStormLeadOverlayStatus();
    return;
  }

  selectedStormCounty = zone.county || '';
  const cityOptions = getZoneCityBreakdown(zone);
  const cityContext = cityOptions.find((city) => normalizeLocationToken(city.city) === normalizeLocationToken(selectedStormCity || '')) || cityOptions[0] || null;
  selectedStormCity = cityContext?.city || '';

  renderSelectedStormZone(zone, cityContext);
  renderStormMapPins(reports, zone.county || '', cityContext?.city || '');
  renderStormLeadOverlayStatus();
}

function renderStormCoverageMap() {
  const map = ensureStormMap();
  if (!map) return;

  const mapEl = map.el;
  const zones = buildStormCountyZones();
  const reports = getStormReportsWithCoords();
  const leadCandidates = getLeadOverlayCandidates();

  stormLeadOverlayState.totalCandidates = leadCandidates.length;

  if (!zones.length) {
    renderStormLeadOverlayStatus();
    renderStormMapAssignments(zones);
    mapEl.innerHTML = '<div class="storm-map-loading">Loading affected Florida counties…</div>';
    renderSelectedStormZone(null, null);
    renderStormMapPins(reports);
    scheduleLeadOverlayGeocode();
    return;
  }

  const zone = zones.find((item) => item.county === selectedStormCounty) || zones[0] || null;
  selectedStormCounty = zone?.county || '';
  const cityOptions = getZoneCityBreakdown(zone);
  const cityContext = cityOptions.find((city) => normalizeLocationToken(city.city) === normalizeLocationToken(selectedStormCity || '')) || cityOptions[0] || null;
  selectedStormCity = cityContext?.city || '';

  renderStormMapAssignments(zones);
  renderSelectedStormZone(zone, cityContext);
  renderStormMapPins(reports, zone?.county || '', cityContext?.city || '');
  renderStormLeadOverlayStatus();

  mapEl.innerHTML = `
    <div class="storm-selector-shell">
      <div class="storm-selector-summary">
        <div class="storm-selector-stat"><strong>${escapeHtml(String(zones.length))}</strong><span>counties hit</span></div>
        <div class="storm-selector-stat"><strong>${escapeHtml(String(cityOptions.length || 0))}</strong><span>cities in ${escapeHtml(selectedStormCounty || 'county')}</span></div>
        <div class="storm-selector-stat"><strong>${escapeHtml(String(cityContext?.total || 0))}</strong><span>reports in ${escapeHtml(cityContext?.city || 'selected city')}</span></div>
      </div>
      <div class="storm-selector-grid">
        <section class="storm-selector-panel">
          <div class="storm-selector-panel-head">
            <div>
              <h4>Affected counties</h4>
              <p>Scroll the county list and tap one county to load its city list.</p>
            </div>
            <div class="storm-selector-active">${escapeHtml(selectedStormCounty || 'Choose a county')}</div>
          </div>
          <div id="stormMapCountyList" class="storm-selector-county-list">
            ${zones.map((item) => {
              const countyCityCount = getZoneCityBreakdown(item).length;
              return `
                <button type="button" class="storm-selector-county-btn ${item.county === selectedStormCounty ? 'active' : ''}" data-storm-county="${escapeHtml(item.county)}">
                  <strong>${escapeHtml(item.county)}</strong>
                  <span>${escapeHtml(String(item.total))} reports · ${escapeHtml(String(countyCityCount))} cities</span>
                </button>
              `;
            }).join('')}
          </div>
        </section>
        <section class="storm-selector-panel">
          <div class="storm-selector-panel-head">
            <div>
              <h4>Affected cities in ${escapeHtml(selectedStormCounty || 'Florida')}</h4>
              <p>Counties and cities are now separated into their own scroll areas for cleaner phone use.</p>
            </div>
            <div class="storm-selector-active">${escapeHtml(cityContext ? `${cityContext.city} selected` : 'Choose a city')}</div>
          </div>
          <div id="stormMapCityList" class="storm-selector-city-list">
            ${cityOptions.length ? cityOptions.map((city) => `
              <button type="button" class="storm-selector-city-btn ${normalizeLocationToken(city.city) === normalizeLocationToken(selectedStormCity || '') ? 'active' : ''}" data-storm-city="${escapeHtml(city.city)}">
                <strong>${escapeHtml(city.city)}</strong>
                <span>${escapeHtml(String(city.total))} reports · ${escapeHtml(String(city.wind))} wind · ${escapeHtml(String(city.hail))} hail</span>
              </button>
            `).join('') : '<div class="empty-state small"><i class="fas fa-city"></i><p>No affected cities were found for this county yet.</p></div>'}
          </div>
        </section>
      </div>
    </div>
  `;

  mapEl.querySelectorAll('[data-storm-county]').forEach((node) => {
    node.addEventListener('click', () => focusStormCounty(node.dataset.stormCounty || '', ''));
  });
  mapEl.querySelectorAll('[data-storm-city]').forEach((node) => {
    node.addEventListener('click', () => focusStormCity(node.dataset.stormCity || ''));
  });

  scheduleLeadOverlayGeocode();
}

function getTrainingLocalKey() {
  const userPart = currentUser?.id || 'guest';
  return `tbd-training-progress-${userPart}`;
}

function getTrainingStore() {
  try {
    const raw = window.localStorage.getItem(getTrainingLocalKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      completedToday: Number(parsed.completedToday) || 0,
      mastered: Number(parsed.mastered) || 0,
      modules: parsed.modules && typeof parsed.modules === 'object' ? parsed.modules : {},
      updatedAt: parsed.updatedAt || null
    };
  } catch (error) {
    return { completedToday: 0, mastered: 0, modules: {}, updatedAt: null };
  }
}

function setTrainingStore(nextStore) {
  try {
    window.localStorage.setItem(getTrainingLocalKey(), JSON.stringify({
      completedToday: Number(nextStore.completedToday) || 0,
      mastered: Number(nextStore.mastered) || 0,
      modules: nextStore.modules && typeof nextStore.modules === 'object' ? nextStore.modules : {},
      updatedAt: nextStore.updatedAt || new Date().toISOString()
    }));
  } catch (error) {
    console.warn('Could not persist training progress', error);
  }
}

let trainingProgressRows = [];
let trainingCompletedToday = 0;
let trainingProgressMode = 'loading';
let trainingProgressMessage = 'Loading saved progress…';

function getTodayStartIso() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.toISOString();
}

function getTrainingProgressRow(moduleKey) {
  return trainingProgressRows.find(row => row.module_key === moduleKey) || null;
}

function applyTrainingRowsToDrillIndex() {
  Object.keys(TRAINING_MODULES).forEach((moduleKey) => {
    const row = getTrainingProgressRow(moduleKey);
    if (row && Number.isFinite(Number(row.last_drill_index))) {
      trainingDrillIndex[moduleKey] = Number(row.last_drill_index) || 0;
    }
  });
}

function getTrainingModuleProgress(moduleKey) {
  const liveRow = getTrainingProgressRow(moduleKey);
  if (liveRow) {
    return {
      completed_count: Number(liveRow.completed_count) || 0,
      mastered_count: Number(liveRow.mastered_count) || 0,
      last_drill_index: Number(liveRow.last_drill_index) || 0,
      updated_at: liveRow.updated_at || liveRow.last_completed_at || null
    };
  }
  const fallback = getTrainingStore();
  const localModule = fallback.modules?.[moduleKey] || {};
  return {
    completed_count: Number(localModule.completed_count) || 0,
    mastered_count: Number(localModule.mastered_count) || 0,
    last_drill_index: Number(localModule.last_drill_index) || 0,
    updated_at: localModule.updated_at || fallback.updatedAt || null
  };
}

function getTrainingMasteredTotal() {
  if (trainingProgressRows.length) {
    return trainingProgressRows.reduce((sum, row) => sum + (Number(row.mastered_count) || 0), 0);
  }
  const fallback = getTrainingStore();
  return Number(fallback.mastered) || 0;
}

function getTrainingCompletedTodayValue() {
  if (trainingProgressMode === 'live') return Number(trainingCompletedToday) || 0;
  const fallback = getTrainingStore();
  return Number(fallback.completedToday) || 0;
}

function updateTrainingSyncStatus(message = '') {
  const el = $('trainingSyncStatus');
  if (!el) return;
  const text = message || trainingProgressMessage || 'Training progress ready.';
  el.textContent = text;
  el.className = 'training-sync-status';
  el.classList.add(`mode-${trainingProgressMode || 'idle'}`);
}

async function loadTrainingProgress() {
  if (!currentUser) return;
  trainingProgressMode = 'loading';
  trainingProgressMessage = 'Loading saved progress…';
  updateTrainingSyncStatus();
  try {
    const [progressRes, eventsRes] = await Promise.all([
      sb
        .from('crm_training_progress')
        .select('user_id,module_key,completed_count,mastered_count,last_drill_index,last_completed_at,updated_at')
        .eq('user_id', currentUser.id)
        .order('module_key', { ascending: true }),
      sb
        .from('crm_training_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', currentUser.id)
        .gte('created_at', getTodayStartIso())
        .in('event_type', ['completed', 'mastered'])
    ]);

    if (progressRes.error) throw progressRes.error;
    if (eventsRes.error) throw eventsRes.error;

    trainingProgressRows = Array.isArray(progressRes.data) ? progressRes.data : [];
    trainingCompletedToday = eventsRes.count || 0;
    applyTrainingRowsToDrillIndex();

    const localSnapshot = {
      completedToday: trainingCompletedToday,
      mastered: getTrainingMasteredTotal(),
      modules: {},
      updatedAt: new Date().toISOString()
    };
    trainingProgressRows.forEach((row) => {
      localSnapshot.modules[row.module_key] = {
        completed_count: Number(row.completed_count) || 0,
        mastered_count: Number(row.mastered_count) || 0,
        last_drill_index: Number(row.last_drill_index) || 0,
        updated_at: row.updated_at || row.last_completed_at || null
      };
    });
    setTrainingStore(localSnapshot);

    trainingProgressMode = 'live';
    trainingProgressMessage = trainingProgressRows.length
      ? `Progress synced to Supabase · ${formatDateTime(new Date().toISOString())}`
      : 'Supabase connected. Your training progress will save as soon as you begin drills.';
  } catch (error) {
    console.error(error);
    trainingProgressRows = [];
    trainingCompletedToday = 0;
    const fallback = getTrainingStore();
    Object.keys(TRAINING_MODULES).forEach((moduleKey) => {
      const localModule = fallback.modules?.[moduleKey];
      if (localModule && Number.isFinite(Number(localModule.last_drill_index))) {
        trainingDrillIndex[moduleKey] = Number(localModule.last_drill_index) || 0;
      }
    });
    trainingProgressMode = 'fallback';
    trainingProgressMessage = 'Supabase training tables are not live yet. Run dashboard/training_progress_schema.sql to enable saved agent progress. Using this device as a temporary backup.';
  }
  renderTrainingMode();
}

async function persistTrainingProgress(moduleKey, { incrementCompleted = 0, incrementMastered = 0, eventType = null } = {}) {
  const safeModule = moduleKey in TRAINING_MODULES ? moduleKey : 'roofing';
  const nextDrillIndex = Number(trainingDrillIndex[safeModule]) || 0;
  const fallback = getTrainingStore();
  const fallbackModule = fallback.modules?.[safeModule] || {};

  if (trainingProgressMode !== 'live' || !currentUser) {
    const nextFallback = {
      completedToday: Number(fallback.completedToday) || 0,
      mastered: Number(fallback.mastered) || 0,
      modules: { ...(fallback.modules || {}) },
      updatedAt: new Date().toISOString()
    };
    const updatedModule = {
      completed_count: (Number(fallbackModule.completed_count) || 0) + (incrementCompleted || 0),
      mastered_count: (Number(fallbackModule.mastered_count) || 0) + (incrementMastered || 0),
      last_drill_index: nextDrillIndex,
      updated_at: nextFallback.updatedAt
    };
    nextFallback.modules[safeModule] = updatedModule;
    if (eventType === 'completed' || eventType === 'mastered') nextFallback.completedToday += 1;
    if (eventType === 'mastered') nextFallback.mastered += 1;
    setTrainingStore(nextFallback);
    renderTrainingMode();
    updateTrainingSyncStatus(trainingProgressMessage);
    return;
  }

  try {
    const existing = getTrainingProgressRow(safeModule) || {
      completed_count: Number(fallbackModule.completed_count) || 0,
      mastered_count: Number(fallbackModule.mastered_count) || 0,
      last_drill_index: Number(fallbackModule.last_drill_index) || 0
    };
    const nowIso = new Date().toISOString();
    const payload = {
      user_id: currentUser.id,
      module_key: safeModule,
      completed_count: (Number(existing.completed_count) || 0) + (incrementCompleted || 0),
      mastered_count: (Number(existing.mastered_count) || 0) + (incrementMastered || 0),
      last_drill_index: nextDrillIndex,
      last_completed_at: (incrementCompleted || incrementMastered) ? nowIso : (existing.last_completed_at || null),
      updated_at: nowIso
    };

    const { error: upsertError } = await sb
      .from('crm_training_progress')
      .upsert(payload, { onConflict: 'user_id,module_key' });
    if (upsertError) throw upsertError;

    if (eventType) {
      const { error: eventError } = await sb
        .from('crm_training_events')
        .insert({
          user_id: currentUser.id,
          module_key: safeModule,
          event_type: eventType
        });
      if (eventError) throw eventError;
    }

    await loadTrainingProgress();
  } catch (error) {
    console.error(error);
    trainingProgressMode = 'fallback';
    trainingProgressMessage = 'Could not reach the Supabase training tables just now. Progress is being kept locally until the next refresh.';
    updateTrainingSyncStatus();
    await persistTrainingProgress(safeModule, { incrementCompleted, incrementMastered, eventType });
  }
}

function getCurrentTrainingDrill() {
  const module = TRAINING_MODULES[activeTrainingModule] || TRAINING_MODULES.roofing;
  const drills = Array.isArray(module.drills) ? module.drills : [];
  const rawIndex = trainingDrillIndex[activeTrainingModule] || 0;
  const safeIndex = drills.length ? ((rawIndex % drills.length) + drills.length) % drills.length : 0;
  trainingDrillIndex[activeTrainingModule] = safeIndex;
  return {
    module,
    drill: drills[safeIndex] || { title: 'Training drill', body: 'Open the active module to begin.', cues: [] },
    drillIndex: safeIndex,
    totalDrills: drills.length || 1
  };
}

function renderTrainingMode() {
  const current = getCurrentTrainingDrill();
  const module = current.module;
  const drill = current.drill;
  const moduleProgress = getTrainingModuleProgress(activeTrainingModule);

  if ($('trainingCurrentModuleStat')) $('trainingCurrentModuleStat').textContent = module.statLabel || module.title;
  if ($('trainingDrillStepStat')) $('trainingDrillStepStat').textContent = `${current.drillIndex + 1} / ${current.totalDrills}`;
  if ($('trainingCompletedTodayStat')) $('trainingCompletedTodayStat').textContent = String(getTrainingCompletedTodayValue() || 0);
  if ($('trainingMasteredStat')) $('trainingMasteredStat').textContent = String(getTrainingMasteredTotal() || 0);
  if ($('trainingScenarioTitle')) $('trainingScenarioTitle').textContent = drill.title;
  if ($('trainingScenarioBody')) $('trainingScenarioBody').textContent = drill.body;
  updateTrainingSyncStatus(
    trainingProgressMode === 'live'
      ? `Saved for ${module.statLabel || module.title} · ${moduleProgress.completed_count || 0} reps total`
      : trainingProgressMessage
  );

  if ($('trainingCueList')) {
    $('trainingCueList').innerHTML = (drill.cues || []).map((cue, index) => `
      <div class="training-cue-item">
        <span class="training-cue-num">${index + 1}</span>
        <div>
          <strong>${index === 0 ? 'Lead with this' : index === 1 ? 'Bridge with this' : 'Finish with this'}</strong>
          <p>${escapeHtml(cue)}</p>
        </div>
      </div>
    `).join('');
  }

  if ($('trainingObjectionList')) {
    $('trainingObjectionList').innerHTML = (module.objections || []).map((item) => `
      <article class="training-objection-item">
        <div class="training-objection-top">
          <span class="training-objection-pill">Objection</span>
          <strong>${escapeHtml(item.title || 'Common objection')}</strong>
        </div>
        <p>${escapeHtml(item.response || '')}</p>
      </article>
    `).join('');
  }
}

function activateTrainingModule(moduleKey) {
  const module = TRAINING_MODULES[moduleKey] || TRAINING_MODULES.roofing;
  activeTrainingModule = moduleKey in TRAINING_MODULES ? moduleKey : 'roofing';
  document.querySelectorAll('.training-module-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.trainingModule === activeTrainingModule);
  });
  if ($('trainingFrameTitle')) $('trainingFrameTitle').textContent = module.title;
  if ($('trainingFrameSubtitle')) $('trainingFrameSubtitle').textContent = module.subtitle;
  if ($('trainingOpenLink')) $('trainingOpenLink').href = module.href;
  if ($('trainingFrame') && $('trainingFrame').getAttribute('src') !== module.href) {
    $('trainingFrame').setAttribute('src', module.href);
  }
  renderTrainingMode();
}

function bindTrainingButtons() {
  if ($('trainingStartDrillBtn') && $('trainingStartDrillBtn').dataset.bound !== '1') {
    $('trainingStartDrillBtn').dataset.bound = '1';
    $('trainingStartDrillBtn').addEventListener('click', async () => {
      activateTrainingModule(activeTrainingModule);
      const current = getCurrentTrainingDrill();
      if ($('trainingScenarioBody')) {
        $('trainingScenarioBody').textContent = current.drill.body + ' Keep the live script open below while you practice this rep.';
      }
      await persistTrainingProgress(activeTrainingModule, { incrementCompleted: 1, eventType: 'completed' });
    });
  }

  if ($('trainingNextDrillBtn') && $('trainingNextDrillBtn').dataset.bound !== '1') {
    $('trainingNextDrillBtn').dataset.bound = '1';
    $('trainingNextDrillBtn').addEventListener('click', async () => {
      const module = TRAINING_MODULES[activeTrainingModule] || TRAINING_MODULES.roofing;
      const total = Array.isArray(module.drills) ? module.drills.length : 1;
      trainingDrillIndex[activeTrainingModule] = ((trainingDrillIndex[activeTrainingModule] || 0) + 1) % total;
      renderTrainingMode();
      await persistTrainingProgress(activeTrainingModule, { eventType: null });
    });
  }

  if ($('trainingMarkMasteredBtn') && $('trainingMarkMasteredBtn').dataset.bound !== '1') {
    $('trainingMarkMasteredBtn').dataset.bound = '1';
    $('trainingMarkMasteredBtn').addEventListener('click', async () => {
      await persistTrainingProgress(activeTrainingModule, { incrementCompleted: 1, incrementMastered: 1, eventType: 'mastered' });
    });
  }

  if ($('trainingRefreshProgressBtn') && $('trainingRefreshProgressBtn').dataset.bound !== '1') {
    $('trainingRefreshProgressBtn').dataset.bound = '1';
    $('trainingRefreshProgressBtn').addEventListener('click', () => loadTrainingProgress());
  }
}

function initTrainingTab() {
  document.querySelectorAll('.training-module-btn').forEach(btn => {
    if (btn.dataset.trainingBound === '1') return;
    btn.dataset.trainingBound = '1';
    btn.addEventListener('click', () => activateTrainingModule(btn.dataset.trainingModule || 'roofing'));
  });
  bindTrainingButtons();
  renderTrainingMode();
}

function getPreferredStormStates() {
  return ['FL'];
}

function summarizeSeverity(severity, urgency) {
  const sev = String(severity || '').toLowerCase();
  const urg = String(urgency || '').toLowerCase();
  if (sev === 'extreme' || sev === 'severe' || urg === 'immediate') return 'high';
  if (sev === 'moderate' || urg === 'expected') return 'medium';
  return 'low';
}

function formatStormMagnitude(report) {
  if (!report) return '—';
  if (report.kind === 'hail') return `${Number(report.magnitude || 0).toFixed(2)}" hail`;
  if (report.kind === 'wind') return `${Math.round(Number(report.magnitudeMph || 0))} mph wind`;
  if (report.kind === 'tornado') return report.tornadoScale ? `${report.tornadoScale} tornado` : (report.magnitudeLabel || 'Tornado');
  return report.magnitudeLabel || '—';
}

function buildStormReportSourceUrl(report) {
  const direct = String(report?.sourceUrl || report?.source_url || '').trim();
  if (direct) return direct;
  const eventId = String(report?.id || '').trim();
  if (/^\d+$/.test(eventId)) {
    return `https://www.ncei.noaa.gov/stormevents/eventdetails.jsp?id=${encodeURIComponent(eventId)}`;
  }
  const datasetUrl = String(report?.sourceDatasetUrl || report?.source_dataset_url || '').trim();
  if (datasetUrl) return datasetUrl;
  return 'https://www.ncei.noaa.gov/stormevents/';
}

function bindStormReportCards() {
  const grid = $('stormAreasGrid');
  if (!grid) return;
  grid.querySelectorAll('[data-storm-report-url]').forEach((card) => {
    const openSource = () => {
      const url = String(card.dataset.stormReportUrl || '').trim();
      if (!url) return;
      window.open(url, '_blank', 'noopener,noreferrer');
    };
    card.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) return;
      openSource();
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSource();
    });
  });
}

function getStormCountySummary() {
  return Array.isArray(stormIntel.countyBreakdown) ? stormIntel.countyBreakdown : [];
}

function getFilteredStormReports() {
  const reports = Array.isArray(stormIntel.severeReports) ? stormIntel.severeReports : [];
  const search = String(stormReportSearch || '').trim().toLowerCase();
  const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
  return reports.filter((report) => {
    if (stormReportFilter === 'recent') {
      if (new Date(report.beginDate || 0).getTime() < fourteenDaysAgo) return false;
    } else if (stormReportFilter !== 'all' && report.kind !== stormReportFilter) {
      return false;
    }
    if (!search) return true;
    const haystack = [report.eventType, report.county, report.city, report.source, report.narrative]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(search);
  });
}

function renderStormStateChips() {
  if (!$('stormStateChips')) return;
  const states = stormIntel.states?.length ? stormIntel.states : ['FL'];
  $('stormStateChips').innerHTML = states.map((state, index) => `
    <span class="storm-chip ${index === 0 ? 'active' : ''}">${escapeHtml(state)}</span>
  `).join('');
}

function bindStormReportControls() {
  document.querySelectorAll('[data-storm-filter]').forEach((btn) => {
    if (btn.dataset.boundStormFilter === '1') return;
    btn.dataset.boundStormFilter = '1';
    btn.addEventListener('click', () => {
      stormReportFilter = btn.dataset.stormFilter || 'all';
      renderMapMode();
    });
  });
  const searchInput = $('stormReportSearchInput');
  if (searchInput && searchInput.dataset.boundStormSearch !== '1') {
    searchInput.dataset.boundStormSearch = '1';
    searchInput.addEventListener('input', (event) => {
      stormReportSearch = event.target.value || '';
      renderMapMode();
    });
  }
}

function renderMapMode() {
  bindStormReportControls();
  renderStormStateChips();

  const alerts = Array.isArray(stormIntel.alerts) ? stormIntel.alerts : [];
  const reportsAll = Array.isArray(stormIntel.severeReports) ? stormIntel.severeReports : [];
  const reports = getFilteredStormReports();
  const summary = stormIntel.summary || {};
  const countyBreakdown = getStormCountySummary();
  const latestReport = summary.latestReport || reportsAll[0] || null;
  const maxHail = summary.maxHail || null;
  const maxWind = summary.maxWind || null;
  const searchInput = $('stormReportSearchInput');
  if (searchInput && searchInput.value !== stormReportSearch) searchInput.value = stormReportSearch;

  const mapHeader = document.querySelector('#view-map .view-header p');
  if (mapHeader) {
    mapHeader.textContent = 'Florida-only hail and 40+ mph wind storm intelligence for the last 12 months using free NOAA data.';
  }
  const topbarTitle = document.querySelector('#view-map .mapmode-topbar h3');
  if (topbarTitle) {
    topbarTitle.innerHTML = '<i class="fas fa-cloud-bolt"></i> Florida Severe Report Board';
  }
  const topbarText = document.querySelector('#view-map .mapmode-topbar p');
  if (topbarText) {
    topbarText.textContent = 'Every qualifying Florida NOAA report is searchable below, plus county rankings and live weather context.';
  }
  const boardLabel = document.querySelector('#view-map .mapmode-board-label');
  if (boardLabel) boardLabel.textContent = 'All Florida Reports';

  const legendItems = document.querySelectorAll('#view-map .mapmode-board-legend span');
  if (legendItems[0]) legendItems[0].innerHTML = '<i class="fas fa-circle" style="color:#38bdf8"></i> Hail report';
  if (legendItems[1]) legendItems[1].innerHTML = '<i class="fas fa-circle" style="color:#f59e0b"></i> Wind 40+ mph';
  if (legendItems[2]) legendItems[2].innerHTML = '<i class="fas fa-circle" style="color:#ef4444"></i> Latest activity';

  document.querySelectorAll('[data-storm-filter]').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.stormFilter || 'all') === stormReportFilter);
  });

  const kpiLabels = document.querySelectorAll('#view-map .mapmode-kpi span');
  if (kpiLabels[0]) kpiLabels[0].textContent = 'Hail reports';
  if (kpiLabels[1]) kpiLabels[1].textContent = 'Wind 40+ mph';
  if (kpiLabels[2]) kpiLabels[2].textContent = 'Counties hit';
  if (kpiLabels[3]) kpiLabels[3].textContent = 'Latest report';

  const queueHeading = document.querySelector('#view-map .mapmode-card:nth-of-type(2) h3');
  if (queueHeading) queueHeading.innerHTML = '<i class="fas fa-map-location-dot"></i> County Hot List';
  const queueMono = document.querySelector('#view-map .mapmode-card:nth-of-type(2) .mono');
  if (queueMono) queueMono.textContent = 'All Florida counties ranked by report volume';

  const sourceHeading = document.querySelector('#view-map .mapmode-card:nth-of-type(3) h3');
  if (sourceHeading) sourceHeading.innerHTML = '<i class="fas fa-layer-group"></i> Storm Report Summary';
  const sourceMono = document.querySelector('#view-map .mapmode-card:nth-of-type(3) .mono');
  if (sourceMono) sourceMono.textContent = 'Free NOAA + NWS sources only';

  if ($('stormAlertCount')) $('stormAlertCount').textContent = String(summary.hailCount || 0);
  if ($('stormHighCount')) $('stormHighCount').textContent = String(summary.windCount || 0);
  if ($('stormTornadoCount')) $('stormTornadoCount').textContent = String(summary.tornadoCount || 0);
  if ($('stormLeadCount')) $('stormLeadCount').textContent = String(summary.countyCount || countyBreakdown.length || 0);
  if ($('stormUpdatedAt')) {
    $('stormUpdatedAt').textContent = latestReport?.beginDate
      ? formatDateTime(latestReport.beginDate)
      : (stormIntel.loadedAt ? formatDateTime(stormIntel.loadedAt) : 'Waiting for feed');
  }

  if ($('stormReportResultsLabel')) {
    $('stormReportResultsLabel').textContent = reportsAll.length
      ? `Showing ${reports.length} of ${reportsAll.length} Florida reports`
      : 'Loading full Florida report list…';
  }
  if ($('stormReportWindowLabel')) {
    $('stormReportWindowLabel').textContent = summary.windowStart
      ? `${new Date(summary.windowStart).toLocaleDateString()} → ${new Date(summary.windowEnd || Date.now()).toLocaleDateString()}`
      : 'Past 12 months';
  }

  if ($('stormAreasGrid')) {
    if (!reportsAll.length) {
      $('stormAreasGrid').innerHTML = '<div class="empty-state small"><i class="fas fa-cloud-bolt"></i><p>Loading Florida hail and wind reports from NOAA…</p></div>';
    } else if (!reports.length) {
      $('stormAreasGrid').innerHTML = '<div class="empty-state small"><i class="fas fa-filter-circle-xmark"></i><p>No Florida reports match your current search or filter.</p></div>';
    } else {
      $('stormAreasGrid').innerHTML = reports.map((report, index) => {
        const priority = report.kind === 'tornado' ? 'high' : (report.kind === 'wind' ? 'high' : (index === 0 ? 'medium' : 'low'));
        const location = [report.city, report.county].filter(Boolean).join(' · ');
        const narrative = report.narrative ? report.narrative.slice(0, 180) : (report.preliminary ? 'NOAA SPC preliminary storm report.' : 'Official NOAA storm report.');
        const sourceUrl = buildStormReportSourceUrl(report);
        const kindLabel = report.kind === 'hail' ? 'Hail' : (report.kind === 'tornado' ? 'Tornado' : 'Wind');
        const prelimBadge = report.preliminary ? '<span class="storm-area-pill" style="background:#7c3aed;color:#fff;margin-left:6px;">Live SPC</span>' : '';
        return `
          <article class="storm-area-card storm-area-card-clickable ${priority}" data-storm-report-url="${escapeHtml(sourceUrl)}" tabindex="0" role="button" aria-label="Open source for ${escapeHtml(report.eventType || 'storm report')}">
            <div class="storm-area-head">
              <span class="storm-area-pill ${priority}">${escapeHtml(kindLabel)}</span>${prelimBadge}
              <span class="storm-area-state">FL</span>
            </div>
            <h4>${escapeHtml(report.eventType || 'Storm report')} · ${escapeHtml(formatStormMagnitude(report))}</h4>
            <p>${escapeHtml(location || 'Florida')} — ${escapeHtml(narrative)}</p>
            <div class="storm-area-meta">
              <span><i class="fas fa-clock"></i> ${escapeHtml(formatDateTime(report.beginDate))}</span>
              <span><i class="fas fa-location-dot"></i> ${escapeHtml(report.county || 'Florida')}</span>
            </div>
            <div class="storm-area-actions">
              <span class="storm-area-source"><i class="fas fa-link"></i> ${escapeHtml(report.source || 'NOAA Storm Events')}</span>
              <a class="storm-area-open-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>
            </div>
          </article>
        `;
      }).join('');
      bindStormReportCards();
    }
  }

  if ($('stormLeadQueue')) {
    if (!countyBreakdown.length) {
      $('stormLeadQueue').innerHTML = '<div class="empty-state small"><i class="fas fa-map"></i><p>County rankings will appear once Florida reports finish loading.</p></div>';
    } else {
      $('stormLeadQueue').innerHTML = countyBreakdown.map((county, index) => `
        <article class="storm-lead-card">
          <div>
            <div class="storm-lead-top">
              <strong>${escapeHtml(county.county || 'Unknown County')}</strong>
              <span class="storm-priority-badge">#${index + 1}</span>
            </div>
            <p>${escapeHtml(String(county.total || 0))} total reports in the last 12 months</p>
            <small>${escapeHtml(String(county.hail || 0))} hail · ${escapeHtml(String(county.wind || 0))} wind 40+ mph</small>
          </div>
        </article>
      `).join('');
    }
  }

  const sourceList = document.querySelector('#view-map .storm-source-list');
  if (sourceList) {
    const latestCount = Array.isArray(stormIntel.monthlyBreakdown) && stormIntel.monthlyBreakdown.length
      ? stormIntel.monthlyBreakdown[stormIntel.monthlyBreakdown.length - 1].total || 0
      : 0;
    sourceList.innerHTML = `
      <div class="storm-source-card">
        <strong>Biggest hail</strong>
        <p>${escapeHtml(maxHail ? `${formatStormMagnitude(maxHail)} in ${maxHail.county}` : 'No Florida hail reports loaded yet.')}</p>
      </div>
      <div class="storm-source-card">
        <strong>Peak wind</strong>
        <p>${escapeHtml(maxWind ? `${formatStormMagnitude(maxWind)} in ${maxWind.county}` : 'No 40+ mph Florida wind reports loaded yet.')}</p>
      </div>
      <div class="storm-source-card">
        <strong>Latest month</strong>
        <p>${escapeHtml(`${latestCount} Florida reports in the most recent bucket.`)}</p>
      </div>
      <div class="storm-source-card">
        <strong>Full feed</strong>
        <p>${escapeHtml(`${reportsAll.length} Florida reports are available in the searchable board right now.`)}</p>
      </div>
      <div class="storm-source-card">
        <strong>Active FL alerts</strong>
        <p>${escapeHtml(String(alerts.length || 0))} live NOAA/NWS alerts currently active in Florida.</p>
      </div>
    `;
  }
}

async function loadStormIntel(force = false) {
  try {
    bindStormReportControls();
    const states = ['FL'];
    stormIntel.states = states;
    if (isMapModeActive()) renderMapMode();
    if (isStormMapActive()) renderStormCoverageMap();
    const res = await fetch('/.netlify/functions/storm-intel?states=FL');
    if (!res.ok) throw new Error('Storm feed request failed.');
    const data = await res.json();
    stormIntel = {
      alerts: Array.isArray(data.alerts) ? data.alerts : [],
      states: ['FL'],
      loadedAt: data.loadedAt || new Date().toISOString(),
      radarUpdatedAt: data.radarUpdatedAt || null,
      radarFrames: Number(data.radarFrames) || 0,
      severeReports: Array.isArray(data.severeReports) ? data.severeReports : [],
      summary: data.summary || null,
      countyBreakdown: Array.isArray(data.countyBreakdown) ? data.countyBreakdown : [],
      monthlyBreakdown: Array.isArray(data.monthlyBreakdown) ? data.monthlyBreakdown : []
    };
    lazyFeatureState.stormIntelLoaded = true;
    if (isMapModeActive()) renderMapMode();
    if (isStormMapActive()) renderStormCoverageMap();
    scheduleLeadOverlayGeocode();
    if (($('organizeBy')?.value || 'default') === 'county' && isViewActive('leads')) renderLeadsTable(allLeads, 'county');
  } catch (error) {
    console.error(error);
    stormIntel.loadedAt = new Date().toISOString();
    if (isMapModeActive()) renderMapMode();
    if (isStormMapActive()) renderStormCoverageMap();
  }
}

// ====== ROLE + ACCESS ======
function isSuperAdmin() {
  return currentUserRole === 'super_admin';
}

function isAdmin() {
  return currentUserRole === 'admin' || currentUserRole === 'super_admin';
}

function isPrivilegedRole(role) {
  return role === 'admin' || role === 'super_admin';
}

function getRoleLabel(role) {
  if (role === 'super_admin') return 'Super Admin';
  if (role === 'admin') return 'Admin';
  return 'Agent';
}

async function loadCurrentUserRole() {
  currentUserRole = 'agent';
  try {
    const { data, error } = await sb
      .from('crm_user_roles')
      .select('*')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    if (!error && data?.role && ['super_admin', 'admin', 'agent'].includes(data.role)) currentUserRole = data.role;
    syncRuntimeGlobals();
    updateAccessUi();
  } catch (err) {
    syncRuntimeGlobals();
    updateAccessUi();
  }
}

async function loadRoleDirectory() {
  try {
    const { data, error } = await sb.from('crm_user_roles').select('*');
    roleDirectory = error ? [] : (data || []);
    syncRuntimeGlobals();
    refreshTeamFilterOptions();
  } catch (err) {
    roleDirectory = [];
    syncRuntimeGlobals();
    refreshTeamFilterOptions();
  }
}

function updateAccessUi() {
  const roleLabel = getRoleLabel(currentUserRole);
  if ($('settingsRole')) $('settingsRole').textContent = roleLabel;
  if ($('userRoleBadge')) {
    $('userRoleBadge').textContent = roleLabel;
    $('userRoleBadge').classList.toggle('admin', isAdmin());
    $('userRoleBadge').classList.toggle('super-admin', isSuperAdmin());
  }
  if ($('adminNavItem')) $('adminNavItem').classList.toggle('hidden', !isSuperAdmin());
  if ($('contractsSetupNavItem')) $('contractsSetupNavItem').classList.toggle('hidden', !isSuperAdmin());
  if ($('partnerContractsNavItem')) $('partnerContractsNavItem').classList.toggle('hidden', !isAdmin());
  if ($('signedClientsNavItem')) $('signedClientsNavItem').classList.toggle('hidden', !isAdmin());
  if ($('view-agent-admin')) $('view-agent-admin').classList.toggle('hidden', !isSuperAdmin());
  if ($('view-partner-contracts')) $('view-partner-contracts').classList.toggle('hidden', !isAdmin());
  if ($('view-signed-clients')) $('view-signed-clients').classList.toggle('hidden', !isAdmin());
  const activeView = document.querySelector('.nav-item.active')?.dataset.view || '';
  if ((!isSuperAdmin() && activeView === 'agent-admin') || (!isAdmin() && ['partner-contracts', 'signed-clients'].includes(activeView))) {
    showView('overview');
  }
  if ($('overviewIntro')) $('overviewIntro').textContent = isSuperAdmin()
    ? 'Super admin view — partner oversight, signed clients, shared leads, and full team activity.'
    : isAdmin()
      ? 'Admin view — shared leads and appointments plus total funnel performance across the full team.'
      : 'Your personal overview — only your call log and funnel, while leads and appointments stay shared across the team.';
  if ($('recentCallsTitle')) $('recentCallsTitle').innerHTML = isAdmin()
    ? '<i class="fas fa-history"></i> Team Call Activity'
    : '<i class="fas fa-history"></i> Your Recent Call Activity';
  if ($('callLogIntro')) $('callLogIntro').textContent = isAdmin()
    ? 'Admin call log — every call attempt across all agents.'
    : 'Your personal call log — shared leads and appointments remain visible to everyone.';
}

function findRoleRow(userId) {
  return roleDirectory.find(row => row.user_id === userId)
    || managedAgents.find(agent => (agent.id || agent.user_id) === userId)
    || null;
}

function getAgentDisplayName(userId) {
  if (!userId) return 'Unassigned';
  const roleRow = findRoleRow(userId);
  if (roleRow?.display_name) return roleRow.display_name;
  if (roleRow?.email) return roleRow.email.split('@')[0];
  if (currentUser?.id === userId) return (currentUser.email || 'agent').split('@')[0];
  return 'Agent ' + String(userId).slice(0, 8);
}

function normalizeTeamLabel(teamLabel, fallback = 'Unassigned') {
  const rawValue = String(teamLabel || '').trim();
  const value = TEAM_LABEL_ALIASES[rawValue] || rawValue;
  if (TEAM_LABEL_OPTIONS.includes(value)) return value;
  return fallback;
}

function normalizeIdentityText(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function inferHardcodedTeamLabel(...values) {
  const haystack = values.map(normalizeIdentityText).filter(Boolean).join(' ');
  if (!haystack) return '';
  for (const [teamLabel, matchers] of Object.entries(HARDCODED_TEAM_MATCHERS)) {
    if ((matchers || []).some(matcher => haystack.includes(normalizeIdentityText(matcher)))) return teamLabel;
  }
  return '';
}

function getManagedAgentTeamLabel(agent, fallback = 'Unassigned') {
  if (!agent) return fallback;
  const direct = normalizeTeamLabel(agent.team_label, '');
  if (direct) return direct;
  return normalizeTeamLabel(inferHardcodedTeamLabel(agent.display_name, agent.email), fallback);
}

function getAgentTeamLabel(userId, fallback = 'Unassigned') {
  if (!userId) return fallback;
  const roleRow = findRoleRow(userId);
  const direct = normalizeTeamLabel(roleRow?.team_label, '');
  if (direct) return direct;
  return normalizeTeamLabel(inferHardcodedTeamLabel(roleRow?.display_name, roleRow?.email, getAgentDisplayName(userId)), fallback);
}

function getAvailableTeamLabels() {
  const labels = new Set(TEAM_LABEL_OPTIONS);
  roleDirectory.forEach(row => {
    const value = normalizeTeamLabel(row?.team_label, '');
    if (value) labels.add(value);
    const inferred = inferHardcodedTeamLabel(row?.display_name, row?.email);
    if (inferred) labels.add(inferred);
  });
  managedAgents.forEach(agent => {
    const inferred = getManagedAgentTeamLabel(agent, '');
    if (inferred) labels.add(inferred);
  });
  labels.add('Unassigned');
  return [...labels];
}

function getAssignableAppointmentAgents(selectedAgentId = '') {
  const agentMap = new Map();
  const addAgent = (userId, displayName = '', email = '', teamLabel = '') => {
    if (!userId || agentMap.has(userId)) return;
    const safeDisplay = displayName || (email ? email.split('@')[0] : `Agent ${String(userId).slice(0, 8)}`);
    const resolvedTeam = normalizeTeamLabel(teamLabel, '') || normalizeTeamLabel(inferHardcodedTeamLabel(displayName, email), '') || 'Unassigned';
    agentMap.set(userId, {
      id: userId,
      display_name: safeDisplay,
      email: email || '',
      team_label: resolvedTeam
    });
  };

  if (currentUser?.id) {
    addAgent(currentUser.id, getAgentDisplayName(currentUser.id), currentUser.email || '', getAgentTeamLabel(currentUser.id, ''));
  }
  roleDirectory.forEach(row => addAgent(row.user_id, row.display_name, row.email, row.team_label));
  managedAgents.forEach(agent => addAgent(agent.id || agent.user_id, agent.display_name, agent.email, agent.team_label || getManagedAgentTeamLabel(agent, '')));

  if (selectedAgentId && !agentMap.has(selectedAgentId)) {
    const selectedRow = findRoleRow(selectedAgentId);
    addAgent(selectedAgentId, getAgentDisplayName(selectedAgentId), selectedRow?.email || '', getAgentTeamLabel(selectedAgentId, ''));
  }

  return [...agentMap.values()].sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }));
}

function updateAppointmentAgentTeamPreview() {
  const preview = $('af_team_preview');
  if (!preview) return;
  const selectedAgentId = $('af_agent')?.value || '';
  preview.value = selectedAgentId ? getAgentTeamLabel(selectedAgentId) : 'Unassigned';
}

function renderAppointmentAgentOptions(selectedAgentId = '') {
  const select = $('af_agent');
  if (!select) return;
  const agents = getAssignableAppointmentAgents(selectedAgentId);
  const currentValue = selectedAgentId || select.value || (!isAdmin() ? (currentUser?.id || '') : '');
  select.innerHTML = ['<option value="">Unassigned</option>']
    .concat(agents.map(agent => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.display_name)}${agent.email ? ' · ' + escapeHtml(agent.email) : ''}</option>`))
    .join('');
  select.value = agents.some(agent => agent.id === currentValue) ? currentValue : '';
  if (!select.value && !isAdmin() && currentUser?.id) select.value = currentUser.id;
  updateAppointmentAgentTeamPreview();
}

function renderTeamBadge(teamLabel) {
  const label = normalizeTeamLabel(teamLabel);
  const cssClass = label === 'Chay Team' ? 'status-Lost' : label === "Mike's Team" ? 'status-Signed' : 'status-New';
  return `<span class="status-pill ${cssClass}">${escapeHtml(label)}</span>`;
}

function refreshTeamFilterOptions() {
  const teamLabels = getAvailableTeamLabels();
  ['callTeamFilter', 'apptTeamFilter', 'adminOverviewTeamFilter', 'agentTeamLabel'].forEach(id => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    const includeBlank = id === 'agentTeamLabel';
    const blankLabel = includeBlank ? 'Unassigned' : 'All Teams';
    const options = [`<option value="">${blankLabel}</option>`]
      .concat(teamLabels.filter(label => label !== 'Unassigned').map(label => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`));
    if (!includeBlank) options.push('<option value="Unassigned">Unassigned</option>');
    select.innerHTML = options.join('');
    if ([...select.options].some(option => option.value === current)) {
      select.value = current;
    }
  });
}

function callMatchesTeam(call, teamFilter = '') {
  if (!teamFilter) return true;
  return getAgentTeamLabel(call?.agent_id) === teamFilter;
}

function apptMatchesTeam(appt, teamFilter = '') {
  if (!teamFilter) return true;
  return getAgentTeamLabel(appt?.agent_id) === teamFilter;
}

async function ensureLeadFilterOptionsLoaded(force = false) {
  if (!force && lazyFeatureState.leadFiltersLoaded) return;
  if (leadFilterLoadPromise && !force) return leadFilterLoadPromise;
  leadFilterLoadPromise = loadLeadFilterOptions(force)
    .catch((error) => { throw error; })
    .finally(() => { leadFilterLoadPromise = null; });
  return leadFilterLoadPromise;
}

async function ensureMessagesDataLoaded(options = {}, force = false) {
  if (!force && lazyFeatureState.messagesLoaded) return;
  if (messagesLoadPromise && !force) return messagesLoadPromise;
  messagesLoadPromise = loadMessagesData(options)
    .then(() => {
      lazyFeatureState.messagesLoaded = true;
      initMessageRealtime();
    })
    .catch((error) => { throw error; })
    .finally(() => { messagesLoadPromise = null; });
  return messagesLoadPromise;
}

async function ensureTrainingProgressLoaded(force = false) {
  if (!force && lazyFeatureState.trainingLoaded) return;
  if (trainingLoadPromise && !force) return trainingLoadPromise;
  trainingLoadPromise = loadTrainingProgress()
    .then(() => { lazyFeatureState.trainingLoaded = true; })
    .catch((error) => { throw error; })
    .finally(() => { trainingLoadPromise = null; });
  return trainingLoadPromise;
}

async function ensureStormIntelLoaded(force = false) {
  if (!force && lazyFeatureState.stormIntelLoaded && Array.isArray(stormIntel.severeReports) && stormIntel.severeReports.length) return;
  if (stormIntelLoadPromise && !force) return stormIntelLoadPromise;
  stormIntelLoadPromise = loadStormIntel(force)
    .then(() => { lazyFeatureState.stormIntelLoaded = true; })
    .catch((error) => { throw error; })
    .finally(() => { stormIntelLoadPromise = null; });
  return stormIntelLoadPromise;
}

// ====== LOAD DATA ======
async function loadAll() {
  await Promise.all([loadRoleDirectory(), loadCalls(), loadAppts(), loadLeadCount()]);
  rebuildLeadIndexes();
  await ensureLeadCacheForIds([
    ...allCalls.map(call => call.lead_id),
    ...allAppts.map(appt => appt.lead_id)
  ]);

  if (!isAdmin()) {
    managedAgents = [];
    renderManagedAgents();
  }

  await loadLeadsPage(currentLeadPage);
  renderCallsTable(getFilteredCalls());
  renderAppointments();
  renderOverview();
  scheduleDashboardWarmup();
}

function updateLeadHeaderCount() {
  if ($('leadTotalChip')) $('leadTotalChip').textContent = `${totalLeadCount || 0} total`;
}

async function loadLeadCount() {
  const { count, error } = await sb
    .from('crm_leads')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  totalLeadCount = count || 0;
  updateLeadHeaderCount();
}

async function loadLeadFilterOptions(force = false) {
  try {
    const batchSize = 1000;
    const rows = [];
    let offset = 0;

    while (true) {
      const { data, error } = await sb
        .from('crm_leads')
        .select('id, contact_name, phone, email, city, state, zip, address, county, damage_type, status, source, notes, created_at')
        .order('id', { ascending: true })
        .range(offset, offset + batchSize - 1);
      if (error) throw error;
      const batch = data || [];
      if (!batch.length) break;
      rows.push(...batch);
      offset += batch.length;
      if (batch.length < batchSize) break;
    }

    crmLeadOverlayScanCount = rows.length;
    cacheLeads(rows);
    leadStateOptions = [...new Set(rows.map(row => String(row.state || '').trim()).filter(Boolean))];
    populateLocationFilters();
    populateCountyFilterOptions(rows);
    lazyFeatureState.leadFiltersLoaded = true;
  } catch (error) {
    crmLeadOverlayScanCount = leadCache.size || 0;
    leadStateOptions = [];
    populateLocationFilters();
    populateCountyFilterOptions();
    lazyFeatureState.leadFiltersLoaded = false;
  }
}

function cacheLeads(leads) {
  (leads || []).forEach(lead => {
    if (lead?.id) leadCache.set(lead.id, { ...(leadCache.get(lead.id) || {}), ...lead });
  });
}

function getLeadCached(id) {
  if (!id) return null;
  return leadCache.get(id) || allLeads.find(lead => lead.id === id) || null;
}

async function fetchLeadById(id) {
  if (!id) return null;
  const existing = getLeadCached(id);
  if (existing) return existing;
  const { data, error } = await sb
    .from('crm_leads')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return null;
  if (data) cacheLeads([data]);
  return data || null;
}

async function ensureLeadCacheForIds(ids) {
  const missing = [...new Set((ids || []).filter(Boolean))].filter(id => !leadCache.has(id));
  const chunkSize = 200;

  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    const { data, error } = await sb
      .from('crm_leads')
      .select('id, contact_name, phone, email, city, state, zip, address, damage_type, status, source, notes, created_at')
      .in('id', chunk);
    if (!error) cacheLeads(data || []);
  }
}

function rebuildLeadIndexes() {
  leadCallsMap = new Map();
  leadLastCallMap = new Map();

  allCalls.forEach(call => {
    if (!call?.lead_id) return;
    const list = leadCallsMap.get(call.lead_id) || [];
    list.push(call);
    leadCallsMap.set(call.lead_id, list);
    if (!leadLastCallMap.has(call.lead_id)) {
      leadLastCallMap.set(call.lead_id, call);
    }
  });
}

function buildLeadPageQuery() {
  let query = sb.from('crm_leads').select('*', { count: 'exact' });
  const useClientLeadFiltering = shouldUseClientLeadLocationFiltering();
  const serverSearch = ($('searchInput')?.value?.trim() || '')
    .replace(/[,%()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (serverSearch && !useClientLeadFiltering) {
    query = query.or(`contact_name.ilike.%${serverSearch}%,phone.ilike.%${serverSearch}%,email.ilike.%${serverSearch}%,city.ilike.%${serverSearch}%,state.ilike.%${serverSearch}%,zip.ilike.%${serverSearch}%,address.ilike.%${serverSearch}%`);
  }

  const state = $('stateFilter')?.value || '';
  const status = $('statusFilter')?.value || '';
  const damage = $('damageFilter')?.value || '';
  if (state) query = query.eq('state', state);
  if (status) query = query.eq('status', status);
  if (damage) query = query.eq('damage_type', damage);

  const organizeMode = $('organizeBy')?.value || 'default';
  if (organizeMode === 'state') {
    query = query.order('state', { ascending: true }).order('city', { ascending: true }).order('created_at', { ascending: false });
  } else if (organizeMode === 'city') {
    query = query.order('city', { ascending: true }).order('state', { ascending: true }).order('created_at', { ascending: false });
  } else if (organizeMode === 'county') {
    query = query.order('state', { ascending: true }).order('city', { ascending: true }).order('zip', { ascending: true }).order('contact_name', { ascending: true }).order('created_at', { ascending: false });
  } else if (organizeMode === 'state_city') {
    query = query.order('state', { ascending: true }).order('city', { ascending: true }).order('contact_name', { ascending: true }).order('created_at', { ascending: false });
  } else {
    query = query.order('created_at', { ascending: false });
  }

  return query;
}

async function loadLeadsPage(page = 1) {
  currentLeadPage = Math.max(1, page);
  const from = (currentLeadPage - 1) * leadPageSize;
  const to = from + leadPageSize - 1;

  try {
    const query = buildLeadPageQuery();
    let visibleRows = [];
    if (shouldUseClientLeadLocationFiltering()) {
      const maxClientRows = Math.min(Math.max(totalLeadCount || 0, leadPageSize * 20), 2000);
      const { data, error } = await query.range(0, Math.max(0, maxClientRows - 1));
      if (error) throw error;
      const broadRows = data || [];
      cacheLeads(broadRows);
      populateCountyFilterOptions(broadRows);
      const filteredRows = filterLeadsClientSide(broadRows);
      filteredLeadCount = filteredRows.length;
      visibleRows = filteredRows.slice(from, to + 1);
      allLeads = visibleRows;
    } else {
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      filteredLeadCount = count || 0;
      visibleRows = data || [];
      allLeads = visibleRows;
      cacheLeads(allLeads);
      populateCountyFilterOptions(allLeads);
    }
    renderLeadsTable(visibleRows, $('organizeBy')?.value || 'default');
    renderLeadPagination();
    if (isStormMapActive()) {
      renderStormCoverageMap();
      scheduleLeadOverlayGeocode();
    }
  } catch (error) {
    filteredLeadCount = 0;
    allLeads = [];
    showTableError('leadsTableBody', 10, error.message);
    renderLeadPagination();
    if (isStormMapActive()) {
      renderStormCoverageMap();
      renderStormLeadOverlayStatus();
    }
  }
}

function renderLeadPagination() {
  const totalPages = Math.max(1, Math.ceil((filteredLeadCount || 0) / leadPageSize) || 1);
  if (currentLeadPage > totalPages) currentLeadPage = totalPages;

  const start = filteredLeadCount ? ((currentLeadPage - 1) * leadPageSize) + 1 : 0;
  const end = filteredLeadCount ? Math.min(filteredLeadCount, currentLeadPage * leadPageSize) : 0;
  updateLeadHeaderCount();
  if ($('leadPaginationMeta')) {
    $('leadPaginationMeta').textContent = filteredLeadCount
      ? `Showing ${start}-${end} of ${filteredLeadCount} matching leads · ${totalLeadCount} total in CRM`
      : `No matching leads · ${totalLeadCount} total in CRM`;
  }
  if ($('leadPageLabel')) $('leadPageLabel').textContent = `Page ${currentLeadPage} / ${totalPages}`;
  if ($('leadPrevPageBtn')) $('leadPrevPageBtn').disabled = currentLeadPage <= 1;
  if ($('leadNextPageBtn')) $('leadNextPageBtn').disabled = currentLeadPage >= totalPages;
}

async function loadCalls() {
  const batchSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    let query = sb
      .from('crm_call_attempts')
      .select('*');
    if (!isAdmin()) query = query.eq('agent_id', currentUser.id);

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + batchSize - 1);

    if (error) {
      showTableError('callsTableBody', 10, error.message);
      return;
    }

    const batch = data || [];
    if (!batch.length) break;
    rows.push(...batch);
    offset += batch.length;
    if (batch.length < batchSize) break;
  }

  allCalls = rows;
}

async function loadAppts() {
  const batchSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await sb
      .from('crm_appointments')
      .select('*')
      .order('scheduled_for', { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      showTableError('apptsTableBody', 9, error.message);
      return;
    }

    const batch = data || [];
    if (!batch.length) break;
    rows.push(...batch);
    offset += batch.length;
    if (batch.length < batchSize) break;
  }

  allAppts = rows;
}

function showTableError(tbodyId, cols, msg) {
  const tbody = $(tbodyId);
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="loading-row">⚠️ ${escapeHtml(msg)}<br><small style="color:#888">Run dashboard/supabase_schema.sql in Supabase → SQL Editor to create the required tables.</small></td></tr>`;
  }
}

// ====== OVERVIEW (stats + funnel) ======
function renderOverview() {
  renderAdminOverview();
  const today = new Date();
  today.setHours(0,0,0,0);
  const callsToday = allCalls.filter(c => new Date(c.created_at) >= today);

  const totalCalls = allCalls.length;
  const answered = allCalls.filter(c => c.answered).length;
  const presented = allCalls.filter(c => c.allowed_presentation).length;
  const booked = allCalls.filter(c => c.appointment_booked).length;

  $('statCallsToday').textContent = callsToday.length;
  $('statAnswered').textContent = answered;
  $('statPresentations').textContent = presented;
  $('statBooked').textContent = booked;

  const max = Math.max(totalCalls, 1);
  setFunnelStage('funnelCalls', 'Total Calls', totalCalls, 100);
  setFunnelStage('funnelAnswered', 'Answered', answered, (answered / max) * 100);
  setFunnelStage('funnelPres', 'Allowed Presentation', presented, (presented / max) * 100);
  setFunnelStage('funnelBooked', 'Appointments Booked', booked, (booked / max) * 100);

  $('rateAnswer').textContent = totalCalls ? Math.round(answered / totalCalls * 100) + '%' : '—';
  $('ratePitch').textContent = answered ? Math.round(presented / answered * 100) + '%' : '—';
  $('rateBook').textContent = presented ? Math.round(booked / presented * 100) + '%' : '—';

  const teamSplit = $('teamSplitSummary');
  if (teamSplit) {
    const parts = getAvailableTeamLabels().map(label => {
      const calls = allCalls.filter(call => getAgentTeamLabel(call.agent_id) === label).length;
      const bookedCalls = allCalls.filter(call => getAgentTeamLabel(call.agent_id) === label && call.appointment_booked).length;
      if (!calls && !bookedCalls) return '';
      return `${escapeHtml(label)}: ${calls} calls · ${bookedCalls} booked`;
    }).filter(Boolean);
    teamSplit.innerHTML = parts.length ? `Team split · ${parts.join(' · ')}` : 'Team split will appear here once agents are labeled.';
  }

  const list = $('recentCallsList');
  const recent = allCalls.slice(0, 6);
  if (!recent.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-phone"></i><p>No calls logged yet. Click any lead → "Log a Call" to start.</p></div>';
    return;
  }
  list.innerHTML = recent.map(c => {
    const lead = getLeadCached(c.lead_id);
    const name = lead ? (lead.contact_name || 'Unnamed') : '—';
    const flags = [
      c.answered ? '<span class="ch-flag yes">📞 Answered</span>' : '<span class="ch-flag no">No answer</span>',
      c.allowed_presentation ? '<span class="ch-flag yes">🎤 Presented</span>' : '',
      c.appointment_booked ? '<span class="ch-flag yes">📅 Booked</span>' : '',
      renderTeamBadge(getAgentTeamLabel(c.agent_id))
    ].filter(Boolean).join(' ');
    return `<div class="recent-item">
      <div class="recent-item-info">
        <span class="recent-item-name">${escapeHtml(name)}</span>
        <span class="recent-item-meta">${formatDate(c.created_at)} · ${escapeHtml(c.call_outcome || '—')} · ${escapeHtml(getAgentDisplayName(c.agent_id))}</span>
      </div>
      <div class="ch-flags">${flags}</div>
    </div>`;
  }).join('');
}

function renderAdminOverview() {
  const panel = $('adminOverviewPanel');
  if (!panel) return;
  if (!isAdmin()) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  const teamFilter = $('adminOverviewTeamFilter')?.value || '';
  const filteredCalls = teamFilter ? allCalls.filter(call => callMatchesTeam(call, teamFilter)) : allCalls;
  const filteredAppts = teamFilter ? allAppts.filter(appt => apptMatchesTeam(appt, teamFilter)) : allAppts;

  const callsByAgent = new Map();
  roleDirectory
    .filter(row => row.role !== 'super_admin')
    .filter(row => !teamFilter || getAgentTeamLabel(row.user_id) === teamFilter)
    .forEach(row => callsByAgent.set(row.user_id, {
      userId: row.user_id,
      teamLabel: getAgentTeamLabel(row.user_id),
      calls: 0,
      answered: 0,
      presented: 0,
      booked: 0
    }));

  filteredCalls.forEach(call => {
    const key = call.agent_id || 'unassigned';
    if (!callsByAgent.has(key)) {
      callsByAgent.set(key, { userId: key, teamLabel: getAgentTeamLabel(key), calls: 0, answered: 0, presented: 0, booked: 0 });
    }
    const row = callsByAgent.get(key);
    row.calls += 1;
    if (call.answered) row.answered += 1;
    if (call.allowed_presentation) row.presented += 1;
    if (call.appointment_booked) row.booked += 1;
  });

  const metrics = [...callsByAgent.values()].sort((a, b) => b.calls - a.calls || b.booked - a.booked);
  $('adminTotalAgents').textContent = String(metrics.length || 0);
  $('adminSharedLeads').textContent = String(totalLeadCount || 0);
  $('adminTotalCalls').textContent = String(filteredCalls.length || 0);
  $('adminTotalAppointments').textContent = String(filteredAppts.length || 0);

  const tbody = $('agentMetricsBody');
  if (!metrics.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="loading-row">No agent call activity yet for this team filter.</td></tr>';
    return;
  }

  tbody.innerHTML = metrics.map(row => {
    const answerRate = row.calls ? Math.round((row.answered / row.calls) * 100) : 0;
    const pitchRate = row.answered ? Math.round((row.presented / row.answered) * 100) : 0;
    const bookRate = row.presented ? Math.round((row.booked / row.presented) * 100) : 0;
    return `<tr>
      <td><strong>${escapeHtml(getAgentDisplayName(row.userId))}</strong></td>
      <td>${renderTeamBadge(row.teamLabel)}</td>
      <td>${row.calls}</td>
      <td>${row.answered}</td>
      <td>${row.presented}</td>
      <td>${row.booked}</td>
      <td>${answerRate}%</td>
      <td>${pitchRate}%</td>
      <td>${bookRate}%</td>
    </tr>`;
  }).join('');
}

function setFunnelStage(id, label, num, widthPct) {
  const stage = $(id);
  if (!stage) return;
  const bar = stage.querySelector('.funnel-bar');
  bar.style.setProperty('--w', Math.max(widthPct, 18) + '%');
  bar.querySelector('.funnel-num').textContent = num;
  bar.querySelector('.funnel-label').textContent = label;
}

// ====== LEADS TABLE ======
// Trigger a Quo call directly from the leads page.
// Switches to Call Command tab, opens post-call modal, launches Quo.
function callLeadFromLeads(leadOrId, options = {}) {
  const lead = typeof leadOrId === 'object' && leadOrId ? leadOrId : getLeadCached(leadOrId);
  if (!lead?.phone) {
    alert('This lead has no phone number on file.');
    return false;
  }
  // 1. Switch to Call Command tab
  showView('dialer');
  // 2. Make sure the Call Command code is initialized
  window.loadDialerViewData?.({ force: false });
  // 3. Trigger the dialer call flow (opens Quo + post-call modal)
  setTimeout(() => {
    if (typeof window.callCommandInitiateCall === 'function') {
      window.callCommandInitiateCall(
        lead.id || '',
        lead.phone,
        lead.contact_name || lead.phone
      );
    } else {
      console.warn('Call Command not ready yet');
      alert('Call Command is loading. Try clicking Call again in a moment.');
    }
  }, 250);
  return true;
}

// Legacy alias kept for any other code that referenced the old name.
function openDialerForLead(leadOrId, options = {}) {
  return callLeadFromLeads(leadOrId, options);
}

function renderLeadsTable(leads, organizeMode = 'default') {
  bindLeadTableSortControls();
  updateLeadTableSortUi();
  const tbody = $('leadsTableBody');
  if (!leads.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No leads match your current filters.</td></tr>';
    return;
  }

  const sortedLeads = [...leads].sort((a, b) => sortLeadRows(a, b, organizeMode));
  let html = '';
  let previousGroup = null;
  sortedLeads.forEach(l => {
    const groupLabel = getLeadGroupLabel(l, organizeMode);
    if (groupLabel && groupLabel !== previousGroup) {
      html += `<tr class="lead-group-row"><td colspan="10"><span class="lead-group-badge">${escapeHtml(groupLabel)}</span></td></tr>`;
      previousGroup = groupLabel;
    }
    const callsForLead = leadCallsMap.get(l.id) || [];
    const lastCall = leadLastCallMap.get(l.id) || null;
    const locationLine = [l.city, l.state].filter(Boolean).join(', ');
    const zipLine = l.zip ? ` · ${escapeHtml(l.zip)}` : '';
    const countyLabel = getLeadCountyLabel(l);
    html += `
      <tr data-id="${l.id}">
        <td><strong>${escapeHtml(l.contact_name || '—')}</strong></td>
        <td>${escapeHtml(l.phone || '—')}</td>
        <td>${escapeHtml(l.email || '—')}</td>
        <td>${escapeHtml(locationLine || l.address || '—')}${zipLine}</td>
        <td>${escapeHtml(countyLabel)}</td>
        <td>${escapeHtml(l.damage_type || '—')}</td>
        <td><span class="status-pill status-${(l.status || 'New').replace(/\s+/g,'')}">${escapeHtml(l.status || 'New')}</span></td>
        <td>${callsForLead.length}</td>
        <td>${lastCall ? formatDate(lastCall.created_at) : '—'}</td>
        <td>
          <button class="btn-view" data-action="edit" data-id="${l.id}">View</button>
          <button class="btn-call-quo" data-action="call-quo" data-id="${l.id}" title="Call this lead through Quo (auto-opens Call Command tab)"><i class="fas fa-phone-volume"></i> Call</button>
          <button class="btn-log-call" data-action="log" data-id="${l.id}" title="Log a manual call (no Quo dial)"><i class="fas fa-pen"></i> Log</button>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
  tbody.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'edit') openLeadModal(id);
      else if (action === 'call-quo') {
        callLeadFromLeads(id);
      }
      else if (action === 'log') {
        openCallModal(id);
      }
      else if (action === 'call') {
        // Backwards-compat: legacy 'call' = quo call
        callLeadFromLeads(id);
      }
    });
  });
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => openLeadModal(tr.dataset.id));
  });
}

function getLeadCountyLabel(lead = {}) {
  const derivedCounty = normalizeStormCounty(lead.county || getCachedLeadCoords(lead)?.county || '');
  return derivedCounty || 'No County';
}

function getLeadGroupLabel(lead, mode) {
  if (mode === 'state') return lead.state || 'No State';
  if (mode === 'city') return lead.city || 'No City';
  if (mode === 'county') return getLeadCountyLabel(lead);
  if (mode === 'state_city') {
    const state = lead.state || 'No State';
    const city = lead.city || 'No City';
    return `${state} → ${city}`;
  }
  return null;
}

function bindLeadTableSortControls() {
  const countyHeader = $('leadCountyHeader');
  if (!countyHeader || countyHeader.dataset.boundSort === '1') return;
  countyHeader.dataset.boundSort = '1';
  countyHeader.addEventListener('click', () => {
    const key = countyHeader.dataset.sortKey || 'county';
    if (leadTableSort.key === key) {
      leadTableSort.direction = leadTableSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      leadTableSort = { key, direction: 'asc' };
    }
    updateLeadTableSortUi();
    loadLeadsPage(1);
  });
}

function updateLeadTableSortUi() {
  const countyHeader = $('leadCountyHeader');
  const countyIndicator = $('leadCountySortIndicator');
  if (!countyHeader || !countyIndicator) return;
  const isActive = leadTableSort.key === 'county';
  countyHeader.classList.toggle('active', isActive);
  countyHeader.setAttribute('aria-sort', isActive ? (leadTableSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  countyIndicator.textContent = !isActive ? '↕' : (leadTableSort.direction === 'asc' ? '↑' : '↓');
}

function compareLeadSortValue(a, b, key) {
  if (key === 'county') {
    return compareText(getLeadCountyLabel(a), getLeadCountyLabel(b))
      || compareText(a.state, b.state)
      || compareText(a.city, b.city)
      || compareText(a.contact_name, b.contact_name);
  }
  return 0;
}

function sortLeadRows(a, b, organizeMode) {
  const customSort = leadTableSort.key ? compareLeadSortValue(a, b, leadTableSort.key) : 0;
  if (customSort) return leadTableSort.direction === 'desc' ? -customSort : customSort;
  return sortLeadsByMode(a, b, organizeMode);
}

function populateLocationFilters() {
  const stateFilter = $('stateFilter');
  if (!stateFilter) return;
  const previous = stateFilter.value;
  const states = [...new Set(leadStateOptions)].sort((a, b) => a.localeCompare(b));
  stateFilter.innerHTML = '<option value="">All States</option>' + states.map(state => `<option value="${escapeHtml(state)}">${escapeHtml(state)}</option>`).join('');
  if (states.includes(previous)) stateFilter.value = previous;
}

function getLeadCountyToken(lead = {}) {
  return normalizeLocationToken(getLeadCountyLabel(lead));
}

function populateCountyFilterOptions(leads = []) {
  const countyFilter = $('countyFilter');
  if (!countyFilter) return;
  const previous = countyFilter.value;
  const countyMap = new Map();
  [...(leads || []), ...allLeads, ...leadCache.values()].forEach((lead) => {
    const label = getLeadCountyLabel(lead);
    if (!label || label === 'No County') return;
    const key = normalizeLocationToken(label);
    if (!key || countyMap.has(key)) return;
    countyMap.set(key, label);
  });
  const counties = [...countyMap.values()].sort((a, b) => a.localeCompare(b));
  leadCountyOptions = counties;
  countyFilter.innerHTML = '<option value="">All Counties</option>' + counties.map(county => `<option value="${escapeHtml(county)}">${escapeHtml(county)}</option>`).join('');
  countyFilter.value = counties.includes(previous) ? previous : '';
}

function isCountySearchTerm(value = '') {
  const normalized = normalizeLocationToken(value);
  if (!normalized) return false;
  if (normalized.includes(' county')) return true;
  return (leadCountyOptions || []).some((county) => {
    const countyToken = normalizeLocationToken(county);
    return countyToken && (countyToken.includes(normalized) || normalized.includes(countyToken));
  });
}

function shouldUseClientLeadLocationFiltering() {
  return Boolean(
    String($('locationSearch')?.value || '').trim()
    || String($('countyFilter')?.value || '').trim()
    || isCountySearchTerm($('searchInput')?.value || '')
  );
}

function getLeadSearchHaystack(lead = {}) {
  return normalizeLocationToken([
    lead.contact_name,
    lead.phone,
    lead.email,
    lead.city,
    lead.state,
    lead.zip,
    lead.address,
    lead.damage_type,
    lead.status,
    lead.source,
    getLeadCountyLabel(lead)
  ].filter(Boolean).join(' '));
}

function getLeadLocationHaystack(lead = {}) {
  const coords = getCachedLeadCoords(lead);
  return normalizeLocationToken([
    lead.address,
    lead.city,
    lead.state,
    lead.zip,
    lead.county,
    coords?.label,
    coords?.county
  ].filter(Boolean).join(' '));
}

function filterLeadsClientSide(leads = []) {
  const search = normalizeLocationToken($('searchInput')?.value || '');
  const location = normalizeLocationToken($('locationSearch')?.value || '');
  const state = String($('stateFilter')?.value || '').trim().toUpperCase();
  const county = normalizeLocationToken($('countyFilter')?.value || '');
  const status = String($('statusFilter')?.value || '').trim();
  const damage = String($('damageFilter')?.value || '').trim();

  return (leads || []).filter((lead) => {
    if (state && normalizeStormState(lead.state) !== state) return false;
    if (county && getLeadCountyToken(lead) !== county) return false;
    if (status && String(lead.status || '').trim() !== status) return false;
    if (damage && String(lead.damage_type || '').trim() !== damage) return false;
    if (search && !getLeadSearchHaystack(lead).includes(search)) return false;
    if (location && !getLeadLocationHaystack(lead).includes(location)) return false;
    return true;
  });
}

function extractCallSessionIdFromNotes(notesValue = '') {
  const match = String(notesValue || '').match(/\[\[CALL_SESSION:([0-9a-f-]{36})\]\]/i);
  return match ? match[1] : null;
}

function stripCallSessionMeta(notesValue = '') {
  return String(notesValue || '')
    .replace(/\s*\[\[CALL_SESSION:[0-9a-f-]{36}\]\]\s*/ig, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function composeCallNotesWithSessionId(notesValue = '', sessionId = null) {
  const cleanNotes = stripCallSessionMeta(notesValue);
  const cleanSessionId = /^[0-9a-f-]{36}$/i.test(String(sessionId || '').trim()) ? String(sessionId).trim() : '';
  if (!cleanSessionId) return cleanNotes || null;
  return cleanNotes ? `${cleanNotes}\n\n[[CALL_SESSION:${cleanSessionId}]]` : `[[CALL_SESSION:${cleanSessionId}]]`;
}

async function loadLeadForCallMedia(leadId) {
  if (!leadId) return null;
  const cached = getLeadCached(leadId);
  if (cached) return cached;
  try {
    const { data, error } = await sb
      .from('crm_leads')
      .select('id, contact_name, phone, email')
      .eq('id', leadId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (error) {
    console.warn('loadLeadForCallMedia failed:', error?.message || error);
    return null;
  }
}

function scoreCallSessionCandidate(row, context = {}) {
  const rowTime = new Date(row?.created_at || 0).getTime();
  const deltaMinutes = Number.isFinite(context.targetTime) && Number.isFinite(rowTime)
    ? Math.abs(rowTime - context.targetTime) / 60000
    : Number.POSITIVE_INFINITY;
  const rowLeadId = String(row?.lead_id || '');
  const rowToDigits = normalizePhone(row?.to_number || '');
  const rowFromDigits = normalizePhone(row?.from_number || '');
  const sameLead = !!(context.leadId && rowLeadId && rowLeadId === context.leadId);
  const samePhone = !!(context.phoneDigits && (rowToDigits === context.phoneDigits || rowFromDigits === context.phoneDigits));
  const sameAgent = !!(context.agentEmail && String(row?.agent_email || '').trim().toLowerCase() === context.agentEmail);
  let score = 0;

  if (context.explicitSessionId && String(row?.id || '') === context.explicitSessionId) score += 1000;
  if (sameLead) score += 220;
  if (samePhone) score += 170;
  if (sameAgent) score += 25;
  if (typeof context.answered === 'boolean' && typeof row?.answered === 'boolean' && row.answered === context.answered) score += 8;

  if (deltaMinutes <= 5) score += 70;
  else if (deltaMinutes <= 30) score += 55;
  else if (deltaMinutes <= 120) score += 20;

  return {
    score,
    deltaMinutes,
    sameLead,
    samePhone,
    sameAgent
  };
}

function renderCallMediaPanel(session = null) {
  const wrap = $('callMediaWrap');
  const body = $('callMediaBody');
  if (!wrap || !body) return;
  if (!session || (!session.recording_url && !session.ai_summary && !session.ai_transcript)) {
    wrap.classList.add('hidden');
    body.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  body.innerHTML = `
    ${session.recording_url ? `<div><div style="font-weight:700;margin-bottom:6px;">Recording</div><audio controls src="${escapeHtml(session.recording_url)}" style="width:100%;"></audio></div>` : '<div style="color:#9aa4b2;">No recording available for this call.</div>'}
    ${session.ai_summary ? `<div><div style="font-weight:700;margin-bottom:6px;">Quo AI Interpretation</div><div style="line-height:1.6;white-space:pre-wrap;word-break:break-word;">${escapeHtml(session.ai_summary)}</div></div>` : ''}
    ${session.ai_transcript ? `<details><summary style="cursor:pointer;font-weight:700;">Full transcript</summary><pre style="white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;margin-top:8px;padding:12px;border-radius:12px;background:rgba(0,0,0,0.18);">${escapeHtml(session.ai_transcript)}</pre></details>` : ''}
  `;
}

async function findLinkedCallSessionForAttempt(callAttempt) {
  if (!callAttempt) return null;
  try {
    const explicitSessionId = extractCallSessionIdFromNotes(callAttempt.notes);
    if (explicitSessionId) {
      const { data: directMatch, error: directError } = await sb
        .from('call_sessions')
        .select('id, lead_id, from_number, to_number, agent_email, created_at, recording_url, ai_summary, ai_transcript, disposition, disposition_notes, answered, duration_seconds')
        .eq('id', explicitSessionId)
        .maybeSingle();
      if (!directError && directMatch) return { ...directMatch, __strictLinked: true };
      return null;
    }

    const lead = await loadLeadForCallMedia(callAttempt.lead_id);
    const phoneDigits = normalizePhone(lead?.phone || '');
    const createdAt = callAttempt.created_at ? new Date(callAttempt.created_at).getTime() : Date.now();
    const targetTime = Number.isFinite(createdAt) ? createdAt : Date.now();
    const windowStart = new Date(targetTime - (2 * 60 * 60 * 1000)).toISOString();
    const windowEnd = new Date(targetTime + (2 * 60 * 60 * 1000)).toISOString();
    const agentEmail = String(currentUser?.email || '').trim().toLowerCase();

    const { data, error } = await sb
      .from('call_sessions')
      .select('id, lead_id, from_number, to_number, agent_email, created_at, recording_url, ai_summary, ai_transcript, disposition, disposition_notes, answered, duration_seconds')
      .gte('created_at', windowStart)
      .lte('created_at', windowEnd)
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) throw error;

    const context = {
      explicitSessionId,
      targetTime,
      leadId: callAttempt?.lead_id ? String(callAttempt.lead_id) : '',
      phoneDigits,
      agentEmail,
      answered: typeof callAttempt?.answered === 'boolean' ? callAttempt.answered : null
    };

    const candidates = (data || []).map((row) => {
      const match = scoreCallSessionCandidate(row, context);
      return { row, ...match };
    }).filter((item) => {
      if (!item.sameLead && !item.samePhone) return false;
      if (!Number.isFinite(item.deltaMinutes) || item.deltaMinutes > 120) return false;
      return item.score >= 225;
    }).sort((a, b) => b.score - a.score);

    if (!candidates.length) return null;
    const best = candidates[0];
    const runnerUp = candidates[1] || null;
    const strictEnough =
      (best.sameLead && best.samePhone)
      || (best.sameLead && best.deltaMinutes <= 30)
      || (best.samePhone && best.sameAgent && best.deltaMinutes <= 10);
    const ambiguous = !!(runnerUp && Math.abs(best.score - runnerUp.score) < 40);
    if (!strictEnough || ambiguous) return null;

    return { ...best.row, __strictLinked: true };
  } catch (error) {
    console.warn('findLinkedCallSessionForAttempt failed:', error?.message || error);
    return null;
  }
}

// ====== CALLS TABLE ======
function renderCallsTable(calls) {
  const tbody = $('callsTableBody');
  if (!calls.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No calls logged yet.</td></tr>';
    return;
  }
  tbody.innerHTML = calls.map(c => {
    const lead = getLeadCached(c.lead_id);
    return `
      <tr data-call-id="${c.id}" class="call-log-row" style="cursor:pointer;">
        <td>${formatDate(c.created_at)}</td>
        <td><strong>${escapeHtml(lead ? lead.contact_name : '—')}</strong></td>
        <td>${escapeHtml(getAgentDisplayName(c.agent_id))}</td>
        <td>${renderTeamBadge(getAgentTeamLabel(c.agent_id))}</td>
        <td>${c.answered ? '<span class="bool-yes">✅ Yes</span>' : '<span class="bool-no">—</span>'}</td>
        <td>${c.allowed_presentation ? '<span class="bool-yes">✅ Yes</span>' : '<span class="bool-no">—</span>'}</td>
        <td>${c.appointment_booked ? '<span class="bool-yes">✅ Yes</span>' : '<span class="bool-no">—</span>'}</td>
        <td>${escapeHtml(c.call_outcome || '—')}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(stripCallSessionMeta(c.notes) || '—')}</td>
        <td><button class="btn-view btn-edit-call" data-id="${c.id}">Details</button></td>
      </tr>`;
  }).join('');
  tbody.querySelectorAll('tr[data-call-id]').forEach(tr => {
    tr.addEventListener('click', () => openCallModal(tr.dataset.callId, true));
  });
  tbody.querySelectorAll('.btn-edit-call').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCallModal(btn.dataset.id, true);
    });
  });
}

// ====== APPOINTMENTS — KPIs, table, calendar, upcoming ======
function renderAppointments() {
  renderApptKPIs();
  renderApptsTable(getFilteredAppts());
  renderCalendar();
  renderUpcomingList();
  renderNextUpList();
}

function renderApptKPIs() {
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7*24*60*60*1000);
  let upcoming=0, thisWeek=0, completed=0, signed=0, noshow=0, cancelled=0;
  allAppts.forEach(a => {
    const dt = a.scheduled_for ? new Date(a.scheduled_for) : null;
    if (a.status === 'Scheduled' && dt && dt >= now) upcoming++;
    if (dt && dt >= now && dt <= weekEnd) thisWeek++;
    if (a.status === 'Completed') completed++;
    if (a.status === 'Signed') signed++;
    if (a.status === 'No-show') noshow++;
    if (a.status === 'Cancelled') cancelled++;
  });
  $('kpiUpcoming').textContent = upcoming;
  $('kpiThisWeek').textContent = thisWeek;
  $('kpiCompleted').textContent = completed;
  $('kpiSigned').textContent = signed;
  $('kpiNoshow').textContent = noshow;
  $('kpiCancelled').textContent = cancelled;
}

function renderApptsTable(appts) {
  const tbody = $('apptsTableBody');
  if (!appts.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="loading-row">No appointments scheduled yet.</td></tr>';
    return;
  }
  tbody.innerHTML = appts.map(a => {
    const lead = getLeadCached(a.lead_id);
    return `
      <tr data-id="${a.id}">
        <td><strong>${a.scheduled_for ? new Date(a.scheduled_for).toLocaleString() : '—'}</strong></td>
        <td>${escapeHtml(lead ? lead.contact_name : '—')}</td>
        <td>${escapeHtml(getAgentDisplayName(a.agent_id))}</td>
        <td>${renderTeamBadge(getAgentTeamLabel(a.agent_id))}</td>
        <td>${escapeHtml(lead ? (lead.phone || '—') : '—')}</td>
        <td>${escapeHtml(lead ? (lead.damage_type || '—') : '—')}</td>
        <td><span class="status-pill status-${(a.status || 'Scheduled').replace(/-/g,'').replace(/\s+/g,'')}">${escapeHtml(a.status || 'Scheduled')}</span></td>
        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.outcome || '—')}</td>
        <td>
          <button class="btn-view" data-id="${a.id}">Edit</button>
          ${isAdmin() ? `<button class="btn-secondary btn-inline appt-documike-btn" data-documike-appt="${a.id}" title="Open DocuMike with this client's info"><i class="fas fa-file-signature"></i> DocuMike</button>` : ''}
        </td>
      </tr>`;
  }).join('');
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (event) => {
      if (event.target.closest('[data-documike-appt]')) return;
      openApptModal(tr.dataset.id);
    });
  });
  tbody.querySelectorAll('[data-documike-appt]').forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openDocuMikeForAppointment(btn.dataset.documikeAppt);
    });
  });
}

// ====== CALENDAR ======
let calCursor = new Date();
calCursor.setDate(1);

function renderCalendar() {
  const grid = $('calGrid');
  if (!grid) return;
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  const monthName = calCursor.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  $('calTitle').textContent = monthName;

  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  // Group appts by yyyy-mm-dd
  const apptsByDay = {};
  allAppts.forEach(a => {
    if (!a.scheduled_for) return;
    const d = new Date(a.scheduled_for);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!apptsByDay[key]) apptsByDay[key] = [];
    apptsByDay[key].push(a);
  });

  const cells = [];
  // Leading days (prev month)
  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    cells.push({ date: d, otherMonth: true });
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), otherMonth: false });
  }
  // Trailing
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), otherMonth: true });
  }

  grid.innerHTML = cells.map(c => {
    const key = `${c.date.getFullYear()}-${c.date.getMonth()}-${c.date.getDate()}`;
    const events = apptsByDay[key] || [];
    const isToday = c.date.getTime() === today.getTime();
    const classes = ['cal-day'];
    if (c.otherMonth) classes.push('other-month');
    if (isToday) classes.push('today');
    if (events.length) classes.push('has-events');

    const eventsHtml = events.slice(0, 2).map(ev => {
      const lead = getLeadCached(ev.lead_id);
      const name = lead ? (lead.contact_name || 'Lead') : 'Lead';
      const t = new Date(ev.scheduled_for);
      const time = t.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
      const statusClass = (ev.status || '').toLowerCase().replace(/[^a-z]/g,'');
      return `<div class="cal-event ${statusClass}" data-id="${ev.id}" title="${escapeHtml(name)} at ${time} — ${escapeHtml(ev.status || '')}">${escapeHtml(time)} ${escapeHtml(name)}</div>`;
    }).join('');
    const more = events.length > 2 ? `<div class="cal-event-more">+${events.length - 2} more</div>` : '';

    return `<div class="${classes.join(' ')}">
      <div class="cal-day-num">${c.date.getDate()}</div>
      ${eventsHtml}${more}
    </div>`;
  }).join('');

  // Wire event clicks
  grid.querySelectorAll('.cal-event').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openApptModal(el.dataset.id);
    });
  });
}

function renderUpcomingList() {
  const list = $('upcomingList');
  if (!list) return;
  const now = new Date();
  const upcoming = allAppts
    .filter(a => a.scheduled_for && new Date(a.scheduled_for) >= now && a.status !== 'Cancelled')
    .sort((a,b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));
  if (!upcoming.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-calendar"></i><p>No upcoming appointments. Book one by logging a call!</p></div>';
    return;
  }
  list.innerHTML = upcoming.map(a => upcomingItemHtml(a)).join('');
  list.querySelectorAll('.upcoming-item').forEach(el => {
    el.addEventListener('click', () => openApptModal(el.dataset.id));
  });
}

function renderNextUpList() {
  const list = $('calNextUpList');
  if (!list) return;
  const now = new Date();
  const upcoming = allAppts
    .filter(a => a.scheduled_for && new Date(a.scheduled_for) >= now && a.status !== 'Cancelled')
    .sort((a,b) => new Date(a.scheduled_for) - new Date(b.scheduled_for))
    .slice(0, 5);
  if (!upcoming.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-calendar"></i><p>No upcoming appointments.</p></div>';
    return;
  }
  list.innerHTML = upcoming.map(a => upcomingItemHtml(a)).join('');
  list.querySelectorAll('.upcoming-item').forEach(el => {
    el.addEventListener('click', () => openApptModal(el.dataset.id));
  });
}

function upcomingItemHtml(a) {
  const lead = getLeadCached(a.lead_id);
  const name = lead ? (lead.contact_name || 'Lead') : 'Lead';
  const phone = lead ? (lead.phone || '') : '';
  const damage = lead ? (lead.damage_type || '') : '';
  const hasAssignedAgent = Boolean(a.agent_id);
  const agentName = hasAssignedAgent ? getAgentDisplayName(a.agent_id) : 'Unassigned';
  const teamBadge = hasAssignedAgent ? renderTeamBadge(getAgentTeamLabel(a.agent_id)) : '<span class="status-pill status-New">Unassigned</span>';
  const bookingMeta = hasAssignedAgent
    ? `Booked by ${escapeHtml(agentName)} · ${teamBadge}`
    : `${teamBadge} · click to assign`;
  const dt = new Date(a.scheduled_for);
  const month = dt.toLocaleString(undefined, {month: 'short'});
  const day = dt.getDate();
  const time = dt.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  return `<div class="upcoming-item" data-id="${a.id}">
    <div class="up-date">
      <span class="up-month">${month}</span>
      <span class="up-day">${day}</span>
    </div>
    <div class="up-info">
      <div class="up-name">${escapeHtml(name)}</div>
      <div class="up-meta">${escapeHtml(phone)} ${damage ? '· ' + escapeHtml(damage) : ''} · <span class="status-pill status-${(a.status || 'Scheduled').replace(/-/g,'').replace(/\s+/g,'')}">${escapeHtml(a.status || 'Scheduled')}</span></div>
      <div class="up-meta">${bookingMeta}</div>
    </div>
    <div class="up-time">${time}</div>
  </div>`;
}

// ====== FILTERS ======
function getFilteredCalls() {
  const outcome = $('callOutcomeFilter')?.value || '';
  const team = $('callTeamFilter')?.value || '';
  return allCalls.filter(c => {
    if (outcome && c.call_outcome !== outcome) return false;
    if (team && !callMatchesTeam(c, team)) return false;
    return true;
  });
}

function getFilteredAppts() {
  const status = $('apptStatusFilter')?.value || '';
  const team = $('apptTeamFilter')?.value || '';
  return allAppts.filter(a => {
    if (status && a.status !== status) return false;
    if (team && !apptMatchesTeam(a, team)) return false;
    return true;
  });
}

function queueLeadRefresh(resetPage = true) {
  clearTimeout(leadFilterTimer);
  leadFilterTimer = setTimeout(() => {
    loadLeadsPage(resetPage ? 1 : currentLeadPage);
  }, 250);
}

$('searchInput').addEventListener('input', () => queueLeadRefresh(true));
$('locationSearch').addEventListener('input', () => queueLeadRefresh(true));
$('stateFilter').addEventListener('change', () => loadLeadsPage(1));
$('countyFilter').addEventListener('change', () => loadLeadsPage(1));
$('statusFilter').addEventListener('change', () => loadLeadsPage(1));
$('damageFilter').addEventListener('change', () => loadLeadsPage(1));
$('organizeBy').addEventListener('change', () => loadLeadsPage(1));
$('refreshBtn').addEventListener('click', async () => {
  await loadLeadCount();
  await loadLeadFilterOptions();
  await loadLeadsPage(currentLeadPage);
  renderOverview();
  await loadMessagesData();
});
$('refreshCallsBtn').addEventListener('click', async () => {
  await loadCalls();
  rebuildLeadIndexes();
  await ensureLeadCacheForIds(allCalls.map(call => call.lead_id));
  renderCallsTable(getFilteredCalls());
  renderOverview();
  await loadMessagesData();
});
$('refreshApptsBtn').addEventListener('click', async () => {
  await loadAppts();
  await ensureLeadCacheForIds(allAppts.map(appt => appt.lead_id));
  renderAppointments();
  renderOverview();
  await loadMessagesData();
});
$('callOutcomeFilter').addEventListener('change', () => {
  renderCallsTable(getFilteredCalls());
});
$('callTeamFilter')?.addEventListener('change', () => {
  renderCallsTable(getFilteredCalls());
});
$('apptStatusFilter').addEventListener('change', () => {
  renderApptsTable(getFilteredAppts());
});
$('apptTeamFilter')?.addEventListener('change', () => {
  renderApptsTable(getFilteredAppts());
});
$('adminOverviewTeamFilter')?.addEventListener('change', () => {
  renderOverview();
});
$('leadPrevPageBtn')?.addEventListener('click', () => {
  if (currentLeadPage > 1) loadLeadsPage(currentLeadPage - 1);
});
$('leadNextPageBtn')?.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil((filteredLeadCount || 0) / leadPageSize) || 1);
  if (currentLeadPage < totalPages) loadLeadsPage(currentLeadPage + 1);
});

// Appointment sub-tabs
document.querySelectorAll('.appt-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.appt-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.appt-pane').forEach(p => p.classList.add('hidden'));
    $('pane-' + tab.dataset.tab).classList.remove('hidden');
  });
});

// Calendar nav
$('calPrev').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
$('calNext').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });
$('calToday').addEventListener('click', () => { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); });

async function applyLeadFilters() {
  await loadLeadsPage(1);
}

function sortLeadsByMode(a, b, mode) {
  if (mode === 'state') {
    return compareText(a.state, b.state) || compareText(a.city, b.city) || compareDateDesc(a.created_at, b.created_at);
  }
  if (mode === 'city') {
    return compareText(a.city, b.city) || compareText(a.state, b.state) || compareDateDesc(a.created_at, b.created_at);
  }
  if (mode === 'county') {
    return compareText(getLeadCountyLabel(a), getLeadCountyLabel(b)) || compareText(a.state, b.state) || compareText(a.city, b.city) || compareText(a.contact_name, b.contact_name) || compareDateDesc(a.created_at, b.created_at);
  }
  if (mode === 'state_city') {
    return compareText(a.state, b.state) || compareText(a.city, b.city) || compareText(a.contact_name, b.contact_name) || compareDateDesc(a.created_at, b.created_at);
  }
  return compareDateDesc(a.created_at, b.created_at);
}

function compareText(a, b) {
  return String(a || '~').localeCompare(String(b || '~'));
}

function compareDateDesc(a, b) {
  return new Date(b || 0) - new Date(a || 0);
}

// ====== CSV IMPORT ======
const CSV_IMPORT_FIELDS = [
  { key: 'contact_name', label: 'Lead name', help: 'Homeowner or main contact name', synonyms: ['name', 'fullname', 'full_name', 'contactname', 'contact_name', 'ownername', 'owner_name', 'customername', 'customer_name', 'homeowner', 'leadname', 'lead_name'] },
  { key: 'phone', label: 'Phone', help: 'Primary phone number', synonyms: ['phone', 'phonenumber', 'phone_number', 'mobile', 'cell', 'telephone', 'tel'] },
  { key: 'email', label: 'Email', help: 'Primary email address', synonyms: ['email', 'emailaddress', 'email_address', 'mail'] },
  { key: 'address', label: 'Street address', help: 'Main property or mailing address', synonyms: ['address', 'street', 'streetaddress', 'street_address', 'propertyaddress', 'property_address'] },
  { key: 'city', label: 'City', help: 'City only', synonyms: ['city', 'town'] },
  { key: 'state', label: 'State', help: 'State or province', synonyms: ['state', 'province', 'region'] },
  { key: 'zip', label: 'ZIP code', help: 'ZIP / postal code', synonyms: ['zip', 'zipcode', 'zip_code', 'postal', 'postalcode', 'postal_code'] },
  { key: 'damage_type', label: 'Damage type', help: 'Water, mold, fire, storm, etc.', synonyms: ['damage', 'damage_type', 'damagetype', 'loss_type', 'losstype', 'service_type', 'claim_type'] },
  { key: 'source', label: 'Lead source', help: 'List source, campaign, referral, etc.', synonyms: ['source', 'leadsource', 'lead_source', 'campaign', 'list', 'channel'] },
  { key: 'status', label: 'Status', help: 'New, In Progress, Booked, Closed, Dead', synonyms: ['status', 'leadstatus', 'lead_status', 'pipeline', 'stage'] },
  { key: 'insurance_carrier', label: 'Insurance carrier', help: 'Insurance company', synonyms: ['insurance', 'insurancecarrier', 'insurance_carrier', 'carrier'] },
  { key: 'claim_number', label: 'Claim number', help: 'Claim reference number', synonyms: ['claimnumber', 'claim_number', 'claim'] },
  { key: 'policy_number', label: 'Policy number', help: 'Insurance policy number', synonyms: ['policynumber', 'policy_number', 'policy'] },
  { key: 'notes', label: 'Notes', help: 'Any important extra details', synonyms: ['notes', 'note', 'comments', 'comment', 'description', 'details', 'message'] }
];

let csvImportState = {
  headers: [],
  rows: [],
  mapping: {},
  fileNames: []
};

$('openCsvImportBtn')?.addEventListener('click', openCsvImportModal);
$('csvAnalyzeBtn')?.addEventListener('click', analyzeCsvFile);
$('csvImportBtn')?.addEventListener('click', importCsvLeads);
$('csvFileInput')?.addEventListener('change', () => resetCsvImport(true));
['csvDuplicateMode', 'csvDuplicateMatch', 'csvDefaultStatus', 'csvDefaultSource'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', renderCsvPreview);
});

function openCsvImportModal() {
  resetCsvImport(false);
  $('csvImportModal').classList.remove('hidden');
}

function resetCsvImport(keepFile) {
  csvImportState = { headers: [], rows: [], mapping: {}, fileNames: [] };
  if (!keepFile && $('csvFileInput')) $('csvFileInput').value = '';
  $('csvAnalyzeStatus').className = 'csv-status';
  $('csvAnalyzeStatus').innerHTML = 'Upload one or more CSV files and click <strong>Analyze CSV</strong>. The importer will combine them, let you map columns once, and then import everything together.';
  $('csvImportConfig').classList.add('hidden');
  $('csvImportPreviewWrap').classList.add('hidden');
  $('csvMappingGrid').innerHTML = '';
  $('csvPreviewBody').innerHTML = '<tr><td colspan="7" class="loading-row">Analyze one or more CSV files to preview mapped rows.</td></tr>';
  $('csvFileCount').textContent = '0';
  $('csvRowCount').textContent = '0';
  $('csvHeaderCount').textContent = '0';
  $('csvImportBtn').disabled = true;
}

async function analyzeCsvFile() {
  const files = Array.from($('csvFileInput').files || []);
  if (!files.length) {
    setCsvStatus('Please choose at least one CSV file first.', 'warning');
    return;
  }

  try {
    setCsvStatus(`Analyzing <strong>${files.length}</strong> file${files.length === 1 ? '' : 's'}…`, '');

    const headerSet = new Set();
    const combinedRows = [];
    const validFileNames = [];

    for (const file of files) {
      const text = await file.text();
      const parsed = parseCsvText(text);
      if (!parsed.length || parsed.length < 2) continue;

      const headers = parsed[0]
        .map(v => String(v || '').trim())
        .filter((v, i, arr) => v || i < arr.length);
      if (!headers.length) continue;

      headers.forEach(header => headerSet.add(header));
      validFileNames.push(file.name || 'CSV file');

      parsed.slice(1)
        .filter(row => row.some(cell => String(cell || '').trim()))
        .forEach(row => {
          const obj = { __source_file: file.name || 'CSV file' };
          headers.forEach((header, index) => {
            obj[header] = row[index] == null ? '' : String(row[index]).trim();
          });
          combinedRows.push(obj);
        });
    }

    const headers = Array.from(headerSet);
    if (!headers.length || !combinedRows.length) {
      setCsvStatus('We could not find any lead rows in those CSV files. Make sure each file has headers in the first row and at least one data row.', 'error');
      return;
    }

    csvImportState.headers = headers;
    csvImportState.rows = combinedRows;
    csvImportState.mapping = inferCsvMapping(headers);
    csvImportState.fileNames = validFileNames;

    $('csvFileCount').textContent = String(validFileNames.length);
    $('csvRowCount').textContent = String(combinedRows.length);
    $('csvHeaderCount').textContent = String(headers.length);
    $('csvImportConfig').classList.remove('hidden');
    buildCsvMappingGrid(headers);
    renderCsvPreview();
    $('csvImportBtn').disabled = false;

    const fileLabel = validFileNames.length === 1
      ? `<strong>${escapeHtml(validFileNames[0])}</strong>`
      : `<strong>${validFileNames.length}</strong> files`;
    setCsvStatus(`Combined ${fileLabel} into <strong>${combinedRows.length}</strong> rows across <strong>${headers.length}</strong> detected columns. Review the mapping once, then import everything together.`, 'success');
  } catch (error) {
    setCsvStatus('Could not read those CSV files: ' + escapeHtml(error.message), 'error');
  }
}

function setCsvStatus(message, kind) {
  $('csvAnalyzeStatus').className = 'csv-status' + (kind ? ' ' + kind : '');
  $('csvAnalyzeStatus').innerHTML = message;
}

function inferCsvMapping(headers) {
  const mapping = {};
  CSV_IMPORT_FIELDS.forEach(field => {
    const match = headers.find(header => field.synonyms.includes(normalizeHeader(header)));
    mapping[field.key] = match || '';
  });
  return mapping;
}

function buildCsvMappingGrid(headers) {
  const grid = $('csvMappingGrid');
  grid.innerHTML = CSV_IMPORT_FIELDS.map(field => {
    const options = ['<option value="">Ignore this field</option>']
      .concat(headers.map(header => `<option value="${escapeHtml(header)}"${csvImportState.mapping[field.key] === header ? ' selected' : ''}>${escapeHtml(header)}</option>`))
      .join('');
    return `<div class="csv-map-item">
      <strong>${escapeHtml(field.label)}</strong>
      <small>${escapeHtml(field.help)}</small>
      <select id="map_${field.key}">${options}</select>
    </div>`;
  }).join('');

  CSV_IMPORT_FIELDS.forEach(field => {
    const select = $('map_' + field.key);
    if (!select) return;
    select.addEventListener('change', () => {
      csvImportState.mapping[field.key] = select.value;
      renderCsvPreview();
    });
  });
}

function renderCsvPreview() {
  if (!csvImportState.rows.length) return;
  $('csvImportPreviewWrap').classList.remove('hidden');
  const body = $('csvPreviewBody');
  const previewRows = csvImportState.rows.slice(0, 5).map(row => buildLeadPayloadFromCsv(row)).filter(Boolean);
  if (!previewRows.length) {
    body.innerHTML = '<tr><td colspan="7" class="loading-row">Your current mapping does not produce any usable rows yet. Map at least a name, phone, or email column.</td></tr>';
    return;
  }
  body.innerHTML = previewRows.map(payload => `
    <tr>
      <td><strong>${escapeHtml(payload.contact_name || '—')}</strong></td>
      <td>${escapeHtml(payload.phone || '—')}</td>
      <td>${escapeHtml(payload.email || '—')}</td>
      <td>${escapeHtml([payload.city, payload.state].filter(Boolean).join(', ') || payload.address || '—')}</td>
      <td>${escapeHtml(payload.damage_type || '—')}</td>
      <td>${escapeHtml(payload.source || '—')}</td>
      <td>${escapeHtml(payload.status || '—')}</td>
    </tr>
  `).join('');
}

function buildLeadPayloadFromCsv(row) {
  const payload = {};
  CSV_IMPORT_FIELDS.forEach(field => {
    const header = $('map_' + field.key)?.value || csvImportState.mapping[field.key] || '';
    if (!header) return;
    const raw = row[header];
    const value = cleanCsvCell(raw);
    if (!value) return;
    payload[field.key] = value;
  });

  if (!payload.status) payload.status = $('csvDefaultStatus').value || 'New';
  if (!payload.source && $('csvDefaultSource').value.trim()) payload.source = $('csvDefaultSource').value.trim();
  if (payload.state) payload.state = payload.state.toUpperCase();
  if (payload.damage_type) payload.damage_type = normalizeDamageType(payload.damage_type);

  if (!payload.contact_name && !payload.phone && !payload.email) return null;
  return payload;
}

async function importCsvLeads() {
  if (!csvImportState.rows.length) {
    setCsvStatus('Analyze one or more CSV files before importing.', 'warning');
    return;
  }

  const importBtn = $('csvImportBtn');
  const analyzeBtn = $('csvAnalyzeBtn');
  importBtn.disabled = true;
  analyzeBtn.disabled = true;

  const duplicateMode = $('csvDuplicateMode').value;
  const duplicateMatch = $('csvDuplicateMatch').value;
  const leadIndex = duplicateMode === 'create' ? { phone: new Map(), email: new Map() } : await buildLeadIndex();
  const stats = { created: 0, updated: 0, skipped: 0, invalid: 0, errors: 0 };
  const errorMessages = [];
  const createRows = [];
  const updateRows = [];

  try {
    for (let i = 0; i < csvImportState.rows.length; i++) {
      const payload = buildLeadPayloadFromCsv(csvImportState.rows[i]);
      if (!payload) {
        stats.invalid++;
        continue;
      }

      const existingId = duplicateMode === 'create' ? null : findExistingLeadId(payload, leadIndex, duplicateMatch);
      if (existingId && duplicateMode === 'skip') {
        stats.skipped++;
        continue;
      }

      if (existingId && duplicateMode === 'update') {
        updateRows.push({ ...payload, id: existingId });
        registerLeadIndex(leadIndex, { ...payload, id: existingId });
      } else {
        createRows.push(payload);
        registerLeadIndex(leadIndex, { ...payload, id: 'prepared-' + i });
      }

      if ((i + 1) % 250 === 0 || i === csvImportState.rows.length - 1) {
        setCsvStatus(`Preparing import… ${i + 1} of ${csvImportState.rows.length} rows analyzed.`, '');
      }
    }

    await processLeadChunks(createRows, 'create', stats, errorMessages);
    await processLeadChunks(updateRows, 'update', stats, errorMessages);

    await loadLeadCount();
  await loadLeadFilterOptions();
    await loadLeadsPage(1);
    renderOverview();
  await loadMessagesData();

    const summary = `Import complete from ${csvImportState.fileNames.length || 1} file${(csvImportState.fileNames.length || 1) === 1 ? '' : 's'} — ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.invalid} ignored, ${stats.errors} errors.`;
    if (stats.errors) {
      setCsvStatus(`${summary}<br><small>${escapeHtml(errorMessages.join(' | '))}</small>`, 'warning');
    } else {
      setCsvStatus(summary, 'success');
    }
    alert(summary);
    if (!stats.errors) closeAllModals();
  } finally {
    importBtn.disabled = false;
    analyzeBtn.disabled = false;
  }
}

async function processLeadChunks(rows, mode, stats, errorMessages) {
  if (!rows.length) return;
  const chunkSize = 250;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    let error = null;

    if (mode === 'update') {
      const result = await sb.from('crm_leads').upsert(chunk, { onConflict: 'id' });
      error = result.error;
    } else {
      const result = await sb.from('crm_leads').insert(chunk);
      error = result.error;
    }

    if (!error) {
      if (mode === 'update') stats.updated += chunk.length;
      else stats.created += chunk.length;
    } else {
      for (const row of chunk) {
        let rowError = null;
        if (mode === 'update') {
          const result = await sb.from('crm_leads').update(row).eq('id', row.id);
          rowError = result.error;
        } else {
          const result = await sb.from('crm_leads').insert(row);
          rowError = result.error;
        }
        if (rowError) {
          stats.errors++;
          if (errorMessages.length < 5) errorMessages.push(rowError.message);
        } else if (mode === 'update') {
          stats.updated++;
        } else {
          stats.created++;
        }
      }
    }

    const processed = Math.min(rows.length, i + chunk.length);
    const label = mode === 'update' ? 'Updating leads…' : 'Creating leads…';
    setCsvStatus(`${label} ${processed} of ${rows.length} ${mode === 'update' ? 'updates' : 'new rows'} processed.`, '');
  }
}

async function buildLeadIndex() {
  const index = { phone: new Map(), email: new Map() };
  const batchSize = 1000;
  let from = 0;

  while (true) {
    const to = from + batchSize - 1;
    const { data, error } = await sb
      .from('crm_leads')
      .select('id, phone, email')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    const rows = data || [];
    rows.forEach(lead => registerLeadIndex(index, lead));
    if (rows.length < batchSize) break;
    from += batchSize;
  }

  return index;
}

function registerLeadIndex(index, lead) {
  const phone = normalizePhone(lead.phone);
  const email = normalizeEmail(lead.email);
  if (phone) index.phone.set(phone, lead.id);
  if (email) index.email.set(email, lead.id);
}

function findExistingLeadId(payload, index, mode) {
  const phoneId = payload.phone ? index.phone.get(normalizePhone(payload.phone)) : null;
  const emailId = payload.email ? index.email.get(normalizeEmail(payload.email)) : null;
  if (mode === 'phone') return phoneId || null;
  if (mode === 'email') return emailId || null;
  return phoneId || emailId || null;
}

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanCsvCell(value) {
  const cleaned = String(value == null ? '' : value).trim();
  return cleaned || null;
}

function normalizePhone(value) {
  return String(value || '').replace(/\\D/g, '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeDamageType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v.includes('water')) return 'Water';
  if (v.includes('mold')) return 'Mold';
  if (v.includes('fire') || v.includes('smoke')) return 'Fire';
  if (v.includes('storm') || v.includes('wind') || v.includes('hail')) return 'Storm';
  if (v.includes('multi')) return 'Multi';
  return value;
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}


// ====== LEAD MODAL ======
$('addLeadBtn').addEventListener('click', () => openLeadModal(null));

async function openLeadModal(id) {
  editingLeadId = id;
  const isNew = !id;
  $('leadModalTitle').textContent = isNew ? 'Add New Lead' : 'Edit Lead';
  const lead = isNew ? {} : ((getLeadCached(id) || await fetchLeadById(id)) || {});
  $('lf_contact_name').value = lead.contact_name || '';
  $('lf_phone').value = lead.phone || '';
  $('lf_email').value = lead.email || '';
  $('lf_address').value = lead.address || '';
  $('lf_city').value = lead.city || '';
  $('lf_state').value = lead.state || '';
  $('lf_damage_type').value = lead.damage_type || '';
  $('lf_source').value = lead.source || '';
  $('lf_status').value = lead.status || 'New';
  $('lf_notes').value = lead.notes || '';
  $('leadDeleteBtn').classList.toggle('hidden', isNew);

  // Call history
  if (!isNew) {
    const calls = leadCallsMap.get(id) || [];
    if (calls.length) {
      $('leadCallHistory').classList.remove('hidden');
      $('leadCallHistoryList').innerHTML = calls.map(c => `
        <div class="call-history-item">
          <div class="ch-meta">
            <span>${formatDate(c.created_at)}</span>
            <span>${escapeHtml(c.call_outcome || '—')}</span>
          </div>
          <div class="ch-flags">
            <span class="ch-flag ${c.answered ? 'yes' : 'no'}">📞 ${c.answered ? 'Answered' : 'No answer'}</span>
            ${c.allowed_presentation ? '<span class="ch-flag yes">🎤 Presented</span>' : ''}
            ${c.appointment_booked ? '<span class="ch-flag yes">📅 Booked</span>' : ''}
          </div>
          ${stripCallSessionMeta(c.notes) ? `<div style="margin-top:6px;font-size:.85rem;">${escapeHtml(stripCallSessionMeta(c.notes))}</div>` : ''}
        </div>`).join('');
    } else {
      $('leadCallHistory').classList.remove('hidden');
      $('leadCallHistoryList').innerHTML = '<div class="empty-state" style="padding:20px;"><p>No calls logged for this lead yet.</p></div>';
    }
  } else {
    $('leadCallHistory').classList.add('hidden');
  }

  $('leadModal').classList.remove('hidden');
}

$('leadSaveBtn').addEventListener('click', async () => {
  const payload = {
    contact_name: $('lf_contact_name').value || null,
    phone: $('lf_phone').value || null,
    email: $('lf_email').value || null,
    address: $('lf_address').value || null,
    city: $('lf_city').value || null,
    state: $('lf_state').value || null,
    damage_type: $('lf_damage_type').value || null,
    source: $('lf_source').value || null,
    status: $('lf_status').value || 'New',
    notes: $('lf_notes').value || null
  };
  let result;
  if (editingLeadId) {
    result = await sb.from('crm_leads').update(payload).eq('id', editingLeadId);
  } else {
    // Note: assigned_agent intentionally omitted to avoid PostgREST schema cache issues
    result = await sb.from('crm_leads').insert(payload);
  }
  if (result.error) { alert('❌ ' + result.error.message); return; }
  closeAllModals();
  await loadAll();
  initMessageRealtime();
});

$('leadDeleteBtn').addEventListener('click', async () => {
  if (!editingLeadId) return;
  if (!confirm('Delete this lead and all its calls? This cannot be undone.')) return;
  const { error } = await sb.from('crm_leads').delete().eq('id', editingLeadId);
  if (error) { alert('❌ ' + error.message); return; }
  closeAllModals();
  await loadAll();
  initMessageRealtime();
});

$('logCallBtn').addEventListener('click', () => {
  if (!editingLeadId) {
    alert('Save the lead first, then log a call.');
    return;
  }
  closeAllModals();
  openCallModal(editingLeadId);
});

// ====== CALL MODAL ======
async function openCallModal(callOrLeadId, isEditing = false) {
  editingCallId = null;
  editingCallSessionId = null;
  const existingCall = isEditing ? allCalls.find(c => c.id === callOrLeadId) : null;
  const leadId = isEditing ? existingCall?.lead_id : callOrLeadId;
  activeLeadId = leadId || null;

  const lead = getLeadCached(activeLeadId);
  $('callForLead').textContent = 'For: ' + (lead ? `${lead.contact_name || 'Unnamed'} · ${lead.phone || ''}` : '—');
  $('callModalTitle').innerHTML = isEditing ? '<i class="fas fa-pen"></i> Edit Call' : '<i class="fas fa-phone"></i> Log a Call';
  $('callSaveBtn').textContent = isEditing ? 'Save Changes' : 'Save Call';
  if ($('callDeleteBtn')) $('callDeleteBtn').classList.toggle('hidden', !isEditing);
  renderCallMediaPanel(null);

  if (existingCall) {
    editingCallId = existingCall.id;
    $('cf_answered').checked = !!existingCall.answered;
    $('cf_presented').checked = !!existingCall.allowed_presentation;
    $('cf_booked').checked = !!existingCall.appointment_booked;
    $('cf_outcome').value = existingCall.call_outcome || '';
    $('cf_duration').value = existingCall.duration_seconds || 0;
    $('cf_notes').value = stripCallSessionMeta(existingCall.notes || '');
    const linkedSession = await findLinkedCallSessionForAttempt(existingCall);
    const existingSessionId = extractCallSessionIdFromNotes(existingCall.notes || '');
    editingCallSessionId = existingSessionId || (linkedSession?.__strictLinked ? linkedSession.id : null) || null;
    renderCallMediaPanel(linkedSession);
  } else {
    $('cf_answered').checked = false;
    $('cf_presented').checked = false;
    $('cf_booked').checked = false;
    $('cf_outcome').value = '';
    $('cf_duration').value = 0;
    $('cf_notes').value = '';
  }

  $('cf_apptDate').value = '';
  $('cf_apptNotes').value = '';
  $('apptInline').classList.toggle('hidden', !$('cf_booked').checked);
  $('callModal').classList.remove('hidden');
}

// Toggle appt inline section
$('cf_booked').addEventListener('change', () => {
  $('apptInline').classList.toggle('hidden', !$('cf_booked').checked);
  if ($('cf_booked').checked) {
    $('cf_outcome').value = 'Booked';
    $('cf_answered').checked = true;
    $('cf_presented').checked = true;
  }
});
$('cf_presented').addEventListener('change', () => {
  if ($('cf_presented').checked) $('cf_answered').checked = true;
});

$('callSaveBtn').addEventListener('click', async () => {
  if (!activeLeadId) return;
  const callPayload = {
    lead_id: activeLeadId,
    agent_id: currentUser.id,
    answered: $('cf_answered').checked,
    allowed_presentation: $('cf_presented').checked,
    appointment_booked: $('cf_booked').checked,
    call_outcome: $('cf_outcome').value || null,
    duration_seconds: parseInt($('cf_duration').value) || 0,
    notes: composeCallNotesWithSessionId($('cf_notes').value || null, editingCallSessionId)
  };

  let cErr = null;
  if (editingCallId) {
    const result = await sb.from('crm_call_attempts').update(callPayload).eq('id', editingCallId);
    cErr = result.error;
  } else {
    const result = await sb.from('crm_call_attempts').insert(callPayload);
    cErr = result.error;
  }
  if (cErr) { alert('❌ Could not save call: ' + cErr.message); return; }

  if (callPayload.appointment_booked) {
    const { data: existingAppt } = await sb
      .from('crm_appointments')
      .select('id')
      .eq('lead_id', activeLeadId)
      .limit(1);

    if ((!existingAppt || !existingAppt.length) && $('cf_apptDate').value) {
      const apptPayload = {
        lead_id: activeLeadId,
        agent_id: currentUser.id,
        scheduled_for: $('cf_apptDate').value || null,
        status: 'Scheduled',
        notes: $('cf_apptNotes').value || null
      };
      await sb.from('crm_appointments').insert(apptPayload);
    }
    await sb.from('crm_leads').update({ status: 'Booked' }).eq('id', activeLeadId);
  } else if (callPayload.answered) {
    const lead = getLeadCached(activeLeadId);
    if (lead && lead.status === 'New') {
      await sb.from('crm_leads').update({ status: 'In Progress' }).eq('id', activeLeadId);
    }
  }

  closeAllModals();
  await loadAll();
  initMessageRealtime();
});

if ($('callDeleteBtn')) {
  $('callDeleteBtn').addEventListener('click', async () => {
    if (!editingCallId) return;
    const confirmed = window.confirm('Delete this call log entry?');
    if (!confirmed) return;
    const { error } = await sb.from('crm_call_attempts').delete().eq('id', editingCallId);
    if (error) { alert('❌ Could not delete call: ' + error.message); return; }
    closeAllModals();
    await loadAll();
  initMessageRealtime();
  });
}

// ====== APPOINTMENT MODAL (create + edit) ======
let editingApptId = null;
let apptLeadSearchTimer = null;
let apptLeadSelected = null;

function getLeadLookupLabel(lead) {
  if (!lead) return '';
  const cityState = [lead.city, lead.state].filter(Boolean).join(', ');
  return [lead.contact_name || 'Unnamed', lead.phone || '', cityState || lead.zip || '']
    .filter(Boolean)
    .join(' · ');
}

function getLeadLookupMeta(lead) {
  if (!lead) return '';
  return [lead.address || '', lead.damage_type || '', lead.zip || '']
    .filter(Boolean)
    .join(' · ');
}

function renderAppointmentLeadResults(results = [], query = '', message = '') {
  const resultsEl = $('af_lead_results');
  if (!resultsEl) return;

  if (!query.trim() && !message) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  if (!results.length) {
    resultsEl.innerHTML = `<div class="lead-lookup-empty">${escapeHtml(message || 'No matching leads found.')}</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = results.map(lead => `
    <button type="button" class="lead-lookup-result" data-id="${lead.id}">
      <span class="lead-lookup-result-title">${escapeHtml(getLeadLookupLabel(lead))}</span>
      <span class="lead-lookup-result-meta">${escapeHtml(getLeadLookupMeta(lead) || 'Click to select this lead')}</span>
    </button>
  `).join('');
  resultsEl.classList.remove('hidden');

  resultsEl.querySelectorAll('.lead-lookup-result').forEach(btn => {
    btn.addEventListener('click', () => {
      const lead = results.find(item => item.id === btn.dataset.id);
      if (lead) setSelectedAppointmentLead(lead);
    });
  });
}

function renderSelectedAppointmentLead() {
  const selectedEl = $('af_lead_selected');
  if (!selectedEl) return;

  if (!apptLeadSelected) {
    selectedEl.classList.add('hidden');
    selectedEl.innerHTML = '';
    return;
  }

  selectedEl.innerHTML = `
    <div>
      <div class="lead-lookup-selected-label">Selected lead</div>
      <div class="lead-lookup-selected-value">${escapeHtml(getLeadLookupLabel(apptLeadSelected))}</div>
    </div>
    <button type="button" class="lead-lookup-clear" id="af_lead_clear">Change</button>
  `;
  selectedEl.classList.remove('hidden');
  $('af_lead_clear')?.addEventListener('click', () => {
    clearSelectedAppointmentLead(false);
    $('af_lead_search').focus();
  });
}

function setSelectedAppointmentLead(lead) {
  apptLeadSelected = lead;
  $('af_lead').value = lead?.id || '';
  $('af_lead_search').value = lead ? getLeadLookupLabel(lead) : '';
  renderSelectedAppointmentLead();
  renderAppointmentLeadResults([], '', '');
}

function clearSelectedAppointmentLead(clearInput = true) {
  apptLeadSelected = null;
  $('af_lead').value = '';
  if (clearInput) $('af_lead_search').value = '';
  renderSelectedAppointmentLead();
}

async function loadAppointmentLeadById(leadId) {
  if (!leadId) return null;
  const existing = getLeadCached(leadId);
  if (existing) return existing;

  const { data, error } = await sb
    .from('crm_leads')
    .select('id, contact_name, phone, city, state, zip, address, damage_type, created_at')
    .eq('id', leadId)
    .maybeSingle();

  if (error) return null;
  return data || null;
}

async function searchAppointmentLeads(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    renderAppointmentLeadResults([], trimmed, 'Start typing at least 2 characters to find a lead.');
    return;
  }

  const safe = trimmed.replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').trim();
  renderAppointmentLeadResults([], trimmed, 'Searching leads…');

  const { data, error } = await sb
    .from('crm_leads')
    .select('id, contact_name, phone, city, state, zip, address, damage_type, created_at')
    .or(`contact_name.ilike.%${safe}%,phone.ilike.%${safe}%,city.ilike.%${safe}%,state.ilike.%${safe}%,zip.ilike.%${safe}%,address.ilike.%${safe}%`)
    .order('created_at', { ascending: false })
    .limit(12);

  if (error) {
    renderAppointmentLeadResults([], trimmed, 'Could not search leads right now.');
    return;
  }

  cacheLeads(data || []);
  renderAppointmentLeadResults(data || [], trimmed, 'No matching leads found.');
}

async function openApptModal(id) {
  editingApptId = id;
  const a = id ? allAppts.find(x => x.id === id) : null;
  const isNew = !a;

  $('apptModalTitle').innerHTML = isNew
    ? '<i class="fas fa-calendar-plus"></i> New Appointment'
    : '<i class="fas fa-calendar-check"></i> Edit Appointment';

  clearSelectedAppointmentLead(true);
  renderAppointmentLeadResults([], '', '');

  if (isNew) {
    $('apptForLead').textContent = 'Search for a lead, then fill in the appointment details below.';
    $('af_scheduled').value = '';
    $('af_duration').value = 60;
    $('af_type').value = 'Inspection';
    $('af_status').value = 'Scheduled';
    $('af_location').value = '';
    $('af_outcome').value = '';
    $('af_amount').value = '';
    $('af_notes').value = '';
    renderAppointmentAgentOptions(currentUser?.id || '');
    $('apptDeleteBtn').classList.add('hidden');
    const docBtnNew = $('apptDocumikeBtn'); if (docBtnNew) docBtnNew.classList.add('hidden');
  } else {
    const lead = await loadAppointmentLeadById(a.lead_id);
    if (lead) setSelectedAppointmentLead(lead);
    $('apptForLead').textContent = lead ? `${lead.contact_name || ''} · ${lead.phone || ''}` : '—';
    $('af_scheduled').value = a.scheduled_for ? new Date(a.scheduled_for).toISOString().slice(0,16) : '';
    $('af_duration').value = a.duration_minutes || 60;
    $('af_type').value = a.appointment_type || 'Inspection';
    $('af_status').value = a.status || 'Scheduled';
    $('af_location').value = a.location || '';
    $('af_outcome').value = a.outcome || '';
    $('af_amount').value = a.signed_amount || '';
    $('af_notes').value = a.notes || '';
    renderAppointmentAgentOptions(a.agent_id || '');
    $('apptDeleteBtn').classList.remove('hidden');
    const docBtnEdit = $('apptDocumikeBtn');
    if (docBtnEdit) {
      if (isAdmin()) {
        docBtnEdit.classList.remove('hidden');
        docBtnEdit.dataset.appointmentId = id;
      } else {
        docBtnEdit.classList.add('hidden');
      }
    }
  }

  $('apptModal').classList.remove('hidden');
}

// ====== DOCUMIKE INTEGRATION ======
// Opens the DocuMike (Partner Contracts) tab with the appointment's client info
// pre-filled into the Create Request modal.
async function openDocuMikeForAppointment(appointmentId) {
  try {
    const appt = allAppts.find(a => a.id === appointmentId);
    if (!appt) {
      alert('Could not find that appointment.');
      return;
    }
    const lead = appt.lead_id ? (getLeadCached(appt.lead_id) || await loadAppointmentLeadById(appt.lead_id)) : null;

    // Build the CRM prefill context to pass into the wizard.
    const clientName = lead?.contact_name || '';
    const addressParts = [lead?.address, lead?.city, lead?.state, lead?.zip].filter(Boolean);
    const { first: firstName, last: lastName } = (() => {
      const parts = String(clientName).trim().split(/\s+/);
      return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
    })();

    const prefill = {
      client_name: clientName,
      client_first_name: firstName,
      client_last_name: lastName,
      client_email: lead?.email || '',
      client_phone: lead?.phone || '',
      address_full: addressParts.join(', '),
      address_street: lead?.address || '',
      address_city: lead?.city || '',
      address_state: lead?.state || '',
      address_zip: lead?.zip || '',
      type_of_loss: lead?.damage_type || '',
      date_today: new Date().toISOString().slice(0, 10),
      execution_date: new Date().toISOString().slice(0, 10),
      property_address: addressParts.join(', ')
    };

    $('apptModal')?.classList.add('hidden');
    showView('partner-contracts');

    // Wait for the DocuMike bridge AND the new wizard function to be ready
    const waitFor = (predicate) => new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        if (predicate()) return resolve(true);
        if (tries++ > 50) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
    const ready = await waitFor(() => typeof window.openDocuMikeWizard === 'function' && window.partnerContractsBridge);
    if (!ready) {
      alert('DocuMike has not finished loading. Refresh and try again.');
      return;
    }

    await window.openDocuMikeWizard({ appointment: appt, lead, prefill });
  } catch (err) {
    console.error('openDocuMikeForAppointment error:', err);
    alert('Could not open DocuMike: ' + (err?.message || err));
  }
}
window.openDocuMikeForAppointment = openDocuMikeForAppointment;

// Wire DocuMike button inside the appointment modal
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('apptDocumikeBtn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const id = btn.dataset.appointmentId || editingApptId;
      if (id) openDocuMikeForAppointment(id);
    });
  }
});

$('af_lead_search')?.addEventListener('input', () => {
  const query = $('af_lead_search').value;
  const selectedLabel = getLeadLookupLabel(apptLeadSelected);

  if (apptLeadSelected && query !== selectedLabel) {
    clearSelectedAppointmentLead(false);
  }

  clearTimeout(apptLeadSearchTimer);
  apptLeadSearchTimer = setTimeout(() => {
    searchAppointmentLeads(query);
  }, 250);
});

$('af_lead_search')?.addEventListener('focus', () => {
  const query = $('af_lead_search').value.trim();
  if (!query) {
    renderAppointmentLeadResults([], query, 'Start typing at least 2 characters to find a lead.');
    return;
  }
  if (query.length >= 2 && !apptLeadSelected) {
    searchAppointmentLeads(query);
  }
});

document.addEventListener('click', (e) => {
  const lookup = $('apptLeadLookup');
  if (!lookup) return;
  if (!lookup.contains(e.target)) {
    renderAppointmentLeadResults([], '', '');
  }
});

// New Appointment button on the Appointments page
$('newApptBtn').addEventListener('click', () => {
  openApptModal(null);
});

$('af_agent')?.addEventListener('change', updateAppointmentAgentTeamPreview);

$('apptSaveBtn').addEventListener('click', async () => {
  const leadId = $('af_lead').value;
  if (!leadId) { alert('Please select a lead for this appointment.'); return; }
  if (!$('af_scheduled').value) { alert('Please choose a date and time.'); return; }

  const payload = {
    lead_id: leadId,
    agent_id: $('af_agent')?.value || null,
    scheduled_for: $('af_scheduled').value || null,
    duration_minutes: parseInt($('af_duration').value) || 60,
    appointment_type: $('af_type').value || 'Inspection',
    status: $('af_status').value || 'Scheduled',
    location: $('af_location').value || null,
    outcome: $('af_outcome').value || null,
    signed_amount: $('af_amount').value ? parseFloat($('af_amount').value) : null,
    notes: $('af_notes').value || null
  };

  let result;
  if (editingApptId) {
    result = await sb.from('crm_appointments').update(payload).eq('id', editingApptId);
  } else {
    // Note: agent_id intentionally omitted to avoid PostgREST schema cache issues
    result = await sb.from('crm_appointments').insert(payload);
    // Bump linked lead status to "Booked" if scheduled
    if (!result.error && payload.status === 'Scheduled') {
      await sb.from('crm_leads').update({ status: 'Booked' }).eq('id', leadId);
    }
  }
  if (result.error) { alert('❌ ' + result.error.message); return; }
  closeAllModals();
  await loadAll();
  initMessageRealtime();
});

$('apptDeleteBtn').addEventListener('click', async () => {
  if (!editingApptId) return;
  if (!confirm('Delete this appointment?')) return;
  const { error } = await sb.from('crm_appointments').delete().eq('id', editingApptId);
  if (error) { alert('❌ ' + error.message); return; }
  closeAllModals();
  await loadAll();
  initMessageRealtime();
});

// ====== MODAL CLOSE ======
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeAllModals));
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) closeAllModals(); });
});
function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  editingCallId = null;
  if ($('callDeleteBtn')) $('callDeleteBtn').classList.add('hidden');
  if ($('callSaveBtn')) $('callSaveBtn').textContent = 'Save Call';
  if ($('callModalTitle')) $('callModalTitle').innerHTML = '<i class="fas fa-phone"></i> Log a Call';
}


// ====== ADMIN MANAGE AGENTS ======
async function callAdminAgentsApi(action, payload = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('You are not signed in.');

  const response = await fetch('/.netlify/functions/admin-agents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + session.access_token
    },
    body: JSON.stringify({ action, ...payload })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || 'Admin agent action failed.');
  }
  return json;
}

function setAgentAdminStatus(message, type = '') {
  const el = $('agentAdminStatus');
  if (!el) return;
  if (!message) {
    el.className = 'agent-admin-status hidden';
    el.innerHTML = '';
    return;
  }
  el.className = 'agent-admin-status' + (type ? ' ' + type : '');
  el.innerHTML = message;
}

async function loadManagedAgents() {
  if (!isSuperAdmin()) return;
  try {
    const result = await callAdminAgentsApi('list');
    managedAgents = result.agents || [];
    renderManagedAgents();
    setAgentAdminStatus('Admin tools connected. You can create users, reset passwords, remove agents, and toggle admin access from here.', 'success');
  } catch (error) {
    managedAgents = [];
    renderManagedAgents();
    setAgentAdminStatus('Manage Agents backend is not ready yet. Add the Netlify environment variables <strong>SUPABASE_URL</strong> and <strong>SUPABASE_SERVICE_ROLE_KEY</strong>, then redeploy. Error: ' + escapeHtml(error.message), 'error');
  }
}

function renderManagedAgents() {
  if (!isSuperAdmin()) return;
  const tbody = $('managedAgentsBody');
  if (!tbody) return;

  renderAgentPerformanceTable();
  refreshTeamFilterOptions();

  $('agentSummaryTotal').textContent = String(managedAgents.length || 0);
  $('agentSummaryAdmins').textContent = String(managedAgents.filter(a => a.role === 'admin').length || 0);
  $('agentSummaryAgents').textContent = String(managedAgents.filter(a => a.role !== 'admin').length || 0);
  const lastSeen = managedAgents
    .filter(a => a.last_sign_in_at)
    .sort((a, b) => new Date(b.last_sign_in_at) - new Date(a.last_sign_in_at))[0];
  $('agentSummaryLastSeen').textContent = lastSeen?.last_sign_in_at ? formatDateTime(lastSeen.last_sign_in_at) : 'No sign-ins yet';

  if (!managedAgents.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No managed users returned yet. Create your first agent above.</td></tr>';
  } else {
    // v3.5.4: Compute existing team options from current roster (so user-created teams persist in the dropdown)
    const hardcodedTeams = Object.keys(HARDCODED_TEAM_MATCHERS);
    const existingTeams = new Set(hardcodedTeams);
    managedAgents.forEach(a => {
      const t = String(a.team_label || '').trim();
      if (t && t !== 'Unassigned') existingTeams.add(t);
    });
    const teamOptions = Array.from(existingTeams).sort();

    tbody.innerHTML = managedAgents.map(agent => {
      const roleClass = agent.role === 'admin' ? 'status-Signed' : 'status-New';
      const toggleLabel = agent.role === 'admin' ? 'Remove Admin' : 'Make Admin';
      const currentTeam = getManagedAgentTeamLabel(agent, 'Unassigned');
      const teamSelectHtml = `
        <select class="team-select" data-action="set-team" data-id="${agent.id}" title="Assign team">
          <option value="" ${currentTeam === 'Unassigned' ? 'selected' : ''}>— Unassigned —</option>
          ${teamOptions.map(t => `<option value="${escapeHtml(t)}" ${t === currentTeam ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
          <option value="__new__">➕ New team…</option>
        </select>
      `;
      return `<tr>
        <td><strong>${escapeHtml(agent.display_name || agent.email?.split('@')[0] || 'Agent')}</strong></td>
        <td>${escapeHtml(agent.email || '—')}</td>
        <td><span class="status-pill ${roleClass}">${escapeHtml(agent.role === 'admin' ? 'Admin' : 'Agent')}</span></td>
        <td>${teamSelectHtml}</td>
        <td>${escapeHtml(formatDateTime(agent.created_at))}</td>
        <td>${escapeHtml(agent.last_sign_in_at ? formatDateTime(agent.last_sign_in_at) : 'Never')}</td>
        <td>
          <div class="agent-action-row">
            <button class="btn-view agent-action-btn" data-action="toggle-admin" data-id="${agent.id}">${escapeHtml(toggleLabel)}</button>
            <button class="btn-view agent-action-btn" data-action="reset-password" data-id="${agent.id}">Reset Password</button>
            <button class="btn-danger agent-delete-btn" data-action="remove-agent" data-id="${agent.id}">Remove</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action]').forEach(btn => {
      // v3.5.4: Team <select> change handler
      if (btn.tagName === 'SELECT' && btn.dataset.action === 'set-team') {
        btn.addEventListener('change', async (e) => {
          e.stopPropagation();
          const agent = managedAgents.find(item => item.id === btn.dataset.id);
          if (!agent) return;
          await handleSetTeam(agent, btn);
        });
        return;
      }
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const agent = managedAgents.find(item => item.id === btn.dataset.id);
        if (!agent) return;
        const action = btn.dataset.action;
        if (action === 'toggle-admin') await handleToggleAdmin(agent);
        if (action === 'reset-password') await handleResetPassword(agent);
        if (action === 'remove-agent') await handleRemoveAgent(agent);
      });
    });
  }
}

function buildAgentPerformanceRows() {
  const directory = new Map();

  managedAgents.forEach(agent => {
    directory.set(agent.id, {
      id: agent.id,
      display_name: agent.display_name || '',
      email: agent.email || '',
      role: agent.role || 'agent',
      team_label: getManagedAgentTeamLabel(agent, ''),
      last_sign_in_at: agent.last_sign_in_at || null,
      created_at: agent.created_at || null
    });
  });

  roleDirectory.forEach(row => {
    if (!row?.user_id) return;
    const existing = directory.get(row.user_id) || {
      id: row.user_id,
      display_name: '',
      email: '',
      role: row.role || 'agent',
      team_label: getAgentTeamLabel(row.user_id, ''),
      last_sign_in_at: null,
      created_at: null
    };
    existing.display_name = existing.display_name || row.display_name || '';
    existing.email = existing.email || row.email || '';
    existing.role = row.role || existing.role || 'agent';
    existing.team_label = getAgentTeamLabel(row.user_id, existing.team_label || '');
    directory.set(row.user_id, existing);
  });

  [...allCalls, ...allAppts].forEach(item => {
    const id = item.agent_id;
    if (!id || directory.has(id)) return;
    directory.set(id, {
      id,
      display_name: getAgentDisplayName(id),
      email: '',
      role: 'agent',
      team_label: getAgentTeamLabel(id, ''),
      last_sign_in_at: null,
      created_at: null
    });
  });

  const now = new Date();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return [...directory.values()].map(agent => {
    const calls = allCalls.filter(call => call.agent_id === agent.id);
    const appts = allAppts.filter(appt => appt.agent_id === agent.id);
    const callsToday = calls.filter(call => call.created_at && new Date(call.created_at) >= today).length;
    const answered = calls.filter(call => call.answered).length;
    const presented = calls.filter(call => call.allowed_presentation).length;
    const booked = calls.filter(call => call.appointment_booked).length;
    const upcoming = appts.filter(appt => appt.scheduled_for && new Date(appt.scheduled_for) >= now && !['Cancelled', 'Completed', 'Signed', 'No-show'].includes(appt.status || '')).length;
    const completed = appts.filter(appt => ['Completed', 'Signed'].includes(appt.status || '')).length;
    const signedAmount = appts.reduce((sum, appt) => sum + (Number(appt.signed_amount) || 0), 0);
    const lastCallAt = calls[0]?.created_at || null;
    const lastApptAt = appts
      .map(appt => appt.scheduled_for || appt.created_at || null)
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const lastActivity = [lastCallAt, lastApptAt, agent.last_sign_in_at].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;

    return {
      ...agent,
      label: agent.display_name || agent.email?.split('@')[0] || getAgentDisplayName(agent.id),
      teamLabel: normalizeTeamLabel(agent.team_label),
      callsToday,
      totalCalls: calls.length,
      answered,
      presented,
      booked,
      upcoming,
      completed,
      signedAmount,
      lastActivity
    };
  }).sort((a, b) => b.totalCalls - a.totalCalls || b.booked - a.booked || b.signedAmount - a.signedAmount || a.label.localeCompare(b.label));
}

function renderAgentPerformanceTable() {
  if (!isSuperAdmin()) return;
  const tbody = $('agentPerformanceBody');
  if (!tbody) return;

  const rows = buildAgentPerformanceRows();
  const totals = rows.reduce((acc, row) => {
    acc.calls += row.totalCalls;
    acc.booked += row.booked;
    acc.upcoming += row.upcoming;
    acc.revenue += row.signedAmount;
    return acc;
  }, { calls: 0, booked: 0, upcoming: 0, revenue: 0 });

  if ($('perfTeamCalls')) $('perfTeamCalls').textContent = String(totals.calls);
  if ($('perfTeamBooked')) $('perfTeamBooked').textContent = String(totals.booked);
  if ($('perfTeamUpcoming')) $('perfTeamUpcoming').textContent = String(totals.upcoming);
  if ($('perfTeamRevenue')) $('perfTeamRevenue').textContent = formatMoney(totals.revenue);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="loading-row">No agent stats yet. Once calls and appointments are logged, each agent will show up here.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const roleClass = row.role === 'admin' ? 'status-Signed' : 'status-New';
    return `<tr>
      <td>
        <div class="agent-performance-name">
          <strong>${escapeHtml(row.label)}</strong>
          <small>${escapeHtml(row.email || 'No email shown')}</small>
        </div>
      </td>
      <td><span class="status-pill ${roleClass}">${escapeHtml(row.role === 'admin' ? 'Admin' : 'Agent')}</span></td>
      <td>${renderTeamBadge(row.teamLabel)}</td>
      <td>${row.callsToday}</td>
      <td>${row.totalCalls}</td>
      <td>${row.answered}</td>
      <td>${row.booked}</td>
      <td>${row.upcoming}</td>
      <td>${row.completed}</td>
      <td class="agent-performance-money">${escapeHtml(formatMoney(row.signedAmount))}</td>
      <td>${escapeHtml(row.lastActivity ? formatDateTime(row.lastActivity) : 'No activity yet')}</td>
    </tr>`;
  }).join('');
}

async function createAgentFromDashboard() {
  const email = $('agentEmail').value.trim().toLowerCase();
  const password = $('agentPassword').value.trim();
  const displayName = $('agentDisplayName').value.trim();
  const role = $('agentMakeAdmin').checked ? 'admin' : 'agent';

  if (!email) {
    setAgentAdminStatus('Enter an email for the new agent.', 'warning');
    return;
  }
  if (password.length < 8) {
    setAgentAdminStatus('Temporary password must be at least 8 characters.', 'warning');
    return;
  }

  try {
    setAgentAdminStatus('Creating agent login…');
    await callAdminAgentsApi('create', { email, password, display_name: displayName, role });
    $('agentEmail').value = '';
    $('agentPassword').value = '';
    $('agentDisplayName').value = '';
    $('agentMakeAdmin').checked = false;
    await loadRoleDirectory();
    await loadManagedAgents();
    setAgentAdminStatus(`Created ${escapeHtml(email)} successfully.`, 'success');
  } catch (error) {
    setAgentAdminStatus('Could not create agent: ' + escapeHtml(error.message), 'error');
  }
}

// v3.5.4: Persist team_label change to crm_user_roles via admin-agents function
async function handleSetTeam(agent, selectEl) {
  let teamLabel = String(selectEl.value || '');
  if (teamLabel === '__new__') {
    const newName = prompt('Enter a new team name (e.g., "Storm Team"):');
    if (!newName || !newName.trim()) {
      // Restore previous selection
      selectEl.value = (getManagedAgentTeamLabel(agent, 'Unassigned') === 'Unassigned') ? '' : getManagedAgentTeamLabel(agent);
      return;
    }
    teamLabel = newName.trim().slice(0, 60);
  }
  const previous = getManagedAgentTeamLabel(agent, '');
  try {
    setAgentAdminStatus(`Updating team for ${escapeHtml(agent.display_name || agent.email)}…`);
    await callAdminAgentsApi('set-team', {
      user_id: agent.id,
      team_label: teamLabel || null,
      display_name: agent.display_name,
      email: agent.email,
      role: agent.role
    });
    await loadRoleDirectory();
    await loadManagedAgents();
    const finalLabel = teamLabel || 'Unassigned';
    setAgentAdminStatus(`${escapeHtml(agent.display_name || agent.email)} is now in <strong>${escapeHtml(finalLabel)}</strong>.`, 'success');
  } catch (error) {
    setAgentAdminStatus('Could not update team: ' + escapeHtml(error.message), 'error');
    // Restore previous selection in dropdown
    selectEl.value = previous && previous !== 'Unassigned' ? previous : '';
  }
}

async function handleToggleAdmin(agent) {
  const nextRole = agent.role === 'admin' ? 'agent' : 'admin';
  if (agent.id === currentUser.id && nextRole !== 'admin') {
    setAgentAdminStatus('You cannot remove your own admin access from inside the dashboard.', 'warning');
    return;
  }
  try {
    setAgentAdminStatus(`Updating ${escapeHtml(agent.email)}…`);
    await callAdminAgentsApi('set-role', {
      user_id: agent.id,
      role: nextRole,
      display_name: agent.display_name,
      email: agent.email
    });
    await loadRoleDirectory();
    await loadManagedAgents();
    setAgentAdminStatus(`${escapeHtml(agent.email)} is now ${escapeHtml(nextRole)}.`, 'success');
  } catch (error) {
    setAgentAdminStatus('Could not update role: ' + escapeHtml(error.message), 'error');
  }
}

async function handleResetPassword(agent) {
  const nextPassword = prompt(`Enter a new temporary password for ${agent.email}`);
  if (!nextPassword) return;
  if (nextPassword.length < 8) {
    setAgentAdminStatus('New password must be at least 8 characters.', 'warning');
    return;
  }
  try {
    setAgentAdminStatus(`Resetting password for ${escapeHtml(agent.email)}…`);
    await callAdminAgentsApi('reset-password', {
      user_id: agent.id,
      password: nextPassword
    });
    setAgentAdminStatus(`Password reset for ${escapeHtml(agent.email)}. Share the temporary password securely.`, 'success');
  } catch (error) {
    setAgentAdminStatus('Could not reset password: ' + escapeHtml(error.message), 'error');
  }
}

async function handleRemoveAgent(agent) {
  if (agent.id === currentUser.id) {
    setAgentAdminStatus('You cannot delete your own admin login from inside the dashboard.', 'warning');
    return;
  }
  if (!confirm(`Remove ${agent.email}? This deletes their login.`)) return;
  try {
    setAgentAdminStatus(`Removing ${escapeHtml(agent.email)}…`);
    await callAdminAgentsApi('delete', { user_id: agent.id });
    await loadRoleDirectory();
    await loadManagedAgents();
    setAgentAdminStatus(`${escapeHtml(agent.email)} was removed.`, 'success');
  } catch (error) {
    setAgentAdminStatus('Could not remove agent: ' + escapeHtml(error.message), 'error');
  }
}

$('addAgentBtn')?.addEventListener('click', createAgentFromDashboard);
$('refreshAgentsBtn')?.addEventListener('click', loadManagedAgents);

// =====================================================
// QUO NUMBER ASSIGNMENTS (admin-only)
// Maps each agent to one of your 3 Quo numbers.
// =====================================================
let quoNumberPool = [];
let agentAssignments = []; // [{ agent_id, agent_email, quo_phone_number, is_active }]

function setAssignmentsStatus(msg, kind = '') {
  const el = $('assignmentsStatus');
  if (!el) return;
  if (!msg) { el.className = 'agent-admin-status hidden'; el.textContent = ''; return; }
  el.className = 'agent-admin-status' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  if (kind === 'success') setTimeout(() => { if (el.textContent === msg) setAssignmentsStatus(''); }, 3000);
}

async function loadQuoNumberPool() {
  try {
    const res = await fetch('/.netlify/functions/quo-numbers');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'quo-numbers fetch failed');
    quoNumberPool = Array.isArray(data.numbers) ? data.numbers : [];
  } catch (err) {
    console.warn('[assignments] loadQuoNumberPool:', err.message);
    quoNumberPool = [];
  }
}

async function loadAgentAssignments() {
  try {
    const { data, error } = await sb
      .from('agent_number_assignments')
      .select('id, agent_id, agent_email, agent_display_name, team_label, quo_phone_number, quo_phone_id, is_active, assigned_at');
    if (error) throw error;
    agentAssignments = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('[assignments] loadAgentAssignments:', err.message);
    agentAssignments = [];
  }
}

async function loadNumberReputations() {
  try {
    const { data, error } = await sb
      .from('quo_number_reputation')
      .select('phone_number, flagged_status, paused, flagged_at');
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function renderAgentAssignments(reputations = []) {
  const tbody = $('agentAssignmentsBody');
  if (!tbody) return;

  const agents = Array.isArray(managedAgents) ? managedAgents : [];
  if (!agents.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-row">No agents yet. Add agents in the panel above first.</td></tr>';
    return;
  }
  if (!quoNumberPool.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-row">No Quo numbers loaded. Check that QUO_API_KEY is set in Netlify.</td></tr>';
    return;
  }

  const repMap = new Map(reputations.map((r) => [String(r.phone_number || '').trim(), r]));
  const assignedNumbers = new Set(agentAssignments.filter((a) => a.is_active).map((a) => a.quo_phone_number));

  tbody.innerHTML = agents.map((agent) => {
    const myAssignment = agentAssignments.find((a) => a.agent_id === agent.id || a.agent_email === agent.email);
    const myNumber = myAssignment?.quo_phone_number || '';
    const rep = repMap.get(myNumber);
    const isFlagged = rep && (rep.paused || (rep.flagged_status && rep.flagged_status !== 'ok'));

    const teamLabel = agent.team_label || resolveTeamLabel(agent.email) || '';
    const displayName = agent.display_name || agent.full_name || (agent.email || '').split('@')[0];

    const options = quoNumberPool.map((n) => {
      const taken = assignedNumbers.has(n.number) && n.number !== myNumber;
      const repForN = repMap.get(n.number);
      const flaggedLabel = repForN && (repForN.paused || (repForN.flagged_status && repForN.flagged_status !== 'ok')) ? ' ⚠' : '';
      return `<option value="${escapeHtml(n.number)}" ${n.number === myNumber ? 'selected' : ''} ${taken ? 'disabled' : ''}>${escapeHtml(n.number)}${flaggedLabel}${taken ? ' (taken)' : ''}</option>`;
    }).join('');

    const statusBadge = !myNumber
      ? '<span class="cc-pill cc-pill-muted">Unassigned</span>'
      : isFlagged
        ? `<span class="cc-pill cc-pill-warn">⚠ Flagged${rep?.flagged_status && rep.flagged_status !== 'ok' ? ' (' + escapeHtml(rep.flagged_status) + ')' : ''}</span>`
        : '<span class="cc-pill cc-pill-success">Active</span>';

    return `
      <tr data-agent-id="${escapeHtml(agent.id || '')}" data-agent-email="${escapeHtml(agent.email || '')}">
        <td><strong>${escapeHtml(displayName)}</strong></td>
        <td>${renderTeamBadge(teamLabel)}</td>
        <td>${escapeHtml(agent.email || '')}</td>
        <td>
          <select class="cc-input agent-number-select" style="max-width:240px;">
            <option value="">— No assignment —</option>
            ${options}
          </select>
        </td>
        <td>${statusBadge}</td>
        <td>
          <button type="button" class="btn-view save-assignment-btn"><i class="fas fa-save"></i> Save</button>
          ${myNumber ? `<button type="button" class="btn-log-call flag-number-btn" data-number="${escapeHtml(myNumber)}" data-flagged="${isFlagged ? '1' : '0'}">${isFlagged ? '✓ Unflag' : '⚠ Flag'}</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  // Prevent click events on the row from bubbling to any outer click handlers
  // that might trigger a re-render (which would close an open dropdown).
  tbody.querySelectorAll('tr[data-agent-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      // Only stop bubbling for clicks inside form elements - don't break legit row clicks elsewhere
      if (e.target.closest('select, button, input, textarea')) {
        e.stopPropagation();
      }
    });
  });

  // Wire up save buttons
  tbody.querySelectorAll('.save-assignment-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tr = e.target.closest('tr');
      if (!tr) return;
      const agentId = tr.dataset.agentId;
      const agentEmail = tr.dataset.agentEmail;
      const select = tr.querySelector('.agent-number-select');
      const newNumber = String(select?.value || '').trim();
      await saveAgentAssignment(agentId, agentEmail, newNumber);
    });
  });

  // Wire up flag buttons
  tbody.querySelectorAll('.flag-number-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const number = btn.dataset.number;
      const isFlagged = btn.dataset.flagged === '1';
      await toggleNumberFlag(number, !isFlagged);
    });
  });

  // Make sure the dropdown itself doesn't trigger any outer handlers
  tbody.querySelectorAll('.agent-number-select').forEach((sel) => {
    ['mousedown', 'click', 'focus', 'change'].forEach((evt) => {
      sel.addEventListener(evt, (e) => e.stopPropagation());
    });
  });
}

async function saveAgentAssignment(agentId, agentEmail, quoNumber) {
  setAssignmentsStatus('Saving assignment...', 'info');
  try {
    const existing = agentAssignments.find((a) => a.agent_id === agentId || a.agent_email === agentEmail);
    if (!quoNumber) {
      if (existing) {
        const { error } = await sb.from('agent_number_assignments').delete().eq('id', existing.id);
        if (error) throw error;
      }
    } else {
      const agent = managedAgents.find((a) => a.id === agentId || a.email === agentEmail);
      const teamLabel = agent?.team_label || resolveTeamLabel(agentEmail) || '';
      const displayName = agent?.display_name || agent?.full_name || (agentEmail || '').split('@')[0];
      const quoPhone = quoNumberPool.find((n) => n.number === quoNumber);
      const payload = {
        agent_id: agentId,
        agent_email: agentEmail,
        agent_display_name: displayName,
        team_label: teamLabel,
        quo_phone_number: quoNumber,
        quo_phone_id: quoPhone?.id || null,
        is_active: true,
        assigned_by: currentUser?.id || null
      };
      if (existing) {
        const { error } = await sb.from('agent_number_assignments').update(payload).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from('agent_number_assignments').insert(payload);
        if (error) throw error;
      }
    }
    setAssignmentsStatus('Assignment saved.', 'success');
    await refreshAgentAssignmentsView();
  } catch (err) {
    setAssignmentsStatus('Could not save: ' + err.message, 'error');
  }
}

async function toggleNumberFlag(phoneNumber, shouldFlag) {
  setAssignmentsStatus(shouldFlag ? 'Flagging number...' : 'Clearing flag...', 'info');
  try {
    const { data: existing } = await sb
      .from('quo_number_reputation')
      .select('id')
      .eq('phone_number', phoneNumber)
      .maybeSingle();
    const payload = {
      phone_number: phoneNumber,
      flagged_status: shouldFlag ? 'spam_likely' : 'ok',
      flagged_at: shouldFlag ? new Date().toISOString() : null,
      paused: shouldFlag
    };
    if (existing?.id) {
      const { error } = await sb.from('quo_number_reputation').update(payload).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from('quo_number_reputation').insert(payload);
      if (error) throw error;
    }
    setAssignmentsStatus(shouldFlag ? 'Number flagged.' : 'Flag cleared.', 'success');
    await refreshAgentAssignmentsView();
  } catch (err) {
    setAssignmentsStatus('Could not update flag: ' + err.message, 'error');
  }
}

async function refreshAgentAssignmentsView() {
  // Bail out if the user is currently interacting with a dropdown (avoid clobbering open <select>)
  if (document.activeElement && document.activeElement.classList?.contains('agent-number-select')) {
    console.log('[assignments] skipping refresh - user is interacting with a dropdown');
    return;
  }
  await Promise.all([loadQuoNumberPool(), loadAgentAssignments(), loadManagedAgents()]);
  const reps = await loadNumberReputations();
  renderAgentAssignments(reps);
}

function resolveTeamLabel(email) {
  const lower = String(email || '').toLowerCase();
  for (const [team, matchers] of Object.entries(HARDCODED_TEAM_MATCHERS || {})) {
    if ((matchers || []).some((m) => lower.includes(String(m).toLowerCase()))) return team;
  }
  return '';
}

$('refreshAssignmentsBtn')?.addEventListener('click', refreshAgentAssignmentsView);

// Load assignments ONCE when the admin first navigates to the Manage Agents tab,
// not on every renderManagedAgents() call (which fires on many events).
// Re-rendering the assignments table while a dropdown is open would close it.
let _assignmentsLoadedOnce = false;
document.querySelectorAll('.nav-item[data-view="agent-admin"]').forEach((navEl) => {
  navEl.addEventListener('click', () => {
    if (_assignmentsLoadedOnce) return;
    _assignmentsLoadedOnce = true;
    setTimeout(() => refreshAgentAssignmentsView().catch(() => null), 300);
  });
});

// ====== HELPERS ======
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  const now = new Date();
  const diff = (now - dt) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.round(diff/60) + 'm ago';
  if (diff < 86400) return Math.round(diff/3600) + 'h ago';
  if (diff < 7*86400) return Math.round(diff/86400) + 'd ago';
  return dt.toLocaleDateString();
}
function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}
function formatMoney(value) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

// Init
initTrainingTab();
renderTrainingMode();
renderMapMode();
updateTrainingSyncStatus();
checkSession();


// ====== MESSAGES ======
const MESSAGE_AVATAR_BACKGROUNDS = [
  'linear-gradient(135deg, #2563eb, #06b6d4)',
  'linear-gradient(135deg, #7c3aed, #ec4899)',
  'linear-gradient(135deg, #059669, #14b8a6)',
  'linear-gradient(135deg, #ea580c, #f59e0b)',
  'linear-gradient(135deg, #dc2626, #fb7185)',
  'linear-gradient(135deg, #4f46e5, #60a5fa)'
];


function getMessagesFallbackKey() {
  return `${MESSAGES_FALLBACK_STORAGE_KEY}:${currentUser?.id || 'anon'}`;
}

function createMessageUuid(prefix = 'msg') {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readMessagesFallbackStore() {
  if (!currentUser) return { conversations: [], participants: [], messages: [] };
  try {
    const raw = window.localStorage.getItem(getMessagesFallbackKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      conversations: Array.isArray(parsed?.conversations) ? parsed.conversations : [],
      participants: Array.isArray(parsed?.participants) ? parsed.participants : [],
      messages: Array.isArray(parsed?.messages) ? parsed.messages : []
    };
  } catch (error) {
    console.warn('Could not read fallback messages store', error);
    return { conversations: [], participants: [], messages: [] };
  }
}

function writeMessagesFallbackStore(store) {
  if (!currentUser) return;
  try {
    window.localStorage.setItem(getMessagesFallbackKey(), JSON.stringify({
      conversations: Array.isArray(store?.conversations) ? store.conversations : [],
      participants: Array.isArray(store?.participants) ? store.participants : [],
      messages: Array.isArray(store?.messages) ? store.messages : []
    }));
  } catch (error) {
    console.warn('Could not persist fallback messages store', error);
  }
}

function applyMessagesState(conversations = [], participants = [], messages = [], options = {}) {
  messageConversations = [...(conversations || [])].sort((a, b) => {
    const pinDiff = Number(!!b.is_pinned) - Number(!!a.is_pinned);
    if (pinDiff) return pinDiff;
    return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
  });

  messageParticipants = new Map();
  (participants || []).forEach(part => {
    const list = messageParticipants.get(part.conversation_id) || [];
    list.push(part);
    messageParticipants.set(part.conversation_id, list);
  });

  messageThreads = new Map();
  (messages || []).forEach(msg => {
    const list = messageThreads.get(msg.conversation_id) || [];
    list.push(msg);
    messageThreads.set(msg.conversation_id, list);
  });
  for (const list of messageThreads.values()) {
    list.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  }

  if (!options.preserveSelection || !messageConversations.some(convo => convo.id === activeConversationId)) {
    activeConversationId = messageConversations[0]?.id || null;
  }

  renderMessagesView();
  updateMessagesBadge();
}

function loadMessagesFallback(options = {}, error = null) {
  messagesMode = 'fallback';
  teardownMessageRealtime();
  const store = readMessagesFallbackStore();
  applyMessagesState(store.conversations, store.participants, store.messages, options);
  if (error) console.warn('Messages fallback mode active', error);
  setMessagesStatus('Messages are running in device-only backup mode until the Supabase schema is live.', 'warning');
}

function getMessageUserOptions() {
  const users = roleDirectory
    .filter(row => row.user_id && row.user_id !== currentUser?.id)
    .map(row => ({
      id: row.user_id,
      name: row.display_name || (row.email ? row.email.split('@')[0] : 'User'),
      email: row.email || '',
      role: row.role || 'agent'
    }));

  const map = new Map();
  users.forEach(user => {
    if (!map.has(user.id)) map.set(user.id, user);
  });

  return [...map.values()].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function setMessagesStatus(message = '', type = '') {
  const el = $('messagesStatus');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.className = 'agent-admin-status hidden';
    return;
  }
  el.textContent = message;
  el.className = 'agent-admin-status' + (type ? ' ' + type : '');
}

function hashString(value = '') {
  return [...String(value)].reduce((acc, char) => acc + char.charCodeAt(0), 0);
}

function getAvatarBackground(seed = '') {
  return MESSAGE_AVATAR_BACKGROUNDS[hashString(seed) % MESSAGE_AVATAR_BACKGROUNDS.length];
}

function getInitials(text = '') {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'M';
  return parts.slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || 'M';
}

function conversationParticipantsFor(id) {
  return messageParticipants.get(id) || [];
}

function getConversationOtherUsers(conversation) {
  return conversationParticipantsFor(conversation.id).filter(part => part.user_id !== currentUser?.id);
}

function getConversationTitle(conversation) {
  const custom = String(conversation?.title || '').trim();
  if (custom) return custom;
  const others = getConversationOtherUsers(conversation);
  if (!others.length) return 'Just you';
  const names = others.map(part => getAgentDisplayName(part.user_id));
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function getConversationMeta(conversation) {
  const others = getConversationOtherUsers(conversation);
  if (!others.length) return 'Private notes';
  if (others.length > 1 || String(conversation?.title || '').trim()) {
    return `Group chat · ${others.length + 1} members`;
  }
  return others.map(part => {
    const role = findRoleRow(part.user_id)?.role || 'agent';
    return `${getAgentDisplayName(part.user_id)} · ${role === 'admin' ? 'Admin' : 'Agent'}`;
  }).join(' • ');
}

function getConversationAvatarText(conversation) {
  return getInitials(getConversationTitle(conversation));
}

function getConversationPreview(message) {
  if (!message) return 'Start the conversation';
  if (message.deleted_at) return 'Start the conversation';
  return String(message.body || '').trim() || 'Start the conversation';
}

function getLastReadAt(conversationId) {
  const selfPart = conversationParticipantsFor(conversationId).find(part => part.user_id === currentUser?.id);
  return selfPart?.last_read_at ? new Date(selfPart.last_read_at).getTime() : 0;
}

function getUnreadCount(conversationId) {
  const cutoff = getLastReadAt(conversationId);
  return (messageThreads.get(conversationId) || []).filter(msg => !msg.deleted_at && msg.sender_id !== currentUser?.id && new Date(msg.created_at).getTime() > cutoff).length;
}

function updateMessagesBadge() {
  const totalUnread = messageConversations.reduce((sum, convo) => sum + getUnreadCount(convo.id), 0);
  const badge = $('messagesUnreadBadge');
  if (!badge) return;
  badge.textContent = String(totalUnread);
  badge.classList.toggle('hidden', totalUnread <= 0);
}

function canManageConversation(conversation) {
  return !!conversation && (isAdmin() || conversation.created_by === currentUser?.id);
}

function canDeleteMessage(message) {
  return !!message && !message.deleted_at && (message.sender_id === currentUser?.id || isAdmin());
}

function getActiveConversation() {
  return messageConversations.find(convo => convo.id === activeConversationId) || null;
}

function populateMessageRecipients() {
  const select = $('messagesRecipientSelect');
  const checklist = $('messagesGroupChecklist');
  const addSelect = $('messagesAddMemberSelect');
  const previous = select?.value || '';
  const previousChecked = new Set(Array.from(document.querySelectorAll('input[name="messagesGroupRecipients"]:checked')).map(input => input.value));
  const options = getMessageUserOptions();

  if (select) {
    select.innerHTML = '<option value="">Select teammate…</option>';
    options.forEach(user => {
      const option = document.createElement('option');
      option.value = user.id;
      option.textContent = `${user.name} (${user.role === 'admin' ? 'Admin' : 'Agent'})`;
      select.appendChild(option);
    });
    if (options.some(option => option.id === previous)) select.value = previous;
  }

  if (checklist) {
    checklist.innerHTML = '';
    if (!options.length) {
      checklist.innerHTML = '<div class="messages-group-empty">No teammates available yet.</div>';
    } else {
      options.forEach(user => {
        const label = document.createElement('label');
        label.className = 'messages-group-item';
        label.innerHTML = `
          <input type="checkbox" name="messagesGroupRecipients" value="${escapeHtml(user.id)}" ${previousChecked.has(user.id) ? 'checked' : ''} />
          <span>
            <strong>${escapeHtml(user.name)}</strong>
            <small>${escapeHtml(user.role === 'admin' ? 'Admin' : 'Agent')} · ${escapeHtml(user.email || 'No email')}</small>
          </span>
        `;
        checklist.appendChild(label);
      });
    }
  }

  if (addSelect) {
    const convo = getActiveConversation();
    const existingIds = new Set(convo ? conversationParticipantsFor(convo.id).map(part => part.user_id) : []);
    addSelect.innerHTML = '<option value="">Select teammate…</option>';
    options.filter(user => !existingIds.has(user.id)).forEach(user => {
      const option = document.createElement('option');
      option.value = user.id;
      option.textContent = `${user.name} (${user.role === 'admin' ? 'Admin' : 'Agent'})`;
      addSelect.appendChild(option);
    });
  }

  populateRemoveMemberSelect();
}

function populateRemoveMemberSelect() {
  const select = $('messagesRemoveMemberSelect');
  if (!select) return;
  const convo = getActiveConversation();
  select.innerHTML = '<option value="">Select member…</option>';
  if (!convo) return;
  conversationParticipantsFor(convo.id)
    .filter(part => part.user_id && part.user_id !== currentUser?.id)
    .forEach(part => {
      const option = document.createElement('option');
      option.value = part.user_id;
      option.textContent = getAgentDisplayName(part.user_id);
      select.appendChild(option);
    });
}

function filterVisibleConversations() {
  const term = ($('messagesSearchInput')?.value || '').trim().toLowerCase();
  if (!term) return messageConversations;
  return messageConversations.filter(convo => {
    const msgs = messageThreads.get(convo.id) || [];
    const last = [...msgs].reverse().find(msg => !msg.deleted_at) || null;
    const haystack = [
      getConversationTitle(convo),
      getConversationMeta(convo),
      getConversationPreview(last)
    ].join(' ').toLowerCase();
    return haystack.includes(term);
  });
}

async function loadMessagesData(options = {}) {
  if (!currentUser) return;
  try {
    const { data: participantRows, error: participantErr } = await sb
      .from('crm_conversation_participants')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (participantErr) throw participantErr;

    const previousMode = messagesMode;
    messagesMode = 'live';
    const conversationIds = [...new Set((participantRows || []).map(row => row.conversation_id).filter(Boolean))];
    if (!conversationIds.length) {
      applyMessagesState([], participantRows || [], [], options);
      if (previousMode !== 'live') {
        initMessageRealtime();
        setMessagesStatus('Supabase messages connected.', 'success');
        window.setTimeout(() => {
          if (messagesMode === 'live' && ($('messagesStatus')?.textContent || '') === 'Supabase messages connected.') setMessagesStatus();
        }, 2200);
      }
      return;
    }

    const [conversationsRes, participantsRes, messagesRes] = await Promise.all([
      sb.from('crm_conversations').select('*').in('id', conversationIds),
      sb.from('crm_conversation_participants').select('*').in('conversation_id', conversationIds),
      sb.from('crm_messages').select('*').in('conversation_id', conversationIds).order('created_at', { ascending: true })
    ]);

    if (conversationsRes.error) throw conversationsRes.error;
    if (participantsRes.error) throw participantsRes.error;
    if (messagesRes.error) throw messagesRes.error;

    applyMessagesState(conversationsRes.data || [], participantsRes.data || [], messagesRes.data || [], options);

    if (previousMode !== 'live') {
      initMessageRealtime();
      setMessagesStatus('Supabase messages connected.', 'success');
      window.setTimeout(() => {
        if (messagesMode === 'live' && ($('messagesStatus')?.textContent || '') === 'Supabase messages connected.') setMessagesStatus();
      }, 2200);
    }
  } catch (error) {
    console.error('Messages load failed', error);
    loadMessagesFallback(options, error);
  }
}

function renderMessagesView() {
  populateMessageRecipients();
  renderConversationList();
  renderActiveConversation();
}

function renderConversationList() {
  const list = $('messagesConversationList');
  if (!list) return;
  const visibleConversations = filterVisibleConversations();
  const countEl = $('messagesConversationCount');
  if (countEl) countEl.textContent = `${visibleConversations.length} chat${visibleConversations.length === 1 ? '' : 's'}`;

  if (!visibleConversations.length) {
    list.innerHTML = '<div class="empty-state small"><i class="fas fa-comments"></i><p>No conversations match your search yet.</p></div>';
    return;
  }

  list.innerHTML = '';
  visibleConversations.forEach(convo => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'messages-conversation-item' + (convo.id === activeConversationId ? ' active' : '');
    const msgs = messageThreads.get(convo.id) || [];
    const last = [...msgs].reverse().find(msg => !msg.deleted_at) || null;
    const unread = getUnreadCount(convo.id);
    const avatarBg = getAvatarBackground(convo.badge_color || convo.title || convo.id);
    const isGroup = conversationParticipantsFor(convo.id).length > 2 || !!String(convo.title || '').trim();
    button.innerHTML = `
      <div class="messages-list-left">
        <div class="messages-avatar" style="background:${avatarBg}">${escapeHtml(getConversationAvatarText(convo))}</div>
        <div style="flex:1;min-width:0;">
          <div class="messages-conversation-top">
            <div>
              <div class="messages-conversation-name">${escapeHtml(getConversationTitle(convo))}</div>
              <div class="messages-conversation-badges">
                ${convo.is_pinned ? '<span class="messages-pin-pill"><i class="fas fa-thumbtack"></i> Pinned</span>' : ''}
                ${isGroup ? '<span class="messages-type-pill">Group</span>' : '<span class="messages-type-pill">Direct</span>'}
              </div>
            </div>
            ${unread ? `<span class="messages-unread-pill">${unread}</span>` : ''}
          </div>
          <div class="messages-meta-row">
            <span class="messages-last-time">${escapeHtml(last ? formatDate(last.created_at) : 'No messages yet')}</span>
            <span class="messages-last-time">${escapeHtml(getConversationMeta(convo))}</span>
          </div>
          <div class="messages-preview">${escapeHtml(getConversationPreview(last))}</div>
        </div>
      </div>
    `;
    button.addEventListener('click', async () => {
      activeConversationId = convo.id;
      renderMessagesView();
      await markConversationRead(convo.id);
    });
    list.appendChild(button);
  });
}

function renderMembersBar(conversation) {
  const bar = $('messagesMembersBar');
  if (!bar) return;
  if (!conversation) {
    bar.innerHTML = '';
    bar.classList.add('hidden');
    return;
  }
  const participants = conversationParticipantsFor(conversation.id);
  bar.innerHTML = '';
  participants.forEach(part => {
    const role = findRoleRow(part.user_id)?.role || 'agent';
    const name = part.user_id === currentUser?.id ? 'You' : getAgentDisplayName(part.user_id);
    const chip = document.createElement('div');
    chip.className = 'messages-member-chip';
    chip.innerHTML = `
      <div class="messages-member-avatar" style="background:${getAvatarBackground(part.user_id)}">${escapeHtml(getInitials(name))}</div>
      <div class="messages-member-name">
        <strong>${escapeHtml(name)}</strong>
        <small>${escapeHtml(role === 'admin' ? 'Admin' : 'Agent')}${conversation.created_by === part.user_id ? ' · Owner' : ''}</small>
      </div>
    `;
    bar.appendChild(chip);
  });
  bar.classList.toggle('hidden', !participants.length);
}

function renderActiveConversation() {
  const titleEl = $('messagesThreadTitle');
  const metaEl = $('messagesThreadMeta');
  const avatarEl = $('messagesThreadAvatar');
  const bodyEl = $('messagesThreadBody');
  const emptyEl = $('messagesEmptyState');
  const composer = $('messagesComposer');
  const pinBtn = $('messagesPinBtn');
  const renameBtn = $('messagesRenameBtn');
  const manageBtn = $('messagesManageBtn');
  const managePanel = $('messagesManagePanel');
  if (!titleEl || !metaEl || !avatarEl || !bodyEl || !composer) return;

  const convo = getActiveConversation();
  if (!convo) {
    titleEl.textContent = 'Select a conversation';
    metaEl.textContent = 'Choose a teammate to start chatting.';
    avatarEl.textContent = 'M';
    avatarEl.style.background = getAvatarBackground('messages');
    composer.classList.add('hidden');
    if (managePanel) managePanel.classList.add('hidden');
    if (pinBtn) pinBtn.disabled = true;
    if (renameBtn) renameBtn.disabled = true;
    if (manageBtn) manageBtn.disabled = true;
    renderMembersBar(null);
    bodyEl.innerHTML = '';
    if (emptyEl) bodyEl.appendChild(emptyEl);
    return;
  }

  titleEl.textContent = getConversationTitle(convo);
  metaEl.textContent = getConversationMeta(convo);
  avatarEl.textContent = getConversationAvatarText(convo);
  avatarEl.style.background = getAvatarBackground(convo.badge_color || convo.title || convo.id);
  composer.classList.remove('hidden');
  if (pinBtn) {
    pinBtn.disabled = false;
    pinBtn.innerHTML = convo.is_pinned ? '<i class="fas fa-thumbtack"></i> Unpin' : '<i class="fas fa-thumbtack"></i> Pin';
  }
  if (renameBtn) renameBtn.disabled = false;
  if (manageBtn) manageBtn.disabled = !canManageConversation(convo);
  if (managePanel) managePanel.classList.toggle('hidden', !canManageConversation(convo) || managePanel.dataset.open !== 'true');

  renderMembersBar(convo);
  populateRemoveMemberSelect();

  bodyEl.innerHTML = '';
  const messages = (messageThreads.get(activeConversationId) || []).filter(msg => !msg.deleted_at && String(msg.body || '').trim());
  if (!messages.length) {
    bodyEl.innerHTML = '<div class="empty-state"><i class="fas fa-paper-plane"></i><p>No messages yet. Send the first update.</p></div>';
    return;
  }

  messages.forEach(msg => {
    const row = document.createElement('div');
    row.className = 'messages-row' + (msg.sender_id === currentUser?.id ? ' mine' : '');
    row.dataset.messageId = msg.id;
    const bubble = document.createElement('div');
    bubble.className = 'messages-bubble';
    bubble.innerHTML = `
      <div class="messages-bubble-head">
        <div class="messages-bubble-author">${escapeHtml(msg.sender_id === currentUser?.id ? 'You' : getAgentDisplayName(msg.sender_id))}</div>
        ${canDeleteMessage(msg) ? '<button class="messages-delete-btn" type="button"><i class="fas fa-trash"></i> Delete</button>' : ''}
      </div>
      <div class="messages-bubble-body">${escapeHtml(msg.body || '')}</div>
      <span class="messages-bubble-time">${escapeHtml(formatDateTime(msg.created_at))}</span>
    `;
    const deleteBtn = bubble.querySelector('.messages-delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteMessage(msg.id, row));
    row.appendChild(bubble);
    bodyEl.appendChild(row);
  });
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

async function markConversationRead(conversationId) {
  if (!conversationId || !currentUser) return;
  const nowIso = new Date().toISOString();

  if (messagesMode !== 'live') {
    const store = readMessagesFallbackStore();
    let changed = false;
    store.participants = (store.participants || []).map(part => {
      if (part.conversation_id === conversationId && part.user_id === currentUser.id) {
        changed = true;
        return { ...part, last_read_at: nowIso };
      }
      return part;
    });
    if (changed) {
      writeMessagesFallbackStore(store);
      applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: true });
    }
    return;
  }

  try {
    await sb
      .from('crm_conversation_participants')
      .update({ last_read_at: nowIso })
      .eq('conversation_id', conversationId)
      .eq('user_id', currentUser.id);
    updateMessagesBadge();
  } catch (error) {
    console.warn('Could not mark conversation read', error);
  }
}

function getSelectedGroupRecipients() {
  return Array.from(document.querySelectorAll('input[name="messagesGroupRecipients"]:checked')).map(input => input.value);
}

async function ensureConversationForParticipants(recipientIds, options = {}) {
  const normalized = [...new Set([currentUser?.id, ...(recipientIds || [])].filter(Boolean))].sort();
  if (normalized.length < 2) throw new Error('Choose at least one teammate first.');
  const title = String(options.title || '').trim();
  const forceNew = !!options.forceNew;

  if (!forceNew && !title) {
    const existing = messageConversations.find(convo => {
      const ids = conversationParticipantsFor(convo.id).map(part => part.user_id).filter(Boolean).sort();
      return ids.length === normalized.length && ids.every((id, index) => id === normalized[index]);
    });
    if (existing) return existing.id;
  }

  const nowIso = new Date().toISOString();

  if (messagesMode !== 'live') {
    const store = readMessagesFallbackStore();
    const conversationId = createMessageUuid('convo');
    const convo = {
      id: conversationId,
      created_at: nowIso,
      updated_at: nowIso,
      created_by: currentUser.id,
      title: title || null,
      is_pinned: false,
      pinned_at: null,
      pinned_by: null,
      badge_color: getConversationAvatarText({ title: title || normalized.join('-') })
    };
    const rows = normalized.map(userId => ({
      conversation_id: conversationId,
      user_id: userId,
      created_at: nowIso,
      last_read_at: userId === currentUser.id ? nowIso : null
    }));
    store.conversations = [convo, ...(store.conversations || [])];
    store.participants = [...(store.participants || []), ...rows];
    writeMessagesFallbackStore(store);
    applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: false });
    return conversationId;
  }

  const { data: convo, error: convoErr } = await sb
    .from('crm_conversations')
    .insert({ created_by: currentUser.id, updated_at: nowIso, title: title || null, is_pinned: false, badge_color: getConversationAvatarText({ title: title || normalized.join('-') }) })
    .select('*')
    .single();
  if (convoErr) throw convoErr;

  const rows = normalized.map(userId => ({
    conversation_id: convo.id,
    user_id: userId,
    ...(userId === currentUser.id ? { last_read_at: nowIso } : {})
  }));

  const { error: participantsErr } = await sb
    .from('crm_conversation_participants')
    .insert(rows);
  if (participantsErr) throw participantsErr;

  await loadMessagesData({ preserveSelection: false });
  return convo.id;
}

async function ensureDirectConversation(recipientId) {
  return ensureConversationForParticipants([recipientId]);
}

async function startConversationFromPicker() {
  const recipientId = $('messagesRecipientSelect')?.value;
  if (!recipientId) {
    setMessagesStatus('Choose a teammate to start a conversation.', 'warning');
    return;
  }
  try {
    setMessagesStatus('Opening direct conversation…');
    activeConversationId = await ensureDirectConversation(recipientId);
    renderMessagesView();
    setMessagesStatus('Conversation ready.', 'success');
  } catch (error) {
    console.error(error);
    setMessagesStatus('Could not open the conversation: ' + error.message, 'error');
  }
}

async function createGroupConversationFromPicker() {
  const recipientIds = getSelectedGroupRecipients();
  const title = $('messagesGroupNameInput')?.value?.trim() || '';
  if (recipientIds.length < 2) {
    setMessagesStatus('Choose at least 2 teammates for a group chat.', 'warning');
    return;
  }
  try {
    setMessagesStatus('Creating group chat…');
    activeConversationId = await ensureConversationForParticipants(recipientIds, { title, forceNew: !!title });
    document.querySelectorAll('input[name="messagesGroupRecipients"]:checked').forEach(input => { input.checked = false; });
    if ($('messagesGroupNameInput')) $('messagesGroupNameInput').value = '';
    renderMessagesView();
    setMessagesStatus('Group chat ready.', 'success');
  } catch (error) {
    console.error(error);
    setMessagesStatus('Could not create the group chat: ' + error.message, 'error');
  }
}

async function renameCurrentConversation() {
  const convo = getActiveConversation();
  if (!convo) return;
  const nextTitle = window.prompt('Enter a new chat name', convo.title || getConversationTitle(convo));
  if (nextTitle === null) return;
  const trimmedTitle = nextTitle.trim() || null;
  try {
    if (messagesMode !== 'live') {
      const store = readMessagesFallbackStore();
      store.conversations = (store.conversations || []).map(row => row.id === convo.id ? { ...row, title: trimmedTitle, updated_at: new Date().toISOString() } : row);
      writeMessagesFallbackStore(store);
      applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: true });
    } else {
      const { error } = await sb
        .from('crm_conversations')
        .update({ title: trimmedTitle, updated_at: new Date().toISOString() })
        .eq('id', convo.id);
      if (error) throw error;
      await loadMessagesData({ preserveSelection: true });
    }
    setMessagesStatus('Chat renamed.', 'success');
  } catch (error) {
    console.error(error);
    setMessagesStatus('Could not rename the chat: ' + error.message, 'error');
  }
}

async function togglePinCurrentConversation() {
  const convo = getActiveConversation();
  if (!convo) return;
  const nowIso = new Date().toISOString();
  try {
    if (messagesMode !== 'live') {
      const store = readMessagesFallbackStore();
      store.conversations = (store.conversations || []).map(row => row.id === convo.id ? {
        ...row,
        is_pinned: !row.is_pinned,
        pinned_at: !row.is_pinned ? nowIso : null,
        pinned_by: !row.is_pinned ? currentUser?.id || null : null,
        updated_at: nowIso
      } : row);
      writeMessagesFallbackStore(store);
      applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: true });
    } else {
      const { error } = await sb
        .from('crm_conversations')
        .update({ is_pinned: !convo.is_pinned, updated_at: nowIso })
        .eq('id', convo.id);
      if (error) throw error;
      await loadMessagesData({ preserveSelection: true });
    }
    setMessagesStatus(convo.is_pinned ? 'Chat unpinned.' : 'Chat pinned.', 'success');
  } catch (error) {
    console.error(error);
    setMessagesStatus('Could not update pin state: ' + error.message, 'error');
  }
}

function toggleManagePanel() {
  const panel = $('messagesManagePanel');
  const convo = getActiveConversation();
  if (!panel || !canManageConversation(convo)) return;
  panel.dataset.open = panel.dataset.open === 'true' ? 'false' : 'true';
  renderActiveConversation();
}

async function addMemberToActiveConversation() {
  const convo = getActiveConversation();
  const userId = $('messagesAddMemberSelect')?.value;
  if (!convo || !userId) {
    setMessagesStatus('Choose a teammate to add.', 'warning');
    return;
  }
  try {
    if (messagesMode !== 'live') {
      const store = readMessagesFallbackStore();
      const exists = (store.participants || []).some(part => part.conversation_id === convo.id && part.user_id === userId);
      if (!exists) {
        store.participants = [...(store.participants || []), { conversation_id: convo.id, user_id: userId, created_at: new Date().toISOString(), last_read_at: null }];
      }
      store.conversations = (store.conversations || []).map(row => row.id === convo.id ? { ...row, updated_at: new Date().toISOString() } : row);
      writeMessagesFallbackStore(store);
      applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: true });
    } else {
      const { error } = await sb
        .from('crm_conversation_participants')
        .insert({ conversation_id: convo.id, user_id: userId });
      if (error) throw error;
      await sb.from('crm_conversations').update({ updated_at: new Date().toISOString() }).eq('id', convo.id);
      await loadMessagesData({ preserveSelection: true });
    }
    setMessagesStatus('Member added.', 'success');
  } catch (error) {
    console.error(error);
    setMessagesStatus('Could not add member: ' + error.message, 'error');
  }
}

async function removeMemberFromActiveConversation() {
  const convo = getActiveConversation();
  const userId = $('messagesRemoveMemberSelect')?.value;
  if (!convo || !userId) {
    setMessagesStatus('Choose a member to remove.', 'warning');
    return;
  }
  if (!window.confirm(`Remove ${getAgentDisplayName(userId)} from this chat?`)) return;
  try {
    if (messagesMode !== 'live') {
      const store = readMessagesFallbackStore();
      store.participants = (store.participants || []).filter(part => !(part.conversation_id === convo.id && part.user_id === userId));
      store.conversations = (store.conversations || []).map(row => row.id === convo.id ? { ...row, updated_at: new Date().toISOString() } : row);
      writeMessagesFallbackStore(store);
      applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: true });
    } else {
      const { error } = await sb
        .from('crm_conversation_participants')
        .delete()
        .eq('conversation_id', convo.id)
        .eq('user_id', userId);
      if (error) throw error;
      await sb.from('crm_conversations').update({ updated_at: new Date().toISOString() }).eq('id', convo.id);
      await loadMessagesData({ preserveSelection: true });
    }
    setMessagesStatus('Member removed.', 'success');
  } catch (error) {
    console.error(error);
    setMessagesStatus('Could not remove member: ' + error.message, 'error');
  }
}

async function deleteMessage(messageId, rowEl = null) {
  if (!messageId) return;
  if (!window.confirm('Delete this message?')) return;
  try {
    const activeBody = $('messagesThreadBody');
    let targetConversationId = activeConversationId || null;

    if (!targetConversationId) {
      for (const [conversationId, list] of messageThreads.entries()) {
        if ((list || []).some(msg => msg.id === messageId)) {
          targetConversationId = conversationId;
          break;
        }
      }
    }

    if (!targetConversationId) throw new Error('Could not find the message in the current thread.');

    const list = messageThreads.get(targetConversationId) || [];
    const nextList = list.filter(msg => msg.id !== messageId);
    messageThreads.set(targetConversationId, nextList);

    if (rowEl) rowEl.remove();
    document.querySelectorAll(`.messages-row[data-message-id="${messageId}"]`).forEach(el => el.remove());

    renderConversationList();
    if (targetConversationId === activeConversationId) {
      const remainingVisible = nextList.filter(msg => !msg.deleted_at && String(msg.body || '').trim());
      if (!remainingVisible.length && activeBody) {
        activeBody.innerHTML = '<div class="empty-state"><i class="fas fa-paper-plane"></i><p>No messages yet. Send the first update.</p></div>';
      }
      renderActiveConversation();
    }
    updateMessagesBadge();

    if (messagesMode !== 'live') {
      const store = readMessagesFallbackStore();
      store.messages = (store.messages || []).filter(msg => msg.id !== messageId);
      store.conversations = (store.conversations || []).map(row => row.id === targetConversationId ? { ...row, updated_at: new Date().toISOString() } : row);
      writeMessagesFallbackStore(store);
      applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: true });
      setMessagesStatus('Message deleted.', 'success');
      return;
    }

    const { data, error } = await sb
      .from('crm_messages')
      .delete()
      .eq('id', messageId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Supabase blocked the delete. Run the crm_messages DELETE policy SQL.');

    setMessagesStatus('Message deleted.', 'success');
    setTimeout(() => loadMessagesData({ preserveSelection: true }), 120);
  } catch (error) {
    console.error(error);
    await loadMessagesData({ preserveSelection: true });
    setMessagesStatus('Could not delete the message: ' + error.message, 'error');
  }
}

async function sendActiveMessage() {
  const input = $('messagesInput');
  const body = input?.value?.trim();
  if (!activeConversationId || !body) return;
  try {
    const nowIso = new Date().toISOString();

    if (messagesMode !== 'live') {
      const store = readMessagesFallbackStore();
      store.messages = [...(store.messages || []), {
        id: createMessageUuid('msg'),
        conversation_id: activeConversationId,
        sender_id: currentUser.id,
        body,
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
        deleted_by: null
      }];
      store.conversations = (store.conversations || []).map(row => row.id === activeConversationId ? { ...row, updated_at: nowIso } : row);
      store.participants = (store.participants || []).map(part => part.conversation_id === activeConversationId && part.user_id === currentUser.id ? { ...part, last_read_at: nowIso } : part);
      writeMessagesFallbackStore(store);
      input.value = '';
      applyMessagesState(store.conversations, store.participants, store.messages, { preserveSelection: true });
      setMessagesStatus('Message sent.', 'success');
      return;
    }

    const { error: msgErr } = await sb
      .from('crm_messages')
      .insert({
        conversation_id: activeConversationId,
        sender_id: currentUser.id,
        body
      });
    if (msgErr) throw msgErr;

    const { error: convoErr } = await sb
      .from('crm_conversations')
      .update({ updated_at: nowIso })
      .eq('id', activeConversationId);
    if (convoErr) throw convoErr;

    await sb
      .from('crm_conversation_participants')
      .update({ last_read_at: nowIso })
      .eq('conversation_id', activeConversationId)
      .eq('user_id', currentUser.id);

    input.value = '';
    setMessagesStatus('Message sent.', 'success');
    await loadMessagesData({ preserveSelection: true });
    await markConversationRead(activeConversationId);
  } catch (error) {
    console.error(error);
    setMessagesStatus('Could not send the message: ' + error.message, 'error');
  }
}

function teardownMessageRealtime() {
  if (messageRealtimeChannel) {
    sb.removeChannel(messageRealtimeChannel);
    messageRealtimeChannel = null;
  }
}

function initMessageRealtime() {
  if (!currentUser || messagesMode !== 'live') return;
  teardownMessageRealtime();
  messageRealtimeChannel = sb.channel('crm-messages-' + currentUser.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_messages' }, () => loadMessagesData({ preserveSelection: true }))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_conversation_participants' }, () => loadMessagesData({ preserveSelection: true }))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_conversations' }, () => loadMessagesData({ preserveSelection: true }))
    .subscribe();
}

$('messagesRefreshBtn')?.addEventListener('click', () => ensureMessagesDataLoaded({ preserveSelection: true }, true));
$('messagesStartBtn')?.addEventListener('click', startConversationFromPicker);
$('messagesGroupStartBtn')?.addEventListener('click', createGroupConversationFromPicker);
$('messagesPinBtn')?.addEventListener('click', togglePinCurrentConversation);
$('messagesRenameBtn')?.addEventListener('click', renameCurrentConversation);
$('messagesManageBtn')?.addEventListener('click', toggleManagePanel);
$('messagesAddMemberBtn')?.addEventListener('click', addMemberToActiveConversation);
$('messagesRemoveMemberBtn')?.addEventListener('click', removeMemberFromActiveConversation);
$('messagesSendBtn')?.addEventListener('click', sendActiveMessage);
$('messagesSearchInput')?.addEventListener('input', renderConversationList);
$('messagesInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendActiveMessage();
  }
});
$('stormRefreshBtn')?.addEventListener('click', () => ensureStormIntelLoaded(true));
function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updatePwaInstallUi() {
  const button = $('pwaInstallBtn');
  const status = $('pwaInstallStatus');
  if (!button || !status) return;

  if (isStandalonePwa()) {
    button.classList.add('hidden');
    status.textContent = 'This app is already installed on this device.';
    return;
  }

  const isiOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
  const installTarget = window.location.pathname.startsWith('/portal/') ? 'portal' : 'dashboard';
  if (deferredInstallPrompt) {
    button.classList.remove('hidden');
    button.disabled = false;
    status.textContent = `Tap install to add the ${installTarget} app to your home screen.`;
  } else if (isiOS) {
    button.classList.add('hidden');
    status.textContent = 'On iPhone or iPad, open this site in Safari and use Share → Add to Home Screen.';
  } else {
    button.classList.add('hidden');
    status.textContent = 'If install is not showing yet, refresh once in Chrome or Edge and open Settings again.';
  }
}

window.isSuperAdmin = isSuperAdmin;
window.isAdmin = isAdmin;
window.isPrivilegedRole = isPrivilegedRole;
window.getRoleLabel = getRoleLabel;
window.getAgentDisplayName = getAgentDisplayName;
window.closeAllModals = closeAllModals;
window.formatMoney = formatMoney;
window.escapeHtml = escapeHtml;
window.getActiveView = getActiveView;
window.isViewActive = isViewActive;
window.showView = showView;
applyDashboardVisualState(getActiveView());
window.getLeadCached = getLeadCached;
window.fetchLeadById = fetchLeadById;
window.openDialerForLead = openDialerForLead;
window.openCallModal = openCallModal;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  
window.addEventListener('crm-call-log-updated', async (event) => {
  try {
    const leadId = event?.detail?.leadId || null;
    await loadCalls();
    rebuildLeadIndexes();
    if (leadId) await ensureLeadCacheForIds([leadId]);
    renderCallsTable(getFilteredCalls());
    renderOverview();
  } catch (error) {
    console.warn('crm-call-log-updated refresh failed:', error?.message || error);
  }
});

updatePwaInstallUi();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updatePwaInstallUi();
});

$('pwaInstallBtn')?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  updatePwaInstallUi();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const workerPath = window.location.pathname.startsWith('/portal/') ? '/portal/service-worker.js' : '/dashboard/service-worker.js';
    navigator.serviceWorker.register(workerPath).catch(error => {
      console.error('Service worker registration failed', error);
    });
  });
}

updatePwaInstallUi();
