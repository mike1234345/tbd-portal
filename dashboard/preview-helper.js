window.addEventListener('load', () => {
  const $ = (id) => document.getElementById(id);
  const login = $('loginScreen');
  const dash = $('dashboardScreen');
  if (login) login.classList.add('hidden');
  if (dash) dash.classList.remove('hidden');

  const view = window.__previewView || 'overview';
  if (typeof window.showView === 'function') window.showView(view);

  const setText = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };

  setText('statCallsToday', '124');
  setText('statAnswered', '46');
  setText('statPresentations', '19');
  setText('statBooked', '8');
  setText('rateAnswer', '37%');
  setText('ratePitch', '41%');
  setText('rateBook', '17%');
  setText('teamSplitSummary', "Mike's Team: 61 calls · Chay Team: 63 calls · 8 booked today.");
  setText('overviewIntro', 'Your mission control for calls, lead movement, storm intel, and booked inspections.');

  const funnelData = [
    ['funnelCalls', '124', '100%'],
    ['funnelAnswered', '46', '37%'],
    ['funnelPres', '19', '15%'],
    ['funnelBooked', '8', '6%']
  ];
  funnelData.forEach(([id, num, w]) => {
    const wrap = $(id);
    if (!wrap) return;
    const n = wrap.querySelector('.funnel-num');
    const bar = wrap.querySelector('.funnel-bar');
    if (n) n.textContent = num;
    if (bar) bar.style.setProperty('--w', w);
  });

  const recent = $('recentCallsList');
  if (recent) {
    recent.innerHTML = `
      <div class="recent-item"><strong>Maria S.</strong><span>Presentation delivered · Tampa, FL</span></div>
      <div class="recent-item"><strong>John D.</strong><span>Inspection booked · Pinellas County</span></div>
      <div class="recent-item"><strong>Angela R.</strong><span>Follow-up needed · Orlando</span></div>
    `;
  }

  const leadTotalChip = $('leadTotalChip');
  if (leadTotalChip) leadTotalChip.textContent = '248 total';
  const leadsBody = $('leadsTableBody');
  if (leadsBody) {
    leadsBody.innerHTML = `
      <tr><td>Maria Santos</td><td>Tampa</td><td>FL</td><td>Water Damage</td><td>New</td><td>Today</td></tr>
      <tr><td>John Davis</td><td>Clearwater</td><td>FL</td><td>Storm Damage</td><td>Contacted</td><td>1h ago</td></tr>
      <tr><td>Angela Rivera</td><td>Orlando</td><td>FL</td><td>Roof Leak</td><td>Qualified</td><td>Today</td></tr>
    `;
  }

  document.body.dataset.activeView = view;
  window.scrollTo(0, 0);
});
