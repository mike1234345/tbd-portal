/* =============================================
   TBD Marketing Solutions — Main JavaScript
   ============================================= */

// ── NAVBAR SCROLL EFFECT ──────────────────────
const navbar = document.getElementById('navbar');

function handleNavbarScroll() {
  if (window.scrollY > 60) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
}
window.addEventListener('scroll', handleNavbarScroll, { passive: true });
handleNavbarScroll();


// ── MOBILE HAMBURGER ──────────────────────────
const hamburger = document.getElementById('hamburger');
const mobileNav = document.getElementById('mobileNav');

hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('open');
  mobileNav.classList.toggle('open');
});

// Close mobile nav when a link is clicked
document.querySelectorAll('.mobile-link').forEach(link => {
  link.addEventListener('click', () => {
    hamburger.classList.remove('open');
    mobileNav.classList.remove('open');
  });
});


// ── HERO PARTICLES ────────────────────────────
function initParticles() {
  const container = document.getElementById('heroParticles');
  if (!container) return;

  const count = window.innerWidth < 768 ? 20 : 50;

  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    const size = Math.random() * 3 + 1;
    const x = Math.random() * 100;
    const y = Math.random() * 100;
    const duration = Math.random() * 15 + 8;
    const delay = Math.random() * 8;
    const opacity = Math.random() * 0.4 + 0.05;

    p.style.cssText = `
      position: absolute;
      width: ${size}px;
      height: ${size}px;
      left: ${x}%;
      top: ${y}%;
      background: rgba(${Math.random() > 0.5 ? '26,110,245' : '249,115,22'},${opacity});
      border-radius: 50%;
      animation: float ${duration}s ${delay}s infinite ease-in-out alternate;
      pointer-events: none;
    `;
    container.appendChild(p);
  }

  // Inject keyframes if not already present
  if (!document.getElementById('particle-keyframes')) {
    const style = document.createElement('style');
    style.id = 'particle-keyframes';
    style.textContent = `
      @keyframes float {
        0%   { transform: translateY(0px) translateX(0px); opacity: 0.3; }
        50%  { opacity: 0.8; }
        100% { transform: translateY(-30px) translateX(15px); opacity: 0.2; }
      }
    `;
    document.head.appendChild(style);
  }
}
initParticles();


// ── INTERSECTION OBSERVER ANIMATIONS ─────────
const observerOptions = {
  threshold: 0.1,
  rootMargin: '0px 0px -40px 0px'
};

// General fade-up elements
const fadeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      fadeObserver.unobserve(entry.target);
    }
  });
}, observerOptions);

document.querySelectorAll('.fade-up').forEach(el => {
  fadeObserver.observe(el);
});

// Step items (staggered)
const stepObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      setTimeout(() => {
        entry.target.classList.add('visible');
      }, i * 150);
      stepObserver.unobserve(entry.target);
    }
  });
}, observerOptions);

document.querySelectorAll('.step-item').forEach(el => {
  stepObserver.observe(el);
});

// Card animations (staggered)
function observeCards(selector) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const cards = entry.target.querySelectorAll(selector);
        cards.forEach((card, i) => {
          card.style.opacity = '0';
          card.style.transform = 'translateY(24px)';
          card.style.transition = `opacity 0.5s ease ${i * 0.1}s, transform 0.5s ease ${i * 0.1}s`;
          setTimeout(() => {
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
          }, 50);
        });
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.05 });

  return observer;
}

const problemObserver = observeCards('.problem-card');
document.querySelector('#problem') && problemObserver.observe(document.querySelector('#problem'));

const servicesObserver = observeCards('.service-card');
document.querySelector('#services') && servicesObserver.observe(document.querySelector('#services'));

const proofObserver = observeCards('.proof-card');
document.querySelector('#social-proof') && proofObserver.observe(document.querySelector('#social-proof'));

const whyObserver = observeCards('.why-card');
document.querySelector('#why-us') && whyObserver.observe(document.querySelector('#why-us'));


// ── COUNTER ANIMATION ─────────────────────────
function animateCounter(el, target, suffix) {
  const duration = 1800;
  const start = performance.now();
  const isDecimal = target.toString().includes('.');

  function update(timestamp) {
    const elapsed = timestamp - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = isDecimal
      ? (eased * target).toFixed(1)
      : Math.floor(eased * target);

    el.textContent = current + suffix;

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      el.textContent = target + suffix;
    }
  }
  requestAnimationFrame(update);
}

const statsObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      // Hero stats
      const statNums = entry.target.querySelectorAll('.stat-number');
      const statData = [
        { value: 3, suffix: '–5x' },
        { value: 100, suffix: '%' },
        { value: 0, suffix: '' },
      ];
      statNums.forEach((el, i) => {
        if (statData[i] && statData[i].value > 0) {
          animateCounter(el, statData[i].value, statData[i].suffix);
        }
      });

      // Results banner big numbers
      const bigNums = entry.target.querySelectorAll('.big-number');
      bigNums.forEach(el => {
        const raw = el.textContent.trim();
        if (raw === '60+') animateCounter(el, 60, '+');
        else if (raw === '4x') animateCounter(el, 4, 'x');
        else if (raw === '60%+') animateCounter(el, 60, '%+');
        else if (raw === '30') animateCounter(el, 30, '');
      });

      statsObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.3 });

document.querySelector('.hero-stats') && statsObserver.observe(document.querySelector('.hero-stats'));
document.querySelector('.results-banner') && statsObserver.observe(document.querySelector('.results-banner'));


// ── AUDIENCE HERO TOGGLE ──────────────────────
const toggleBtns = document.querySelectorAll('.toggle-btn');
const heroRestoration = document.getElementById('heroRestoration');
const heroPA = document.getElementById('heroPA');
const heroRoofing = document.getElementById('heroRoofing');
const statsRestoration = document.getElementById('statsRestoration');
const statsPA = document.getElementById('statsPA');
const statsRoofing = document.getElementById('statsRoofing');
const formAudienceNote = document.getElementById('formAudienceNote');

function setAudienceMode(audience) {
  const t = (window.translations && window.currentLang) ? window.translations[window.currentLang] : null;
  heroRestoration && heroRestoration.classList.toggle('hidden', audience !== 'restoration');
  heroPA && heroPA.classList.toggle('hidden', audience !== 'pa');
  heroRoofing && heroRoofing.classList.toggle('hidden', audience !== 'roofing');
  statsRestoration && statsRestoration.classList.toggle('hidden', audience !== 'restoration');
  statsPA && statsPA.classList.toggle('hidden', audience !== 'pa');
  statsRoofing && statsRoofing.classList.toggle('hidden', audience !== 'roofing');

  if (formAudienceNote) {
    const fallback = audience === 'pa'
      ? 'For public adjusters — you pay only when the homeowner signs a contract of representation.'
      : audience === 'roofing'
        ? 'For roofing contractors — we build retail, insurance, and financing-aware roofing opportunities tailored to your market.'
        : 'For restoration companies — you pay only when a homeowner signs.';
    const key = audience === 'pa' ? 'audience_note_pa' : audience === 'roofing' ? 'audience_note_roof' : 'audience_note_rest';
    const msg = t ? t[key] : fallback;
    formAudienceNote.innerHTML = `<i class="fas fa-shield-alt"></i> ${msg}`;
  }
}

toggleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    toggleBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setAudienceMode(btn.dataset.audience);
  });
});

const activeAudienceBtn = document.querySelector('.toggle-btn.active');
if (activeAudienceBtn) setAudienceMode(activeAudienceBtn.dataset.audience);


// ── SERVICES TAB TOGGLE ───────────────────────
const tabBtns = document.querySelectorAll('.tab-btn');
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('tab-active'));
    btn.classList.add('tab-active');
    const tabId = btn.dataset.tab;

    document.getElementById('restoration-services').classList.add('hidden');
    document.getElementById('pa-services').classList.add('hidden');
    document.getElementById('roofing-services').classList.add('hidden');
    document.getElementById(tabId).classList.remove('hidden');
  });
});


// ── CONTACT FORM CLIENT TYPE TOGGLE ───────────
const typeRadios = document.querySelectorAll('input[name="client_type"]');
const restorationFields = document.getElementById('restorationFields');
const paFields = document.getElementById('paFields');
const roofingFields = document.getElementById('roofingFields');

function setClientTypeMode(value) {
  const t = (window.translations && window.currentLang) ? window.translations[window.currentLang] : null;
  const isPA = value === 'Public Adjuster';
  const isRoofing = value === 'Roofing Contractor';
  restorationFields && restorationFields.classList.toggle('hidden', isPA || isRoofing);
  paFields && paFields.classList.toggle('hidden', !isPA);
  roofingFields && roofingFields.classList.toggle('hidden', !isRoofing);

  if (formAudienceNote) {
    const fallback = isPA
      ? 'For public adjusters — you pay only when the homeowner signs a contract of representation.'
      : isRoofing
        ? 'For roofing contractors — we build retail, insurance, and financing-aware roofing opportunities tailored to your market.'
        : 'For restoration companies — you pay only when a homeowner signs.';
    const key = isPA ? 'audience_note_pa' : isRoofing ? 'audience_note_roof' : 'audience_note_rest';
    const msg = t ? t[key] : fallback;
    formAudienceNote.innerHTML = `<i class="fas fa-shield-alt"></i> ${msg}`;
  }
}

typeRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    if (radio.checked) setClientTypeMode(radio.value);
  });
});

const checkedType = document.querySelector('input[name="client_type"]:checked');
if (checkedType) setClientTypeMode(checkedType.value);


// ── FAQ ACCORDION ─────────────────────────────
document.querySelectorAll('.faq-item').forEach(item => {
  const btn = item.querySelector('.faq-question');
  const answer = item.querySelector('.faq-answer');

  btn.addEventListener('click', () => {
    const isOpen = item.classList.contains('open');

    // Close all others
    document.querySelectorAll('.faq-item.open').forEach(openItem => {
      if (openItem !== item) {
        openItem.classList.remove('open');
        openItem.querySelector('.faq-answer').classList.remove('open');
      }
    });

    // Toggle this one
    item.classList.toggle('open', !isOpen);
    answer.classList.toggle('open', !isOpen);
  });
});


// ── SMOOTH SCROLL FOR ANCHOR LINKS ───────────
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      e.preventDefault();
      const navHeight = navbar.offsetHeight;
      const targetPos = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
      window.scrollTo({ top: targetPos, behavior: 'smooth' });
    }
  });
});


// ── ACTIVE NAV LINK HIGHLIGHT ─────────────────
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.desktop-nav a[href^="#"]');

function updateActiveNav() {
  const scrollY = window.scrollY;
  let current = '';

  sections.forEach(section => {
    const sectionTop = section.offsetTop - 100;
    if (scrollY >= sectionTop) {
      current = section.getAttribute('id');
    }
  });

  navLinks.forEach(link => {
    link.style.color = '';
    if (link.getAttribute('href') === `#${current}`) {
      link.style.color = '#ffffff';
      link.style.fontWeight = '600';
    } else {
      link.style.color = 'rgba(255,255,255,0.7)';
      link.style.fontWeight = '500';
    }
  });
}
window.addEventListener('scroll', updateActiveNav, { passive: true });


// ── CONTACT FORM SUBMISSION ───────────────────
const leadForm = document.getElementById('leadForm');
const formSuccess = document.getElementById('formSuccess');
const submitBtn = document.getElementById('submitBtn');

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^[\d\s\-\(\)\+]{7,}$/.test(phone);
}

function setFieldError(id, hasError) {
  const el = document.getElementById(id);
  if (!el) return;
  if (hasError) {
    el.classList.add('error');
  } else {
    el.classList.remove('error');
  }
}

function clearErrors() {
  document.querySelectorAll('.form-group input, .form-group select').forEach(el => {
    el.classList.remove('error');
  });
}

if (leadForm) {
  leadForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearErrors();

    const contactName = document.getElementById('contact_name').value.trim();
    const companyName = document.getElementById('company_name').value.trim();
    const email = document.getElementById('email').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const serviceArea = document.getElementById('service_area').value.trim();
    const message = document.getElementById('message').value.trim();

    // Detect client type
    const selectedType = document.querySelector('input[name="client_type"]:checked');
    const clientType = selectedType ? selectedType.value : 'Restoration Company';
    const isPA = clientType === 'Public Adjuster';
    const isRoofing = clientType === 'Roofing Contractor';

    // Restoration-specific fields
    const companyType = document.getElementById('company_type').value;
    const monthlyRevenue = document.getElementById('monthly_revenue').value;

    // PA-specific fields
    const claimTypes = document.getElementById('claim_types') ? document.getElementById('claim_types').value : '';
    const licensedStates = document.getElementById('licensed_states') ? document.getElementById('licensed_states').value.trim() : '';

    // Roofing-specific fields
    const roofingSpecialty = document.getElementById('roofing_specialty') ? document.getElementById('roofing_specialty').value : '';
    const roofingVolume = document.getElementById('roofing_volume') ? document.getElementById('roofing_volume').value : '';

    let hasErrors = false;

    if (!contactName) { setFieldError('contact_name', true); hasErrors = true; }
    if (!companyName) { setFieldError('company_name', true); hasErrors = true; }
    if (!email || !validateEmail(email)) { setFieldError('email', true); hasErrors = true; }
    if (!phone || !validatePhone(phone)) { setFieldError('phone', true); hasErrors = true; }
    if (!serviceArea) { setFieldError('service_area', true); hasErrors = true; }

    if (hasErrors) {
      // Shake the button
      submitBtn.style.animation = 'shake 0.4s ease';
      setTimeout(() => { submitBtn.style.animation = ''; }, 400);
      return;
    }

    // Loading state
    const originalContent = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    submitBtn.disabled = true;

    // Build a clean label for conditional fields
    const specialtyLabel  = isPA ? 'N/A (Public Adjuster)' : isRoofing ? (roofingSpecialty || 'Not specified') : (companyType || 'Not specified');
    const revenueLabel    = isPA ? 'N/A (Public Adjuster)' : isRoofing ? (roofingVolume || 'Not specified') : (monthlyRevenue || 'Not specified');
    const claimsLabel     = isPA ? (claimTypes || 'Not specified') : isRoofing ? 'N/A (Roofing)' : 'N/A (Restoration)';
    const statesLabel     = isPA ? (licensedStates || 'Not specified') : isRoofing ? 'N/A (Roofing)' : 'N/A (Restoration)';

    // Payload shared by both the database save and the email
    const leadPayload = {
      contact_name:    contactName,
      company_name:    companyName,
      email:           email,
      phone:           phone,
      client_type:     clientType,
      company_type:    isPA ? 'Public Adjuster' : isRoofing ? roofingSpecialty : companyType,
      monthly_revenue: isPA ? '' : isRoofing ? roofingVolume : monthlyRevenue,
      claim_types:     isPA ? claimTypes : '',
      licensed_states: isPA ? licensedStates : '',
      service_area:    serviceArea,
      message:         message,
      status:          'New'
    };

    try {
      // ── 1. Save to database ──────────────────────
      const response = await fetch('tables/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leadPayload)
      });
      if (!response.ok) throw new Error('Database save failed');

      // ── 2. Send email via EmailJS ────────────────
      const ejsKey        = window.EMAILJS_PUBLIC_KEY;
      const ejsService    = window.EMAILJS_SERVICE_ID;
      const ejsTemplate   = window.EMAILJS_TEMPLATE_ID;

      if (ejsKey && ejsKey !== 'YOUR_PUBLIC_KEY' && typeof emailjs !== 'undefined') {
        const now = new Date();
        const submittedAt = now.toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
        });

        await emailjs.send(ejsService, ejsTemplate, {
          // ── Contact Info ──
          contact_name:    contactName,
          company_name:    companyName,
          email:           email,
          phone:           phone,
          // ── Business Type ──
          client_type:     clientType,
          // ── Restoration fields ──
          company_type:    specialtyLabel,
          monthly_revenue: revenueLabel,
          // ── PA fields ──
          claim_types:     claimsLabel,
          licensed_states: statesLabel,
          // ── Shared ──
          service_area:    serviceArea,
          message:         message || '(none)',
          submitted_at:    submittedAt,
          // ── Where to send the notification ──
          to_email:        'marketing.rapidresto@gmail.com',
          reply_to:        email,
        });
      }

      // ── 3. Show success UI ───────────────────────
      leadForm.style.display = 'none';
      formSuccess.classList.remove('hidden');
      formSuccess.scrollIntoView({ behavior: 'smooth', block: 'center' });

    } catch (err) {
      console.error('Form error:', err);
      submitBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Something went wrong. Try again.';
      submitBtn.disabled = false;
      setTimeout(() => {
        submitBtn.innerHTML = originalContent;
        submitBtn.disabled = false;
      }, 3000);
    }
  });

  // Real-time validation clearing
  document.querySelectorAll('#leadForm input, #leadForm select').forEach(el => {
    el.addEventListener('input', () => el.classList.remove('error'));
    el.addEventListener('change', () => el.classList.remove('error'));
  });
}


// ── SHAKE ANIMATION ───────────────────────────
(function injectShake() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-8px); }
      40% { transform: translateX(8px); }
      60% { transform: translateX(-5px); }
      80% { transform: translateX(5px); }
    }
  `;
  document.head.appendChild(style);
})();


// ── PHONE INPUT FORMATTING ────────────────────
const phoneInput = document.getElementById('phone');
if (phoneInput) {
  phoneInput.addEventListener('input', function () {
    let val = this.value.replace(/\D/g, '').substring(0, 10);
    if (val.length >= 6) {
      val = `(${val.substring(0,3)}) ${val.substring(3,6)}-${val.substring(6)}`;
    } else if (val.length >= 3) {
      val = `(${val.substring(0,3)}) ${val.substring(3)}`;
    }
    this.value = val;
  });
}


// ── SCROLL PROGRESS INDICATOR ─────────────────
function createScrollProgress() {
  const bar = document.createElement('div');
  bar.id = 'scrollProgress';
  bar.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    height: 3px;
    background: linear-gradient(90deg, #1a6ef5, #f97316);
    z-index: 9999;
    transition: width 0.1s;
    width: 0%;
  `;
  document.body.prepend(bar);

  window.addEventListener('scroll', () => {
    const scrollTop = window.scrollY;
    const docHeight = document.body.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    bar.style.width = `${pct}%`;
  }, { passive: true });
}
createScrollProgress();


// ── TRUST TAG ANIMATION ───────────────────────
const trustBar = document.querySelector('#trust-bar');
if (trustBar) {
  const trustObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const tags = entry.target.querySelectorAll('.trust-tag');
        tags.forEach((tag, i) => {
          tag.style.opacity = '0';
          tag.style.transform = 'translateY(12px)';
          tag.style.transition = `opacity 0.4s ease ${i * 0.08}s, transform 0.4s ease ${i * 0.08}s`;
          setTimeout(() => {
            tag.style.opacity = '1';
            tag.style.transform = 'translateY(0)';
          }, 50);
        });
        trustObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  trustObserver.observe(trustBar);
}

console.log('%c TBD Marketing Solutions ', 'background:#1a6ef5;color:white;font-weight:bold;padding:4px 12px;border-radius:4px;', '— Growth Partner for Restoration Companies & Public Adjusters');
