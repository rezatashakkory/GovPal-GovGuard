/* ═══════════════════════════════════════════════════════════════
   app.js – GovPal-GovGuard frontend logic
   Pure vanilla JS, zero external libraries, runs in any browser.
═══════════════════════════════════════════════════════════════ */

'use strict';

// ── JWT Auth ─────────────────────────────────────────────────────────────────
let _jwtToken = sessionStorage.getItem('gg_token') || null;
let _jwtRole  = sessionStorage.getItem('gg_role')  || 'Analyst';
let _jwtName  = sessionStorage.getItem('gg_name')  || '';

function _authHeaders() {
  return _jwtToken
    ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _jwtToken }
    : { 'Content-Type': 'application/json' };
}

function _saveAuth(token, role, name) {
  _jwtToken = token; _jwtRole = role; _jwtName = name;
  sessionStorage.setItem('gg_token', token);
  sessionStorage.setItem('gg_role',  role);
  sessionStorage.setItem('gg_name',  name);
}

function _clearAuth() {
  _jwtToken = null; _jwtRole = 'Analyst'; _jwtName = '';
  sessionStorage.removeItem('gg_token');
  sessionStorage.removeItem('gg_role');
  sessionStorage.removeItem('gg_name');
}

// ── Login Modal ───────────────────────────────────────────────────────────────
const loginOverlay  = document.getElementById('loginOverlay');
const loginForm     = document.getElementById('loginForm');
const loginEmail    = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginError    = document.getElementById('loginError');
const loginSubmit   = document.getElementById('loginSubmit');

function _showLogin() {
  if (loginOverlay) loginOverlay.classList.remove('hidden');
}
function _hideLogin() {
  if (loginOverlay) loginOverlay.classList.add('hidden');
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn   = document.getElementById('loginSubmit');
    const errEl = document.getElementById('loginError');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.style.display = 'none';
    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.value.trim(), password: loginPassword.value }),
      });
      if (!resp.ok) {
        let msg = 'Invalid credentials.';
        try { const j = await resp.json(); msg = j.detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await resp.json();
      _saveAuth(data.access_token, data.role, data.name);
      _applyJwtToUI();
      _hideLogin();
      _preFetchGraph(); // start background pre-fetch so graph is ready instantly
      _preFetchDocs();  // pre-fetch docs so Document Library is instant
    } catch (err) {
      const isNet = !err.message || err.message.includes('fetch');
      errEl.textContent = isNet ? 'Connection error — please try again.' : err.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;       // ← always resets, even if an exception occurs mid-flow
      btn.textContent = 'Sign In';
    }
  });
}

// ── State ────────────────────────────────────────────────────────────────────
let currentLang       = 'EN';
let currentRole       = _jwtRole;
let msgCounter        = 0;
let selectedDocId     = null;
let _currentView      = 'home';   // tracks which view is active for badge notification
let _chatSessionActive = false;   // true once first message is sent
let _graphCache       = null;     // pre-fetched graph data (avoids blocking during chat)
let _chatAbortCtrl    = null;     // AbortController for the active chat fetch
let _chatGeneration   = 0;        // incremented on every cancel — stale callbacks bail out
const feedback     = {};
const auditQueries = [];

// Pre-fetch graph + docs in background so views are instant (avoids blocking during long chat)
function _preFetchGraph() {
  fetch('/api/graph', { headers: _authHeaders() })
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data) _graphCache = data; })
    .catch(() => {});
}

let _docsCache = null;
function _preFetchDocs() {
  fetch('/api/docs', { headers: _authHeaders() })
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data) _docsCache = data; })
    .catch(() => {});
}
let graphInstance = null;
let graphFilter   = 'all';
const queryStats  = { total: 0, policy: 0, glossary: 0, contract: 0, restricted: 0, noAnswer: 0, totalConf: 0 };

function _applyJwtToUI() {
  // Drive role display from JWT (read-only, no free switching)
  currentRole = _jwtRole;
  const roleLbl = document.getElementById('roleBtnLabel');
  if (roleLbl) roleLbl.textContent = _jwtName ? `${_jwtName} (${_jwtRole})` : _jwtRole;
  // Update the read-only role display in settings
  const settingsRoleEl = document.getElementById('settingsRoleDisplay');
  if (settingsRoleEl) settingsRoleEl.textContent = _jwtRole || 'Analyst';
  // Show user name and sign-out in topbar
  const nameEl = document.getElementById('topbarUserName');
  if (nameEl && _jwtName) nameEl.textContent = _jwtName;
  const userInfo = document.getElementById('userInfo');
  if (userInfo) userInfo.style.display = 'flex';
  // Audit Dashboard is only meaningful for roles that can call GET /api/audit-log
  const auditNavBtn = document.getElementById('auditNavBtn');
  if (auditNavBtn) auditNavBtn.hidden = !(_jwtRole === 'Manager' || _jwtRole === 'Partner');
}

// On page load — check for existing token
if (_jwtToken) {
  _applyJwtToUI();
  _hideLogin();
  _preFetchGraph();
  _preFetchDocs();
} else {
  _showLogin();
}

// Translations injected by Jinja2 into window.__TRANSLATIONS__
const T = window.__TRANSLATIONS__ || {};

function t(key) {
  return (T[currentLang] && T[currentLang][key]) || (T['EN'] && T['EN'][key]) || key;
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const messagesEl   = document.getElementById('messages');
const welcomeEl    = document.getElementById('welcome');
const chatInput    = document.getElementById('chatInput');
const sendBtn      = document.getElementById('sendBtn');
const clearBtn     = document.getElementById('clearBtn');
const inputMeta    = document.getElementById('inputMeta');
const roleBtn      = null; // removed — role is read-only from JWT
const roleBtnLabel = document.getElementById('roleBtnLabel');
const roleDropdown = null; // removed
const auditList    = document.getElementById('auditList');
const docPreview   = document.getElementById('docPreview');
const rpEmpty      = document.getElementById('rpEmpty');
const analyticsPanel = null; // moved to maturity dashboard
const auditBlock   = document.getElementById('auditBlock');
const rpHeaderTitle = document.querySelector('.rp-header-title');
const rpHeaderIcon  = document.querySelector('.rp-header-icon');

// ── Helpers ──────────────────────────────────────────────────────────────────
function genId() { return `msg-${++msgCounter}-${Date.now()}`; }

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Strips stray "===" / "---" separator lines (and anything after them) that the
// LLM occasionally emits — e.g. when it appends a duplicate English fallback
// sentence after an already-complete FR/DE answer.
function _cleanLlmAnswer(text) {
  if (!text) return text;
  const parts = text.split(/\n\s*(?:={3,}|-{3,})\s*\n/);
  return parts[0].trim();
}

function highlightKeywords(text, keywords) {
  if (!keywords || !keywords.length) return escHtml(text);
  let result = escHtml(text);
  keywords.forEach(kw => {
    const re = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(re, '<mark>$1</mark>');
  });
  return result;
}

function confClass(score) {
  if (score >= 80) return 'green';
  if (score >= 50) return 'yellow';
  return 'red';
}

function scrollToBottom() {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
}

// ── Language ─────────────────────────────────────────────────────────────────
function applyLanguage(lang) {
  currentLang = lang;
  document.documentElement.setAttribute('data-lang', lang);

  // Update all [data-t] elements
  document.querySelectorAll('[data-t]').forEach(el => {
    const key = el.getAttribute('data-t');
    el.textContent = t(key);
  });

  // Update placeholders
  document.querySelectorAll('[data-t-placeholder]').forEach(el => {
    const key = el.getAttribute('data-t-placeholder');
    el.placeholder = t(key);
  });

  // Update static tooltips (title attribute)
  document.querySelectorAll('[data-t-title]').forEach(el => {
    const key = el.getAttribute('data-t-title');
    el.title = t(key);
  });

  // Update role option labels
  document.querySelectorAll('.role-option').forEach(btn => {
    const role = btn.getAttribute('data-role');
    const labelKey = `role${role}`;
    btn.textContent = t(labelKey);
  });

  // Update role button label — preserve JWT name on language switch
  if (roleBtnLabel) {
    if (_jwtName) {
      roleBtnLabel.textContent = `${_jwtName} (${t(`role${currentRole}`)})` ;
    } else {
      roleBtnLabel.textContent = t(`role${currentRole}`);
    }
  }

  // Update sample chips (they hold a data-t attribute)
  document.querySelectorAll('.sample-chip[data-t]').forEach(btn => {
    const key = btn.getAttribute('data-t');
    btn.textContent = t(key);
  });

  // Language buttons active state
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });
}

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => applyLanguage(btn.getAttribute('data-lang')));
});

// Role is read-only from JWT — no dropdown interaction needed.

// ── Sign-out ──────────────────────────────────────────────────────────────────
const signoutBtn = document.getElementById('signoutBtn');
if (signoutBtn) {
  signoutBtn.addEventListener('click', () => {
    // Abort any in-flight chat request before leaving
    if (_chatAbortCtrl) { _chatAbortCtrl.abort(); _chatAbortCtrl = null; }
    _chatGeneration++;
    _clearAuth();
    window.location.replace(window.location.origin + '/');
  });
}

// ── Sidebar navigation ────────────────────────────────────────────────────────
function rpShowOnly(section) {
  if (analyticsPanel) analyticsPanel.hidden               = section !== 'analytics';
  document.getElementById('settingsPanel').hidden         = section !== 'settings';
  document.getElementById('graphNodeInfo').hidden         = section !== 'graphNode';
  document.getElementById('graphEmptyState').hidden       = section !== 'graphEmpty';
  const dlp = document.getElementById('docListPanel');
  if (dlp) dlp.hidden                                     = section !== 'docList';
  auditBlock.hidden                                       = section === 'settings' || section === 'gap';
  docPreview.hidden = section !== 'doc';
  rpEmpty.hidden    = section !== 'empty';
}

function _hideAllViews() {
  document.querySelector('.chat-area').style.display   = 'none';
  document.getElementById('graphView').style.display   = 'none';
  document.getElementById('gapView').style.display     = 'none';
  document.getElementById('maturityView').style.display = 'none';
  const sv = document.getElementById('settingsView');
  if (sv) sv.style.display = 'none';
  const dv = document.getElementById('docsFullView');
  if (dv) dv.style.display = 'none';
  const av = document.getElementById('auditView');
  if (av) av.style.display = 'none';
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const nav = btn.getAttribute('data-nav');

    if (nav === 'chat') {
      _currentView = 'chat';
      _hideAllViews();
      document.querySelector('.chat-area').style.display = '';
      if (graphInstance) { graphInstance.stop(); graphInstance = null; }
      rpHeaderTitle.textContent = t('rightPanelTitle');
      rpHeaderIcon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
      rpShowOnly(selectedDocId ? 'doc' : 'empty');
      return;
    }

    if (nav === 'maturity') {
      _currentView = 'maturity';
      _hideAllViews();
      document.getElementById('maturityView').style.display = 'flex';
      if (graphInstance) { graphInstance.stop(); graphInstance = null; }
      rpHeaderTitle.textContent = 'Governance Maturity';
      rpHeaderIcon.innerHTML = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
      rpShowOnly('empty');
      loadMaturityView();
      return;
    }

    if (nav === 'graph') {
      _currentView = 'graph';
      _hideAllViews();
      document.getElementById('graphView').style.display = 'flex';
      if (graphInstance) { graphInstance.stop(); graphInstance = null; }
      rpHeaderTitle.textContent = 'Knowledge Graph';
      rpHeaderIcon.innerHTML = '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><line x1="7" y1="11" x2="17" y2="6"/><line x1="7" y1="13" x2="17" y2="18"/>';
      rpShowOnly('graphEmpty');
      loadGraph();
      return;
    }

    if (nav === 'gap') {
      _currentView = 'gap';
      _hideAllViews();
      document.getElementById('gapView').style.display = 'flex';
      if (graphInstance) { graphInstance.stop(); graphInstance = null; }
      rpHeaderTitle.textContent = 'Gap Analysis';
      rpHeaderIcon.innerHTML = '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>';
      rpShowOnly('empty');
      return;
    }

    if (nav === 'audit') {
      _currentView = 'audit';
      _hideAllViews();
      const av = document.getElementById('auditView');
      if (av) av.style.display = 'flex';
      if (graphInstance) { graphInstance.stop(); graphInstance = null; }
      rpHeaderTitle.textContent = 'Audit Dashboard';
      rpHeaderIcon.innerHTML = '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>';
      rpShowOnly('empty');
      loadAuditDashboard();
      return;
    }

    if (nav === 'settings') {
      _currentView = 'settings';
      _hideAllViews();
      const sv = document.getElementById('settingsView');
      if (sv) sv.style.display = 'flex';
      if (graphInstance) { graphInstance.stop(); graphInstance = null; }
      rpHeaderTitle.textContent = 'Settings';
      rpHeaderIcon.innerHTML = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
      document.querySelectorAll('#settingsLangBtns .settings-lang-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-lang') === currentLang);
      });
      rpShowOnly('settings');
      return;
    }

    if (nav === 'docs') {
      _currentView = 'docs';
      _hideAllViews();
      const dv = document.getElementById('docsFullView');
      if (dv) dv.style.display = 'flex';
      if (graphInstance) { graphInstance.stop(); graphInstance = null; }
      rpHeaderTitle.textContent = 'Document Preview';
      rpHeaderIcon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
      rpShowOnly(selectedDocId ? 'doc' : 'empty');
      loadDocsFullView();
      return;
    }

    // Fallback
    _currentView = 'home';
    _hideAllViews();
    document.querySelector('.chat-area').style.display = '';
    rpHeaderTitle.textContent = t('rightPanelTitle');
    rpHeaderIcon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
    rpShowOnly(selectedDocId ? 'doc' : 'empty');
  });
});

// ── Document library view ─────────────────────────────────────────────────────
async function loadDocsView() {
  // Legacy right-panel docs (kept for any backward-compat callers)
  const items = document.getElementById('docListItems');
  const count = document.getElementById('docListCount');
  if (!items) return;
  items.innerHTML = '<p style="padding:12px 0;color:var(--text-muted);font-size:12px;">Loading…</p>';
  try {
    const resp = await fetch('/api/docs', { headers: _authHeaders() });
    if (!resp.ok) throw new Error();
    const data = await resp.json();
    if (count) count.textContent = `${data.total} document${data.total !== 1 ? 's' : ''} visible to ${data.role}`;
    items.innerHTML = '';
    if (!data.docs.length) {
      items.innerHTML = '<p style="padding:12px 0;color:var(--text-muted);font-size:12px;">No documents available for your role.</p>';
      return;
    }
    data.docs.forEach(doc => {
      const el = document.createElement('div');
      el.className = 'doc-list-item';
      const clsCls = `cls-${doc.classification}`;
      el.innerHTML = `<div class="dli-top"><span class="dli-title">${escHtml(doc.title)}</span><span class="cls-badge ${clsCls}">${escHtml(doc.classification)}</span></div><div class="dli-meta"><span>${escHtml(doc.id)}</span>${doc.category ? `<span>${escHtml(doc.category)}</span>` : ''}${doc.owner ? `<span>${escHtml(doc.owner)}</span>` : ''}</div>`;
      el.addEventListener('click', () => populateRightPanel({ ...doc, content: '' }));
      items.appendChild(el);
    });
  } catch {
    items.innerHTML = '<p style="padding:12px 0;color:var(--red);font-size:12px;">Error loading documents.</p>';
  }
}

// ── Full-page document library ────────────────────────────────────────────────
let _allDocs = [];
let _docsFilterCls = 'ALL';

const CLS_COLORS = {
  PUBLIC:       '#22c55e',
  INTERNAL:     '#3b82f6',
  CONFIDENTIAL: '#f59e0b',
  RESTRICTED:   '#ef4444',
};

async function loadDocsFullView() {
  const grid = document.getElementById('docsGrid');
  const loading = document.getElementById('docsLoading');
  const countBadge = document.getElementById('docsCountBadge');
  if (!grid) return;

  // Use pre-fetched cache if available — instant, no network needed
  if (_docsCache) {
    if (loading) loading.hidden = true;
    _allDocs = _docsCache.docs || [];
    if (countBadge) countBadge.textContent = `${_allDocs.length} document${_allDocs.length !== 1 ? 's' : ''}`;
    document.querySelectorAll('.docs-filter-chip').forEach(chip => {
      const cls = chip.getAttribute('data-cls');
      if (cls === 'ALL') { chip.innerHTML = `All <span class="chip-count">${_allDocs.length}</span>`; return; }
      const n = _allDocs.filter(d => d.classification === cls).length;
      chip.innerHTML = `${cls} <span class="chip-count">${n}</span>`;
    });
    _renderDocsGrid();
    return;
  }

  if (loading) loading.hidden = false;
  try {
    const resp = await fetch('/api/docs', { headers: _authHeaders() });
    if (!resp.ok) throw new Error();
    const data = await resp.json();
    _docsCache = data;
    _allDocs = data.docs || [];
    if (countBadge) countBadge.textContent = `${_allDocs.length} document${_allDocs.length !== 1 ? 's' : ''}`;
    // Update filter chip counts
    document.querySelectorAll('.docs-filter-chip').forEach(chip => {
      const cls = chip.getAttribute('data-cls');
      if (cls === 'ALL') { chip.innerHTML = `All <span class="chip-count">${_allDocs.length}</span>`; return; }
      const n = _allDocs.filter(d => d.classification === cls).length;
      chip.innerHTML = `${cls} <span class="chip-count">${n}</span>`;
    });
    _renderDocsGrid();
  } catch {
    if (grid) grid.innerHTML = '<p style="padding:40px;color:var(--red);text-align:center;">Error loading documents.</p>';
  } finally {
    if (loading) loading.hidden = true;
  }
}

function _renderDocsGrid() {
  const grid = document.getElementById('docsGrid');
  const searchVal = (document.getElementById('docsSearchInput')?.value || '').toLowerCase();
  if (!grid) return;
  const filtered = _allDocs.filter(doc => {
    const matchesCls = _docsFilterCls === 'ALL' || doc.classification === _docsFilterCls;
    const matchesSearch = !searchVal ||
      doc.title.toLowerCase().includes(searchVal) ||
      (doc.category || '').toLowerCase().includes(searchVal) ||
      (doc.owner || '').toLowerCase().includes(searchVal) ||
      (doc.tags || []).some(t => t.toLowerCase().includes(searchVal));
    return matchesCls && matchesSearch;
  });

  if (!filtered.length) {
    grid.innerHTML = `<div class="docs-empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:40px;height:40px;color:var(--text-400)"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>No documents match your filters.</p></div>`;
    return;
  }

  grid.innerHTML = '';
  filtered.forEach(doc => {
    const col = CLS_COLORS[doc.classification] || '#6b7280';
    const conf = doc.confidence_score || 80;
    const tags = (doc.tags || []).slice(0, 3).map(tg => `<span class="doc-card-tag">${escHtml(tg)}</span>`).join('');
    const card = document.createElement('div');
    card.className = 'doc-full-card';
    card.style.setProperty('--card-accent', col);
    card.innerHTML = `
      <div class="doc-full-card-header">
        <div class="doc-full-card-meta">
          <span class="doc-full-card-category">${escHtml(doc.category || 'Governance')}</span>
          <span class="cls-badge cls-${escHtml(doc.classification)}" style="font-size:9px;">${escHtml(doc.classification)}</span>
        </div>
        <h3 class="doc-full-card-title">${escHtml(doc.title)}</h3>
      </div>
      <div class="doc-full-card-body">
        ${doc.owner ? `<div class="doc-full-card-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;flex-shrink:0"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>${escHtml(doc.owner)}</span></div>` : ''}
        ${doc.date ? `<div class="doc-full-card-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;flex-shrink:0"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><span>${escHtml(doc.date)}</span></div>` : ''}
        ${tags ? `<div class="doc-full-card-tags">${tags}</div>` : ''}
      </div>
      <div class="doc-full-card-footer">
        <div class="doc-full-conf-label" title="${escHtml(t('confidenceTooltip'))}">
          <span>${t('confidenceLabel')}</span><span style="color:${col};font-weight:600;">${conf}%</span>
        </div>
        <div class="doc-full-conf-track"><div class="doc-full-conf-bar" style="width:${conf}%;background:${col};"></div></div>
      </div>`;
    card.addEventListener('click', () => {
      populateRightPanel({ ...doc, content: '' });
      // Highlight selected card
      document.querySelectorAll('.doc-full-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    grid.appendChild(card);
  });
}

// Wire up search + filter chips for docs full view
document.addEventListener('input', e => {
  if (e.target.id === 'docsSearchInput') _renderDocsGrid();
});
document.addEventListener('click', e => {
  const chip = e.target.closest('.docs-filter-chip');
  if (!chip) return;
  document.querySelectorAll('.docs-filter-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  _docsFilterCls = chip.getAttribute('data-cls');
  _renderDocsGrid();
});

// ── Input auto-resize ─────────────────────────────────────────────────────────
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 128) + 'px';
  sendBtn.disabled = !chatInput.value.trim();
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

// ── Go home (clears session, shows welcome screen) ────────────────────────────
function goHome() {
  // Abort any in-flight chat request immediately
  if (_chatAbortCtrl) {
    _chatAbortCtrl.abort();
    _chatAbortCtrl = null;
  }
  _chatGeneration++; // invalidate any queued .then()/.catch()/.finally() callbacks
  // Always restore input (in case we aborted mid-request)
  _awaitingResponse = false;
  chatInput.disabled = false;
  sendBtn.disabled = true;
  // Remove any lingering typing indicators
  document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
  // Clear all chat messages — keep only the welcome element
  Array.from(messagesEl.children).forEach(c => { if (c !== welcomeEl) c.remove(); });
  welcomeEl.style.display = 'flex';
  inputMeta.style.display = 'none';
  selectedDocId = null;
  docPreview.hidden = true;
  rpEmpty.hidden = false;
  auditQueries.length = 0;
  renderAudit();
  // Clear chat session state
  _chatSessionActive = false;
  _currentView = 'home';
  // Hide all non-chat views
  document.querySelector('.chat-area').style.display = '';
  document.getElementById('graphView').style.display    = 'none';
  document.getElementById('gapView').style.display      = 'none';
  document.getElementById('maturityView').style.display  = 'none';
  const docsView = document.getElementById('docsFullView');
  if (docsView) docsView.style.display = 'none';
  if (graphInstance) { graphInstance.stop(); graphInstance = null; }
  if (analyticsPanel) analyticsPanel.hidden = true;
  document.getElementById('settingsPanel').hidden   = true;
  const sv2 = document.getElementById('settingsView');
  if (sv2) sv2.style.display = 'none';
  document.getElementById('graphNodeInfo').hidden   = true;
  document.getElementById('graphEmptyState').hidden = true;
  const dlp = document.getElementById('docListPanel');
  if (dlp) dlp.hidden = true;
  auditBlock.hidden = false;
  rpHeaderTitle.textContent = t('rightPanelTitle');
  rpHeaderIcon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  _setChatNavStatus('idle');
  const hb = document.getElementById('chatNavBtn');
  if (hb) hb.classList.add('active');
}

// ── Chat nav status indicator ─────────────────────────────────────────────────
function _setChatNavStatus(state) {
  const el = document.getElementById('chatNavStatus');
  if (!el) return;
  el.className = 'chat-nav-status';
  if (state === 'responding') {
    el.textContent = t('thinking');
    el.classList.add('cn-responding');
  } else if (state === 'ready') {
    el.textContent = t('ready');
    el.classList.add('cn-ready');
  } else {
    el.textContent = ''; // idle — no active session
  }
}

// ── Clear chat ────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  // Abort any in-flight chat request immediately
  if (_chatAbortCtrl) {
    _chatAbortCtrl.abort();
    _chatAbortCtrl = null;
  }
  _chatGeneration++; // invalidate any queued .then()/.catch()/.finally() callbacks
  // Restore input in case a request was in progress
  _awaitingResponse = false;
  chatInput.disabled = false;
  sendBtn.disabled = true;
  document.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());
  // Remove all message elements (keep welcome)
  Array.from(messagesEl.children).forEach(child => {
    if (child !== welcomeEl) child.remove();
  });
  welcomeEl.style.display = 'flex';
  inputMeta.style.display = 'none';
  selectedDocId = null;
  docPreview.hidden = true;
  rpEmpty.hidden = false;
  auditQueries.length = 0;
  renderAudit();
  _setChatNavStatus('idle');
  scrollToBottom();
});

// ── Sample prompts ─────────────────────────────────────────────────────────────
document.querySelectorAll('.sample-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const query = chip.textContent.trim();
    chatInput.value = query;
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 128) + 'px';
    sendBtn.disabled = false;
    sendMessage();
  });
});

// ── Core: send message ────────────────────────────────────────────────────────
let _awaitingResponse = false;

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || _awaitingResponse) return;

  // Hide welcome, show meta bar
  welcomeEl.style.display = 'none';
  inputMeta.style.display = 'flex';

  _chatSessionActive = true;

  // Append user bubble
  appendUserMessage(text);

  // Lock input while waiting
  _awaitingResponse = true;
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatInput.disabled = true;
  sendBtn.disabled = true;
  _setChatNavStatus('responding');

  // Add to audit
  auditQueries.unshift({ query: text, time: now(), role: currentRole });
  if (auditQueries.length > 5) auditQueries.pop();
  renderAudit();

  // Show typing indicator
  const typingId = 'typing-' + Date.now();
  appendTypingIndicator(typingId);
  scrollToBottom();

  // Capture generation at request start — stale callbacks bail out if incremented
  _chatAbortCtrl = new AbortController();
  const _myGen = ++_chatGeneration;

  // Fetch from FastAPI (JWT-authenticated)
  fetch('/api/chat', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ query: text, language: currentLang }),
    signal: _chatAbortCtrl.signal,
  })
    .then(r => {
      if (_myGen !== _chatGeneration) return null; // cancelled — discard
      if (r.status === 401) { _clearAuth(); _showLogin(); return null; }
      return r.json();
    })
    .then(data => {
      if (!data || _myGen !== _chatGeneration) return; // cancelled — discard silently
      removeTypingIndicator(typingId);
      const msgId = genId();
      if (data.type === 'no_answer') {
        updateAnalytics(data.type, null);
        appendNoAnswer(msgId);
      } else if (data.type === 'restricted') {
        updateAnalytics(data.type, data.doc || null);
        appendRestricted(msgId);
      } else {
        // New RAG response — prefer answer + sources; fall back to legacy doc format
        if (data.answer && data.sources) {
          updateAnalytics('answer', data.sources[0] ? {category: data.sources[0].category} : null);
          appendLlmResponseCard(msgId, data);
        } else if (data.doc) {
          updateAnalytics('answer', data.doc);
          appendResponseCard(msgId, data.doc, data.matched_keywords || []);
        } else {
          appendNoAnswer(msgId);
        }
      }
      scrollToBottom();
    })
    .catch((err) => {
      if (err.name === 'AbortError' || _myGen !== _chatGeneration) return; // cancelled — silent
      removeTypingIndicator(typingId);
      appendNoAnswer(genId());
      scrollToBottom();
    })
    .finally(() => {
      if (_myGen !== _chatGeneration) return; // cancelled — don't touch UI
      _chatAbortCtrl = null;
      // Unlock input — only re-focus chat if user is still on home/chat view
      _awaitingResponse = false;
      _setChatNavStatus('ready');
      chatInput.disabled = false;
      sendBtn.disabled = !chatInput.value.trim();
      if (_currentView === 'home' || _currentView === 'chat') chatInput.focus();
    });
}

// ── Append: user bubble ───────────────────────────────────────────────────────
function appendUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg-user';
  el.innerHTML = `
    <div class="msg-user-bubble">
      <p class="msg-user-text">${escHtml(text)}</p>
      <span class="msg-user-time">${now()}</span>
    </div>`;
  messagesEl.appendChild(el);
}

// ── Append: typing indicator ──────────────────────────────────────────────────
function appendTypingIndicator(id) {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = id;
  el.innerHTML = `
    <div class="msg-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    </div>
    <div class="typing-bubble">
      <div class="typing-dots">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
      <span class="typing-text">${t('typing')}</span>
    </div>`;
  messagesEl.appendChild(el);
}

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ── Append: response card ─────────────────────────────────────────────────────
function appendResponseCard(msgId, doc, keywords) {
  const cc      = confClass(doc.confidence_score);
  const clsCls  = `cls-${doc.classification}`;
  const content = highlightKeywords(doc.content, keywords);
  const chipSvgFile  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  const chipSvgUser  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const chipSvgTag   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
  const chipSvgCal   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

  const el = document.createElement('div');
  el.className = 'msg-assistant';
  el.dataset.msgId = msgId;
  el.dataset.docId = doc.id;

  el.innerHTML = `
    <div class="msg-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    </div>
    <div class="response-card" data-doc-id="${escHtml(doc.id)}">
      <div class="card-header">
        <div class="card-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span class="card-source-label">GovPal AI</span>
          <span class="card-time">${now()}</span>
        </div>
        <div class="card-conf" title="${escHtml(t('confidenceTooltip'))}">
          <span class="card-conf-pct text-${cc}">${doc.confidence_score}%</span>
          <div class="conf-track">
            <div class="conf-bar conf-${cc}" style="width:${doc.confidence_score}%"></div>
          </div>
          <span class="card-conf-label">${t('confidenceLabel')}</span>
        </div>
      </div>
      <div class="card-body">
        <p class="card-doc-title">${escHtml(doc.title)}</p>
        <p class="card-content">${content}</p>
        <div class="card-chips">
          <span class="chip">${chipSvgFile}${escHtml(doc.id)}</span>
          <span class="chip">${chipSvgUser}${escHtml(doc.owner)}</span>
          <span class="chip chip-cls ${clsCls}">${chipSvgTag}${escHtml(doc.classification)}</span>
          <span class="chip">${chipSvgCal}${escHtml(doc.date)}</span>
        </div>
        <button class="view-source-btn" data-open="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          <span class="vs-label">${t('viewSource')}</span>
        </button>
        <div class="source-panel">
          <div class="source-content">
            <div class="source-content-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              ${escHtml(doc.title)}
            </div>
            <p class="source-text">${escHtml(doc.content)}</p>
          </div>
        </div>
        <div class="feedback-row">
          <span class="feedback-label">${t('wasHelpful')}</span>
          <div class="feedback-btns">
            <button class="feedback-btn" data-type="up" title="Helpful">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
            </button>
            <button class="feedback-btn" data-type="down" title="Not helpful">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
            </button>
          </div>
          <span class="feedback-thanks" style="display:none;">${t('feedbackThanks')}</span>
        </div>
      </div>
    </div>`;

  // Click card → populate right panel
  el.querySelector('.response-card').addEventListener('click', (e) => {
    if (e.target.closest('.view-source-btn') || e.target.closest('.feedback-btn')) return;
    populateRightPanel(doc);
  });

  // View source accordion
  const vsBtn   = el.querySelector('.view-source-btn');
  const vsPanel = el.querySelector('.source-panel');
  const vsLabel = el.querySelector('.vs-label');
  vsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = vsPanel.classList.toggle('open');
    vsBtn.classList.toggle('open', isOpen);
    vsLabel.textContent = isOpen ? t('hideSource') : t('viewSource');
  });

  // Feedback buttons
  el.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFeedback(msgId, btn.getAttribute('data-type'), el);
    });
  });

  messagesEl.appendChild(el);

  // ── Follow-up question chips ──────────────────────────────────────────────
  const fqs = _getFollowups(doc);
  if (fqs.length) {
    const fr = document.createElement('div');
    fr.className = 'followup-row';
    fr.innerHTML = '<span class="followup-label">Ask next →</span>' +
      fqs.map(q => `<button class="followup-chip">${escHtml(q)}</button>`).join('');
    fr.querySelectorAll('.followup-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chatInput.value = chip.textContent;
        chatInput.dispatchEvent(new Event('input'));
        sendBtn.disabled = false;
        sendMessage();
      });
    });
    messagesEl.appendChild(fr);
  }
}

// ── Follow-up question helper ─────────────────────────────────────────────────
function _getFollowups(doc) {
  const cat = (doc.category || doc.type || '').toLowerCase();
  if (cat.includes('policy')) return [
    'What are the penalties for non-compliance?',
    'Who is responsible for enforcing this?',
    'When was this last reviewed?',
  ];
  if (cat.includes('gloss') || cat.includes('term')) return [
    'How does this apply to our data contracts?',
    'What policy governs this term?',
    'Show me a related glossary entry.',
  ];
  if (cat.includes('contract')) return [
    'What SLAs apply to this data contract?',
    'Who are the data stewards?',
    'What quality rules are defined?',
  ];
  return [
    'What related policies apply?',
    'Who should I contact about this?',
    'Show me the relevant data contract.',
  ];
}
function handleFeedback(msgId, type, cardEl) {
  const prev = feedback[msgId];
  feedback[msgId] = (prev === type) ? null : type;

  const upBtn   = cardEl.querySelector('.feedback-btn[data-type="up"]');
  const downBtn = cardEl.querySelector('.feedback-btn[data-type="down"]');
  const thanks  = cardEl.querySelector('.feedback-thanks');

  upBtn.classList.remove('active-up');
  downBtn.classList.remove('active-down');

  if (feedback[msgId] === 'up')   { upBtn.classList.add('active-up'); }
  if (feedback[msgId] === 'down') { downBtn.classList.add('active-down'); }

  if (feedback[msgId]) {
    thanks.style.display = 'inline';
    setTimeout(() => { thanks.style.display = 'none'; }, 2500);
  }

  // Fire-and-forget to backend
  fetch('/api/feedback', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ msg_id: msgId, type: feedback[msgId] || '' }),
  }).catch(() => {});
}

// ── Append: LLM RAG response card (new format with answer + source chips) ────
function appendLlmResponseCard(msgId, data) {
  const sources  = data.sources || [];
  const model    = data.model   || 'bm25';
  const answer   = _cleanLlmAnswer(data.answer || '');
  const isFallback = data.fallback || model === 'bm25';

  const clsColor = { PUBLIC: '#22c55e', INTERNAL: '#3b82f6', CONFIDENTIAL: '#f59e0b',
                     RESTRICTED: '#ef4444', PARTNER_ONLY: '#8b5cf6' };

  const sourceChips = sources.map(s => {
    const pct = s.score ? Math.round(s.score * 100) : '';
    const col = clsColor[s.classification] || '#6b7280';
    return `<button class="source-chip" onclick="void(0)"
              title="${escHtml(s.title)} — ${escHtml(s.classification)}"
              style="border-color:${col}33">
              <span style="color:${col};font-weight:700">${escHtml(s.id)}</span>
              ${escHtml(s.title.substring(0, 28))}${s.title.length > 28 ? '…' : ''}
              ${pct ? `<span class="chip-score" title="${escHtml(t('retrievalScoreTooltip'))}">${pct}%</span>` : ''}
            </button>`;
  }).join('');

  const modelLabel = isFallback ? 'keyword search' : model;

  const el = document.createElement('div');
  el.className = 'msg-assistant';
  el.dataset.msgId = msgId;
  if (sources[0]) el.dataset.docId = sources[0].id;

  el.innerHTML = `
    <div class="msg-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    </div>
    <div class="response-card">
      <div class="card-header">
        <div class="card-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span class="card-source-label">GovGuard AI</span>
          <span class="card-time">${now()}</span>
        </div>
        <div class="card-conf">
          <span class="card-model-badge">${escHtml(modelLabel)}</span>
        </div>
      </div>
      <div class="card-body">
        <p class="card-llm-answer">${escHtml(answer)}</p>
        ${sources.length ? `
        <div class="sources-block">
          <div class="sources-title">${t('sources')} (${sources.length})</div>
          <div class="source-chips">${sourceChips}</div>
        </div>` : ''}
        ${(data.unverified_citations && data.unverified_citations.length) ? `
        <div class="citation-warning">
          <div class="citation-warning-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span class="citation-warning-label">${t('citationWarningTitle')}</span>
          </div>
          <p class="citation-warning-text">${escHtml(t('citationWarningText').replace('{ids}', data.unverified_citations.join(', ')))}</p>
        </div>` : ''}
        <div class="disclaimer-block">
          <div class="disclaimer-header">
            <div class="disclaimer-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <span class="disclaimer-header-label">${t('aiDisclaimer')}</span>
          </div>
          <div class="disclaimer-body">
            <p class="disclaimer-text">${t('disclaimerText')}</p>
          </div>
        </div>
        <div class="feedback-row">
          <span class="feedback-label">${t('wasHelpful')}</span>
          <div class="feedback-btns">
            <button class="feedback-btn" data-type="up" title="Helpful">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
            </button>
            <button class="feedback-btn" data-type="down" title="Not helpful">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
            </button>
          </div>
          <span class="feedback-thanks" style="display:none;">${t('feedbackThanks')}</span>
        </div>
      </div>
    </div>`;

  // Feedback buttons
  el.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFeedback(msgId, btn.getAttribute('data-type'), el);
    });
  });

  messagesEl.appendChild(el);

  // Follow-up chips (based on first source category)
  const fqDoc = sources[0] ? { category: sources[0].category } : null;
  if (fqDoc) {
    const fqs = _getFollowups(fqDoc);
    if (fqs.length) {
      const fr = document.createElement('div');
      fr.className = 'followup-row';
      fr.innerHTML = '<span class="followup-label">Ask next →</span>' +
        fqs.map(q => `<button class="followup-chip">${escHtml(q)}</button>`).join('');
      fr.querySelectorAll('.followup-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          chatInput.value = chip.textContent;
          chatInput.dispatchEvent(new Event('input'));
          sendBtn.disabled = false;
          sendMessage();
        });
      });
      messagesEl.appendChild(fr);
    }
  }
}

// ── Append: no-answer card ────────────────────────────────────────────────────
function appendNoAnswer(msgId) {
  const el = document.createElement('div');
  el.className = 'msg-assistant';
  el.innerHTML = `
    <div class="msg-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    </div>
    <div class="no-answer-card">
      <div class="no-answer-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>${t('noAnswerTitle')}</span>
      </div>
      <p class="no-answer-sub">${t('noAnswerSubtitle')}</p>
      <button class="no-answer-cta">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        ${t('noAnswerCta')}
      </button>
      <div class="feedback-row" style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);">
        <span class="feedback-label">${t('wasHelpful')}</span>
        <div class="feedback-btns">
          <button class="feedback-btn" data-type="up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          </button>
          <button class="feedback-btn" data-type="down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          </button>
        </div>
        <span class="feedback-thanks" style="display:none;">${t('feedbackThanks')}</span>
      </div>
    </div>`;

  el.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFeedback(msgId, btn.getAttribute('data-type'), el));
  });

  messagesEl.appendChild(el);
}

// ── Append: restricted card ───────────────────────────────────────────────────
function appendRestricted(msgId) {
  const el = document.createElement('div');
  el.className = 'msg-assistant';
  el.innerHTML = `
    <div class="msg-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    </div>
    <div class="restricted-card">
      <div class="restricted-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>${t('restrictedTitle')}</span>
      </div>
      <p class="restricted-sub">${t('restrictedSubtitle')}</p>
      <div class="feedback-row" style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);">
        <span class="feedback-label">${t('wasHelpful')}</span>
        <div class="feedback-btns">
          <button class="feedback-btn" data-type="up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          </button>
          <button class="feedback-btn" data-type="down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          </button>
        </div>
        <span class="feedback-thanks" style="display:none;">${t('feedbackThanks')}</span>
      </div>
    </div>`;

  el.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFeedback(msgId, btn.getAttribute('data-type'), el));
  });

  messagesEl.appendChild(el);
}

// ── Right panel population ────────────────────────────────────────────────────
function populateRightPanel(doc) {
  selectedDocId = doc.id;
  const cc = confClass(doc.confidence_score);

  document.getElementById('rpDocTitle').textContent = doc.title;
  document.getElementById('rpDocId').textContent    = doc.id;
  document.getElementById('rpDocOwner').textContent = doc.owner;
  document.getElementById('rpDocDate').textContent  = doc.date;
  document.getElementById('rpDocCat').textContent   = doc.category;
  document.getElementById('rpDocConf').textContent  = `${doc.confidence_score}%`;

  const clsEl = document.getElementById('rpDocCls');
  clsEl.textContent = doc.classification;
  clsEl.className   = `cls-badge cls-${doc.classification}`;

  const confBar = document.getElementById('rpDocConfBar');
  const gradMap = { green: 'var(--emerald)', yellow: 'var(--yellow)', red: 'var(--red)' };
  confBar.style.cssText = `width:${doc.confidence_score}%;background:${gradMap[cc]};height:100%;border-radius:999px;animation:confGrow 0.9s ease both;`;

  // Tags
  const tagsEl = document.getElementById('rpDocTags');
  tagsEl.innerHTML = '';
  (doc.tags || []).slice(0, 7).forEach(tag => {
    const span = document.createElement('span');
    span.className = 'tag-pill';
    span.textContent = tag;
    tagsEl.appendChild(span);
  });

  docPreview.hidden = false;
  rpEmpty.hidden    = true;
}

// ── Audit trail ───────────────────────────────────────────────────────────────
function renderAudit() {
  auditList.innerHTML = '';
  if (!auditQueries.length) {
    auditList.innerHTML = `<p class="audit-empty">${t('auditEmpty')}</p>`;
    return;
  }
  auditQueries.forEach(({ query, time, role }) => {
    const el = document.createElement('div');
    el.className = 'audit-entry';
    el.innerHTML = `
      <span class="audit-dot"></span>
      <div style="min-width:0;flex:1;">
        <p class="audit-query">${escHtml(query)}</p>
        <p class="audit-time">${time}${role ? ` · <span style="color:var(--orange);font-size:9px;">${escHtml(role)}</span>` : ''}</p>
      </div>`;
    auditList.appendChild(el);
  });
}

// ── Audit Dashboard (real backend data, Manager/Partner only) ─────────────────
async function loadAuditDashboard() {
  const listEl  = document.getElementById('auditDashList');
  const totalEl = document.getElementById('auditStatTotal');
  const piiEl   = document.getElementById('auditStatPii');
  const noAnsEl = document.getElementById('auditStatNoAnswer');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">Loading\u2026</p>';
  try {
    const resp = await fetch('/api/audit-log?n=100', { headers: _authHeaders() });
    if (!resp.ok) throw new Error();
    const data    = await resp.json();
    const entries = data.entries || [];
    const stats   = data.stats   || {};

    if (totalEl) totalEl.textContent = stats.total_queries ?? entries.length;
    if (piiEl)   piiEl.textContent   = stats.pii_detected  ?? entries.filter(e => e.pii_detected).length;
    if (noAnsEl) noAnsEl.textContent = (stats.by_response && stats.by_response.no_answer) || 0;

    if (!entries.length) {
      listEl.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">No audit entries yet.</p>';
      return;
    }

    const rows = entries.map(e => {
      const ts      = escHtml((e.timestamp || '').replace('T', ' ').slice(0, 19));
      const piiTag  = e.pii_detected
        ? '<span style="color:#ef4444;font-weight:600;">FLAGGED</span>'
        : '<span style="color:#9ca3af;">\u2014</span>';
      const hashVal = escHtml((e.query_hash || '').slice(0, 12));
      return `<tr style="border-bottom:1px solid #f1f1f1;">
        <td style="padding:6px 8px;white-space:nowrap;">${ts}</td>
        <td style="padding:6px 8px;">${escHtml(e.role || '')}</td>
        <td style="padding:6px 8px;">${escHtml(e.response_type || '')}</td>
        <td style="padding:6px 8px;">${escHtml(e.model || '')}</td>
        <td style="padding:6px 8px;">${e.n_sources ?? 0}</td>
        <td style="padding:6px 8px;">${e.latency_ms ?? 0} ms</td>
        <td style="padding:6px 8px;">${piiTag}</td>
        <td style="padding:6px 8px;font-family:monospace;color:var(--text-muted);">${hashVal}\u2026</td>
      </tr>`;
    }).join('');

    listEl.innerHTML = `<table style="width:100%;min-width:640px;border-collapse:collapse;font-size:11px;">
      <thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid #e5e7eb;">
        <th style="padding:6px 8px;">Time (UTC)</th><th style="padding:6px 8px;">Role</th><th style="padding:6px 8px;">Type</th>
        <th style="padding:6px 8px;">Model</th><th style="padding:6px 8px;">Sources</th><th style="padding:6px 8px;">Latency</th>
        <th style="padding:6px 8px;">PII</th><th style="padding:6px 8px;">Query Hash</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch {
    listEl.innerHTML = '<p style="color:var(--red);font-size:12px;">Error loading audit log (Manager/Partner access required).</p>';
  }
}

// ── Live analytics ───────────────────────────────────────────────────────────
function updateAnalytics(type, doc) {
  queryStats.total++;
  if (type === 'restricted') queryStats.restricted++;
  if (type === 'no_answer')  queryStats.noAnswer++;
  if (type === 'answer' && doc) {
    const id = doc.id || '';
    if (id.startsWith('POL'))      queryStats.policy++;
    else if (id.startsWith('GLO')) queryStats.glossary++;
    else if (id.startsWith('DC'))  queryStats.contract++;
    queryStats.totalConf += doc.confidence_score || 0;
  }
  const answered = queryStats.policy + queryStats.glossary + queryStats.contract;
  const get = id => document.getElementById(id);
  if (get('kpiTotal'))      get('kpiTotal').textContent      = queryStats.total;
  if (get('kpiConf'))       get('kpiConf').textContent       = answered > 0 ? Math.round(queryStats.totalConf / answered) + '%' : '—';
  if (get('kpiRestricted')) get('kpiRestricted').textContent = queryStats.restricted;
  const pct = v => answered > 0 ? Math.round(v / answered * 100) : 0;
  const pp = pct(queryStats.policy), gp = pct(queryStats.glossary), cp = pct(queryStats.contract);
  if (get('distPolicyBar'))   get('distPolicyBar').style.width   = pp + '%';
  if (get('distPolicyPct'))   get('distPolicyPct').textContent   = pp + '%';
  if (get('distGlossaryBar')) get('distGlossaryBar').style.width = gp + '%';
  if (get('distGlossaryPct')) get('distGlossaryPct').textContent = gp + '%';
  if (get('distContractBar')) get('distContractBar').style.width = cp + '%';
  if (get('distContractPct')) get('distContractPct').textContent = cp + '%';
}

// ── Knowledge Graph ───────────────────────────────────────────────────────────
class ForceGraph {
  constructor(canvas, data) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.nodes  = data.nodes.map(n => ({
      ...n,
      x: canvas.width  / 2 + (Math.random() - 0.5) * 300,
      y: canvas.height / 2 + (Math.random() - 0.5) * 200,
      vx: 0, vy: 0, radius: 26,
    }));
    this.edges    = data.edges;
    this.selected = null;
    this.hovered  = null;
    this.dragging = null;
    this.animId   = null;
    this.running  = false;
    this.filter   = 'all';
    this._bind();
  }
  _bind() {
    this.canvas.addEventListener('mousedown',  e => this._down(e));
    this.canvas.addEventListener('mousemove',  e => this._move(e));
    this.canvas.addEventListener('mouseup',    () => this._up());
    this.canvas.addEventListener('mouseleave', () => this._up());
  }
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (this.canvas.width / r.width), y: (e.clientY - r.top) * (this.canvas.height / r.height) };
  }
  _hit(x, y) {
    for (const n of this.nodes) {
      const dx = x - n.x, dy = y - n.y;
      if (dx*dx + dy*dy < n.radius * n.radius) return n;
    }
    return null;
  }
  _down(e) {
    const {x, y} = this._pos(e);
    const node   = this._hit(x, y);
    this.dragging = node;
    if (node) { node._ox = x - node.x; node._oy = y - node.y; }
    this.selected = node;
    onGraphNodeSelect(node);
  }
  _move(e) {
    const {x, y} = this._pos(e);
    this.hovered = this._hit(x, y);
    this.canvas.style.cursor = this.hovered ? 'pointer' : 'default';
    if (!this.dragging) return;
    this.dragging.x = x - (this.dragging._ox || 0);
    this.dragging.y = y - (this.dragging._oy || 0);
    this.dragging.vx = 0; this.dragging.vy = 0;
  }
  _up() {
    if (this.dragging) {
      // Pin the node — it will no longer move with physics
      this.dragging.pinned = true;
    }
    this.dragging = null;
  }
  _tick() {
    // After stabilisation, only update non-pinned, non-dragged nodes
    const W = this.canvas.width, H = this.canvas.height;
    if (this._stabilised) return;
    this._tickCount = (this._tickCount || 0) + 1;
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i], b = this.nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx*dx + dy*dy + 1, d = Math.sqrt(d2);
        const f = 7000 / d2, fx = f*dx/d, fy = f*dy/d;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    for (const e of this.edges) {
      const a = this.nodes.find(n => n.id === e.from), b = this.nodes.find(n => n.id === e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx*dx + dy*dy) + 0.01;
      const f = 0.06 * (d - 130), fx = f*dx/d, fy = f*dy/d;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const n of this.nodes) {
      n.vx += (W/2 - n.x) * 0.003; n.vy += (H/2 - n.y) * 0.003;
      if (n === this.dragging || n.pinned) continue;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x = Math.max(n.radius+10, Math.min(W-n.radius-10, n.x + n.vx));
      n.y = Math.max(n.radius+10, Math.min(H-n.radius-10, n.y + n.vy));
    }
    // Freeze physics after 180 ticks — layout settles, nodes then stay where placed
    if (this._tickCount >= 180) this._stabilised = true;
  }
  _draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const isDay = document.documentElement.getAttribute('data-theme') === 'day';
    ctx.clearRect(0, 0, W, H);
    // Background
    ctx.fillStyle = isDay ? '#f5ede8' : '#0f0f1a';
    ctx.fillRect(0, 0, W, H);
    // Subtle dot grid
    ctx.fillStyle = isDay ? 'rgba(80,30,10,0.06)' : 'rgba(255,255,255,0.02)';
    for (let x = 30; x < W; x += 40) for (let y = 30; y < H; y += 40) {
      ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI*2); ctx.fill();
    }
    // Edge colors: theme-aware
    const edgeStroke    = isDay ? 'rgba(60,30,10,0.30)' : 'rgba(255,255,255,0.22)';
    const edgeArrow     = isDay ? 'rgba(60,30,10,0.38)' : 'rgba(255,255,255,0.30)';
    for (const e of this.edges) {
      const a = this.nodes.find(n => n.id === e.from), b = this.nodes.find(n => n.id === e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx*dx + dy*dy);
      if (d < 1) continue;
      const ux = dx/d, uy = dy/d;
      ctx.strokeStyle = edgeStroke; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      // Arrowhead
      const ax = b.x - (b.radius+5)*ux, ay = b.y - (b.radius+5)*uy, ang = Math.atan2(dy, dx);
      ctx.strokeStyle = edgeArrow; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 9*Math.cos(ang-0.42), ay - 9*Math.sin(ang-0.42));
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 9*Math.cos(ang+0.42), ay - 9*Math.sin(ang+0.42));
      ctx.stroke();
      // Edge labels are NOT drawn on canvas — they appear in the right panel on node click
    }
    // Nodes
    const nodeLabelColor = isDay ? 'rgba(30,15,5,0.75)' : 'rgba(180,180,210,0.85)';
    const nodeLabelSel   = isDay ? '#1a0a00' : '#e0e0ee';
    for (const n of this.nodes) {
      const sel = n === this.selected, hov = n === this.hovered, r = n.radius;
      const dimmed = this.filter !== 'all' && n.type !== this.filter;
      ctx.globalAlpha = dimmed ? 0.18 : 1.0;
      if (sel || hov) {
        const g = ctx.createRadialGradient(n.x, n.y, r*0.4, n.x, n.y, r*2.8);
        g.addColorStop(0, n.color + (sel ? '55' : '33')); g.addColorStop(1, 'transparent');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r*2.8, 0, Math.PI*2); ctx.fill();
      }
      ctx.strokeStyle = n.color + (sel ? 'ff' : 'aa'); ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2); ctx.stroke();
      const fg = ctx.createRadialGradient(n.x-r*0.3, n.y-r*0.3, 0, n.x, n.y, r);
      fg.addColorStop(0, n.color+'45'); fg.addColorStop(1, n.color+'12');
      ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2); ctx.fill();
      ctx.font = `bold ${Math.round(r*0.6)}px Inter,system-ui,sans-serif`;
      ctx.fillStyle = n.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(n.type[0], n.x, n.y);
      const maxL = 13, lbl = n.label.length > maxL ? n.label.slice(0,maxL)+'\u2026' : n.label;
      ctx.font = `${sel ? 600 : 400} 10px Inter,system-ui,sans-serif`;
      ctx.fillStyle = sel ? nodeLabelSel : nodeLabelColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(lbl, n.x, n.y + r + 6);
      ctx.globalAlpha = 1.0;
    }
  }
  start() {
    this.running = true;
    const loop = () => { if (!this.running) return; this._tick(); this._draw(); this.animId = requestAnimationFrame(loop); };
    this.animId = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
  }
  setFilter(type) { this.filter = type; }
}

function loadGraph() {
  const canvas = document.getElementById('graphCanvas');
  const loading = document.getElementById('graphLoading');
  if (!canvas) return;
  // Size canvas
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth  || 800;
  canvas.height = wrap.clientHeight || 500;
  if (graphInstance) { graphInstance.stop(); graphInstance = null; }

  if (_graphCache) {
    // Use pre-fetched data — instant, no network request
    loading.hidden = true;
    const sn = document.getElementById('gStatNodes'), se = document.getElementById('gStatEdges');
    if (sn) sn.textContent = _graphCache.nodes.length;
    if (se) se.textContent = _graphCache.edges.length;
    graphInstance = new ForceGraph(canvas, _graphCache);
    graphInstance.start();
    return;
  }

  loading.hidden = false;
  fetch('/api/graph', { headers: _authHeaders() })
    .then(r => { if (r.status === 401) { _clearAuth(); _showLogin(); return null; } return r.json(); })
    .then(data => {
      if (!data) return;
      _graphCache = data;
      loading.hidden = true;
      const sn = document.getElementById('gStatNodes'), se = document.getElementById('gStatEdges');
      if (sn) sn.textContent = data.nodes.length;
      if (se) se.textContent = data.edges.length;
      graphInstance = new ForceGraph(canvas, data);
      graphInstance.start();
    })
    .catch(() => {
      loading.hidden = true;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f0f1a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = '12px Inter,system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,100,100,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText('Could not load graph data — check Data_Mesh folder path', canvas.width/2, canvas.height/2);
    });
}

function onGraphNodeSelect(node) {
  const gni = document.getElementById('graphNodeInfo');
  const ge  = document.getElementById('graphEmptyState');
  if (!node) { if (gni) gni.hidden = true; if (ge) ge.hidden = false; return; }
  if (ge)  ge.hidden  = true;
  if (gni) gni.hidden = false;
  const badge = document.getElementById('gnBadge');
  if (badge) {
    badge.innerHTML = `<span style="background:${node.color}22;color:${node.color};border:1px solid ${node.color}55;display:inline-flex;align-items:center;padding:3px 10px;border-radius:5px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">${escHtml(node.type)}</span>`;
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('gnLabel', node.label);
  set('gnId',    node.id);
  set('gnType',  node.type);
  set('gnDesc',  node.description || '—');
  // Lineage
  const gnLineage     = document.getElementById('gnLineage');
  const gnLineageList = document.getElementById('gnLineageList');
  const gnLineageEmpty = document.getElementById('gnLineageEmpty');
  if (gnLineage) {
    gnLineage.hidden = false;
    gnLineageList.innerHTML = '<p style="font-size:11px;color:var(--text-400);">Loading…</p>';
    gnLineageEmpty.hidden = true;
    fetch(`/api/lineage/${encodeURIComponent(node.id)}`, { headers: _authHeaders() })
      .then(r => r.json())
      .then(data => {
        // Connections (predecessors + successors with edge labels)
        const connList = document.getElementById('gnConnectionsList');
        if (connList) {
          connList.innerHTML = '';
          const allConns = [
            ...(data.predecessors || []).map(p => ({ label: p.label, type: p.type, relation: p.relation, dir: '←' })),
            ...(data.successors   || []).map(s => ({ label: s.label, type: s.type, relation: s.relation, dir: '→' })),
          ];
          if (allConns.length === 0) {
            connList.innerHTML = '<p style="font-size:11px;color:var(--text-400);padding:2px 0;">No direct connections.</p>';
          } else {
            allConns.forEach(c => {
              const div = document.createElement('div');
              div.className = 'lineage-conn-item';
              div.innerHTML = `<span class="conn-dir">${c.dir}</span><span class="conn-rel">${escHtml(c.relation.replace(/_/g,' '))}</span><span class="conn-target">${escHtml(c.label)}</span>`;
              connList.appendChild(div);
            });
          }
        }
        // Linked documents
        gnLineageList.innerHTML = '';
        if (!data.docs || data.docs.length === 0) {
          gnLineageEmpty.hidden = false;
        } else {
          data.docs.forEach(doc => {
            const div = document.createElement('div');
            div.className = 'lineage-doc-item';
            div.innerHTML = `<span class="lineage-doc-id">${escHtml(doc.node_id || doc.id)}</span><span class="lineage-doc-title">${escHtml(doc.id)}</span>${doc.classification ? `<span class="cls-badge cls-${escHtml(doc.classification)}" style="font-size:9px;padding:1px 6px;">${escHtml(doc.classification)}</span>` : ''}`;
            gnLineageList.appendChild(div);
          });
        }
      })
      .catch(() => { gnLineageList.innerHTML = ''; gnLineageEmpty.hidden = false; });
  }}

// ── Init ──────────────────────────────────────────────────────────────────────
applyLanguage('EN');
renderAudit();

// Logo → home
document.querySelector('.sidebar-logo').addEventListener('click', goHome);

// Settings role display is read-only; updated by _applyJwtToUI() on login.

// Settings panel language buttons
document.querySelectorAll('#settingsLangBtns .settings-lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyLanguage(btn.getAttribute('data-lang'));
    document.querySelectorAll('#settingsLangBtns .settings-lang-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-lang') === currentLang);
    });
  });
});

// Resize graph canvas on window resize
window.addEventListener('resize', () => {
  if (!graphInstance) return;
  const canvas = document.getElementById('graphCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
});

// ── Graph filter chips ────────────────────────────────────────────────────────
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    graphFilter = chip.getAttribute('data-filter');
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    if (graphInstance) graphInstance.setFilter(graphFilter);
  });
});

// ── Policy Gap Analyser ───────────────────────────────────────────────────────
const DIM_COLORS = {
  'Data Classification':  '#ff6f00',
  'Data Retention':       '#f59e0b',
  'Data Quality':         '#10b981',
  'Access Control':       '#3b82f6',
  'Data Lineage':         '#8b5cf6',
  'Regulatory Compliance':'#ef4444',
};

const SUGGESTIONS = {
  'Data Classification': [
    'Define classification tiers: Public · Internal · Confidential · Restricted.',
    'Assign classification labels to all assets in your data inventory.',
    'Implement automated classification tooling for new data ingestions.',
  ],
  'Data Retention': [
    'Establish retention schedules aligned with CSSF, GDPR, and internal policy.',
    'Define archival and deletion procedures for each data category.',
    'Automate retention enforcement across storage and archive systems.',
  ],
  'Data Quality': [
    'Define quality dimensions: completeness, accuracy, timeliness, consistency.',
    'Set SLA thresholds per critical data domain and assign stewards.',
    'Implement automated quality checks at ingestion and transformation.',
  ],
  'Access Control': [
    'Implement role-based access control (RBAC) for all data platforms.',
    'Define access request, approval, and revocation workflows.',
    'Conduct quarterly access reviews and remove stale permissions.',
  ],
  'Data Lineage': [
    'Document end-to-end data flows for all regulatory and management reports.',
    'Deploy metadata tooling to capture provenance automatically.',
    'Map transformation rules from source systems to reporting outputs.',
  ],
  'Regulatory Compliance': [
    'Map processing activities to GDPR Articles and CSSF requirements.',
    'Establish a 72-hour breach notification procedure and test annually.',
    'Conduct annual compliance gap assessments as regulations evolve.',
  ],
};

const _ANALYSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

document.getElementById('gapAnalyseBtn').addEventListener('click', () => {
  const text  = document.getElementById('gapText').value.trim();
  const title = document.getElementById('gapTitle').value.trim() || 'Untitled Document';
  if (!text) { document.getElementById('gapText').focus(); return; }

  const btn = document.getElementById('gapAnalyseBtn');

  // ── Reset all results before new analysis ──────────────────────────────────
  document.getElementById('gapResults').hidden        = true;
  document.getElementById('gapOverallWrap').style.display = 'none';
  document.getElementById('gapDimList').innerHTML     = '';
  document.getElementById('gapGapsBlock').hidden      = true;
  document.getElementById('gapGapsList').innerHTML    = '';
  document.getElementById('gapSuggestBlock').hidden   = true;
  document.getElementById('gapSuggestList').innerHTML = '';
  document.getElementById('gapDraftBlock').hidden     = true;
  document.getElementById('gapDraftList').innerHTML   = '';
  document.getElementById('gapLiveBadge').hidden      = true;

  btn.disabled = true;
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;animation:spin 1s linear infinite"><circle cx="12" cy="12" r="10"/></svg> Analysing…';

  fetch('/api/gap-analysis', {
    method: 'POST',
    headers: _authHeaders(),
    body: JSON.stringify({ text, title }),
  })
    .then(r => { if (r.status === 401) { _clearAuth(); _showLogin(); throw new Error('401'); } if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      btn.disabled = false;
      btn.innerHTML = _ANALYSE_ICON + ' Analyse Document';

      const wrap = document.getElementById('gapOverallWrap');
      const oval = document.getElementById('gapOverallVal');
      wrap.style.display = 'flex';
      oval.textContent = data.overall + '%';
      oval.style.color = data.overall >= 70 ? '#10b981' : data.overall >= 40 ? '#f59e0b' : '#ef4444';

      const results = document.getElementById('gapResults');
      results.hidden = false;
      document.getElementById('gapResultsTitle').textContent = `"${escHtml(data.title)}" — Gap Analysis`;

      const list = document.getElementById('gapDimList');
      list.innerHTML = '';
      (data.scores || []).forEach(s => {
        const col      = DIM_COLORS[s.dimension] || '#888';
        const barColor = s.score >= 70 ? '#10b981' : s.score >= 40 ? '#f59e0b' : '#ef4444';
        const div = document.createElement('div');
        div.className = 'gap-dim-row';
        div.innerHTML = `
          <div class="gap-dim-header">
            <span class="gap-dim-name" style="color:${col}">${escHtml(s.dimension)}</span>
            <span class="gap-dim-score" style="color:${barColor}">${s.score}%</span>
          </div>
          <div class="gap-dim-track"><div class="gap-dim-bar" style="width:${s.score}%;background:${barColor};"></div></div>
          ${s.found.length ? `<p class="gap-dim-found">Keywords: ${s.found.map(escHtml).join(', ')}</p>` : '<p class="gap-dim-found gap-dim-missing">No coverage keywords found</p>'}`;
        list.appendChild(div);
      });

      const gapsBlock = document.getElementById('gapGapsBlock');
      const gapsList  = document.getElementById('gapGapsList');
      if (data.gaps && data.gaps.length > 0) {
        gapsBlock.hidden = false;
        gapsList.innerHTML = data.gaps.map(g => `<span class="gap-pill">${escHtml(g)}</span>`).join('');

        // ── Smart remediation suggestions ──────────────────────────────────
        const suggestBlock = document.getElementById('gapSuggestBlock');
        const suggestList  = document.getElementById('gapSuggestList');
        const gapDims = data.gaps.slice(0, 4); // top 4 gaps for brevity
        const items = [];
        gapDims.forEach(dim => {
          const tips = SUGGESTIONS[dim] || [];
          if (tips.length) items.push({ dim, tip: tips[0] }, { dim, tip: tips[1] });
        });
        if (items.length) {
          suggestList.innerHTML = items.map(it =>
            `<div class="gap-suggest-item"><span>${escHtml(it.tip)}</span></div>`
          ).join('');
          suggestBlock.hidden = false;
        }

        // ── AI Policy Clause Drafter ─────────────────────────────────────
        const draftBlock = document.getElementById('gapDraftBlock');
        const draftList  = document.getElementById('gapDraftList');
        const clauseDims = data.gaps.slice(0, 3);
        if (clauseDims.length) {
          draftList.innerHTML = clauseDims.map(dim => {
            const clause = _getPolicyClause(dim, data.title || title);
            const col    = DIM_COLORS[dim] || '#8b5cf6';
            return `
              <div class="draft-clause">
                <div class="draft-clause-header">
                  <span class="draft-dim-label" style="color:${col}">${escHtml(dim)}</span>
                  <button class="draft-copy-btn" data-clause="${encodeURIComponent(clause)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copy
                  </button>
                </div>
                <pre class="draft-clause-text">${escHtml(clause)}</pre>
              </div>`;
          }).join('');

          draftList.querySelectorAll('.draft-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const text = decodeURIComponent(btn.getAttribute('data-clause'));
              if (navigator.clipboard) { navigator.clipboard.writeText(text); }
              const prev = btn.innerHTML;
              btn.textContent = '\u2713 Copied!';
              setTimeout(() => { btn.innerHTML = prev; }, 1800);
            });
          });
          draftBlock.hidden = false;
        }
      } else {
        gapsBlock.hidden = true;
      }
    })
    .catch(() => {
      btn.disabled = false;
      btn.innerHTML = _ANALYSE_ICON + ' Analyse Document';
    });
});



// ── Export Audit PDF ──────────────────────────────────────────────────────────
document.getElementById('exportAuditBtn').addEventListener('click', exportAuditPDF);

function exportAuditPDF() {
  const rows = auditQueries.map(q =>
    `<tr><td>${escHtml(q.time)}</td><td>${escHtml(q.query)}</td><td>${escHtml(q.role || '')}</td></tr>`
  ).join('') || '<tr><td colspan="3" style="color:#999;text-align:center;">No activity recorded</td></tr>';

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>GovPal Audit Trail</title>
<style>
  body{font-family:Arial,sans-serif;color:#111;padding:40px;max-width:800px;margin:0 auto}
  h1{color:#ff6f00;margin-bottom:4px}
  .sub{color:#666;font-size:13px;margin-bottom:24px}
  table{width:100%;border-collapse:collapse;margin-top:20px}
  th{background:#ff6f00;color:#fff;padding:9px 14px;text-align:left;font-size:13px}
  td{padding:8px 14px;border-bottom:1px solid #eee;font-size:13px}
  tr:nth-child(even) td{background:#fafafa}
  .footer{margin-top:36px;color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:14px}
  @media print{body{padding:0}}
</style></head><body>
<h1>GovPal-GovGuard · Audit Trail</h1>
<p class="sub">Exported: ${new Date().toLocaleString()} &nbsp;|&nbsp; Nexum Financial S.A. · Data Governance Office</p>
<table>
  <thead><tr><th>Time</th><th>Query</th><th>Role</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="footer">GovPal-GovGuard V1 Prototype · AI Data Governance Assistant · Nexum Financial S.A. · Confidential</div>
</body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 4 — THEME TOGGLE + GOVERNANCE MATURITY DASHBOARD + POLICY DRAFTER
// ════════════════════════════════════════════════════════════════════════════

// ── Day / Night Theme Toggle ─────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('govpal-theme') || 'night';
  applyTheme(saved);
})();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const moon = document.getElementById('themeIconMoon');
  const sun  = document.getElementById('themeIconSun');
  const btn  = document.getElementById('themeToggle');
  if (theme === 'day') {
    if (moon) moon.style.display = 'none';
    if (sun)  sun.style.display  = '';
    if (btn)  btn.title = 'Switch to Night Mode';
  } else {
    if (moon) moon.style.display = '';
    if (sun)  sun.style.display  = 'none';
    if (btn)  btn.title = 'Switch to Day Mode';
  }
  // Re-draw radar if maturity view is active
  if (document.getElementById('maturityView') &&
      document.getElementById('maturityView').style.display !== 'none') {
    drawRadarChart();
  }
}

document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'night';
  const next    = current === 'day' ? 'night' : 'day';
  localStorage.setItem('govpal-theme', next);
  applyTheme(next);
});

// ── Maturity View Entry Point ─────────────────────────────────────────────────
let _maturityLoaded = false;

function loadMaturityView() {
  if (_maturityLoaded) {
    // Re-draw radar in case of resize or theme change
    requestAnimationFrame(drawRadarChart);
    return;
  }
  _maturityLoaded = true;
  requestAnimationFrame(() => {
    drawRadarChart();
    renderHeatmap();
    renderRegTimeline();
    buildRadarLegend();
  });
}

// ── Maturity Data ─────────────────────────────────────────────────────────────
const RADAR_DIMS = [
  { label: ['Data', 'Classification'], score: 2, target: 4, color: '#ff6f00' },
  { label: ['Data', 'Retention'],      score: 3, target: 4, color: '#f59e0b' },
  { label: ['Data', 'Quality'],        score: 2, target: 4, color: '#10b981' },
  { label: ['Access', 'Control'],      score: 4, target: 5, color: '#3b82f6' },
  { label: ['Data', 'Lineage'],        score: 2, target: 4, color: '#8b5cf6' },
  { label: ['Reg.', 'Compliance'],     score: 4, target: 5, color: '#ef4444' },
];
const RADAR_AVG = (RADAR_DIMS.reduce((s, d) => s + d.score, 0) / RADAR_DIMS.length).toFixed(1);

// ── Radar Chart (Canvas) ──────────────────────────────────────────────────────
function drawRadarChart() {
  const canvas = document.getElementById('radarCanvas');
  if (!canvas) return;

  const wrap = canvas.parentElement;
  const size = Math.min(wrap.clientWidth || 320, 340);
  canvas.width  = size;
  canvas.height = size;

  const ctx    = canvas.getContext('2d');
  const isDay  = document.documentElement.getAttribute('data-theme') === 'day';
  const n      = RADAR_DIMS.length;
  const levels = 5;
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 + 8;
  const maxR = Math.min(W, H) * 0.295;

  const ringColor  = isDay ? 'rgba(60,20,10,0.09)'   : 'rgba(255,255,255,0.07)';
  const labelColor = isDay ? 'rgba(30,10,5,0.55)'    : 'rgba(255,255,255,0.45)';
  const bgFill     = isDay ? '#fdf6f2'                : '#0f0f1a';

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = bgFill;
  ctx.fillRect(0, 0, W, H);

  // Level rings (hexagon)
  for (let lvl = 1; lvl <= levels; lvl++) {
    const r = maxR * lvl / levels;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = Math.PI * 2 * i / n - Math.PI / 2;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();

    if (lvl === 3) {
      ctx.fillStyle = isDay ? 'rgba(60,20,10,0.025)' : 'rgba(255,255,255,0.015)';
      ctx.fill();
    }
    ctx.strokeStyle = ringColor;
    ctx.lineWidth   = lvl === levels ? 1.5 : 1;
    ctx.stroke();

    // Level number
    ctx.font = '9px Inter,sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = labelColor;
    ctx.fillText(lvl, cx + 4, cy - maxR * lvl / levels + 1);
  }

  // Axis spokes
  for (let i = 0; i < n; i++) {
    const a = Math.PI * 2 * i / n - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + maxR * Math.cos(a), cy + maxR * Math.sin(a));
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Target area (dashed)
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = Math.PI * 2 * i / n - Math.PI / 2;
    const r = maxR * RADAR_DIMS[i].target / levels;
    i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
            : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = isDay ? 'rgba(212,67,15,0.40)' : 'rgba(255,111,0,0.40)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.fillStyle   = isDay ? 'rgba(212,67,15,0.05)' : 'rgba(255,111,0,0.05)';
  ctx.fill();
  ctx.setLineDash([]);

  // Current area (solid, animated via simple gradient)
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
  grad.addColorStop(0, isDay ? 'rgba(212,67,15,0.22)' : 'rgba(255,111,0,0.22)');
  grad.addColorStop(1, isDay ? 'rgba(212,67,15,0.04)' : 'rgba(255,111,0,0.04)');

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = Math.PI * 2 * i / n - Math.PI / 2;
    const r = maxR * RADAR_DIMS[i].score / levels;
    i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
            : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
  ctx.fillStyle   = grad;
  ctx.fill();
  ctx.strokeStyle = isDay ? '#d4430f' : '#ff6f00';
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  // Vertex dots + glow
  for (let i = 0; i < n; i++) {
    const a  = Math.PI * 2 * i / n - Math.PI / 2;
    const r  = maxR * RADAR_DIMS[i].score / levels;
    const x  = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    const col = RADAR_DIMS[i].color;

    // Glow halo
    const grd = ctx.createRadialGradient(x, y, 0, x, y, 12);
    grd.addColorStop(0, col + '55');
    grd.addColorStop(1, col + '00');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle   = col;
    ctx.fill();
    ctx.strokeStyle = bgFill;
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  // Dimension labels
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const a   = Math.PI * 2 * i / n - Math.PI / 2;
    const lr  = maxR + 32;
    const x   = cx + lr * Math.cos(a), y = cy + lr * Math.sin(a);
    const col = RADAR_DIMS[i].color;
    ctx.textAlign = 'center';
    ctx.font      = '700 9.5px Inter,sans-serif';
    RADAR_DIMS[i].label.forEach((word, wi) => {
      ctx.fillStyle = col;
      ctx.fillText(word, x, y + (wi - (RADAR_DIMS[i].label.length - 1) / 2) * 12);
    });
  }

  // Average badge in center
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = `bold 18px Inter,sans-serif`;
  ctx.fillStyle    = isDay ? '#d4430f' : '#ff6f00';
  ctx.fillText(RADAR_AVG, cx, cy - 6);
  ctx.font      = '10px Inter,sans-serif';
  ctx.fillStyle = labelColor;
  ctx.fillText('avg / 5', cx, cy + 10);

  // Update badge
  const avgEl = document.getElementById('maturityAvgVal');
  const chipEl = document.getElementById('maturityChip');
  if (avgEl)  avgEl.textContent  = RADAR_AVG;
  if (chipEl) chipEl.textContent = `Avg ${RADAR_AVG}\u2009/\u20095`;
}

// ── Radar Legend ──────────────────────────────────────────────────────────────
function buildRadarLegend() {
  const el = document.getElementById('radarLegend');
  if (!el) return;
  const labels = ['Data Classification', 'Data Retention', 'Data Quality', 'Access Control', 'Data Lineage', 'Reg. Compliance'];
  el.innerHTML = RADAR_DIMS.map((d, i) => `
    <div class="radar-legend-item">
      <div class="radar-legend-dot" style="background:${d.color}"></div>
      <span>${labels[i]}</span>
      <span class="radar-legend-score">${d.score}/${d.target}</span>
    </div>`
  ).join('');
}

// ── Domain Coverage Heatmap ───────────────────────────────────────────────────
function renderHeatmap() {
  const container = document.getElementById('heatmapContainer');
  if (!container) return;

  const DOMAINS = ['Client Data', 'Financial Data', 'Engagement Data', 'HR Data', 'Regulatory Data', 'Technology Data'];
  const DIMS    = ['Classification', 'Retention', 'Quality', 'Access', 'Lineage', 'Compliance'];
  const DIM_COL = ['#ff6f00', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444'];

  // Coverage scores (0-100) per [domain][dimension]
  const DATA = [
    [35, 60, 25, 70, 20, 80],   // Client
    [55, 75, 45, 85, 35, 90],   // Financial
    [40, 55, 30, 75, 25, 70],   // Engagement
    [65, 80, 50, 90, 40, 75],   // HR
    [70, 85, 60, 80, 55, 95],   // Regulatory
    [45, 50, 35, 65, 30, 60],   // Technology
  ];

  function cellColor(v) {
    if (v >= 75) return { bg: '#10b98120', border: '#10b98155', text: '#10b981' };
    if (v >= 50) return { bg: '#f59e0b20', border: '#f59e0b55', text: '#f59e0b' };
    if (v >= 25) return { bg: '#ef884420', border: '#ef884455', text: '#ef8844' };
    return           { bg: '#ef444420', border: '#ef444455', text: '#ef4444' };
  }

  let html = `<div class="heatmap-grid">
    <div class="heatmap-corner"></div>
    ${DIMS.map((d, i) => `<div class="heatmap-col-header" style="color:${DIM_COL[i]}">${d}</div>`).join('')}
    ${DOMAINS.map((dom, ri) => `
      <div class="heatmap-row-header">${dom}</div>
      ${DATA[ri].map((val, ci) => {
        const c = cellColor(val);
        return `<div class="heatmap-cell"
                     style="background:${c.bg};border-color:${c.border}"
                     data-domain="${dom}" data-dim="${DIMS[ci]}" data-val="${val}">
                  <span class="heatmap-cell-val" style="color:${c.text}">${val}%</span>
                </div>`;
      }).join('')}
    `).join('')}
  </div>`;

  container.innerHTML = html;

  // Cell click → highlight + right panel update
  container.querySelectorAll('.heatmap-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      container.querySelectorAll('.heatmap-cell').forEach(c => c.classList.remove('heatmap-cell-selected'));
      cell.classList.add('heatmap-cell-selected');
    });
  });
}

// ── Regulatory Calendar ───────────────────────────────────────────────────────
function renderRegTimeline() {
  const container = document.getElementById('regTimeline');
  if (!container) return;

  const today = new Date();
  const REGS  = [
    { date: '2025-02-12', label: 'EU Data Act — Entry into Force',        body: 'EU 2023/2854',    status: 'done' },
    { date: '2026-01-31', label: 'GDPR Art. 30 ROPA Annual Update',       body: 'CNPD Luxembourg', status: 'done' },
    { date: '2026-06-30', label: 'CSSF Circular 22/806 Review',           body: 'CSSF Luxembourg', status: 'upcoming' },
    { date: '2026-07-31', label: 'GDPR Annual DPA Self-Assessment',       body: 'CNPD Luxembourg', status: 'upcoming' },
    { date: '2026-08-02', label: 'EU AI Act High-Risk Compliance',        body: 'EU 2024/1689',    status: 'planned' },
    { date: '2026-09-30', label: 'DORA Technical Standards (TLPT)',       body: 'CSSF / EBA',      status: 'planned' },
    { date: '2027-01-31', label: 'GDPR Art. 30 ROPA Next Update',         body: 'CNPD Luxembourg', status: 'planned' },
  ];

  const STATUS = {
    done:     { color: '#10b981', icon: '✓' },
    upcoming: { color: '#f59e0b', icon: '!' },
    planned:  { color: '#3b82f6', icon: '○' },
  };

  container.innerHTML = REGS.map(reg => {
    const cfg  = STATUS[reg.status];
    const d    = new Date(reg.date);
    const days = Math.round((d - today) / 86400000);
    let daysHtml = '';
    if (reg.status !== 'done') {
      daysHtml = days > 0
        ? `<span class="reg-days" style="color:${cfg.color}">in ${days}d</span>`
        : `<span class="reg-days" style="color:#ef4444">${Math.abs(days)}d overdue</span>`;
    }
    const dateStr = d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
    return `
      <div class="reg-item reg-${reg.status}">
        <div class="reg-dot-wrap">
          <div class="reg-dot" style="background:${cfg.color}18;border-color:${cfg.color}66">
            <span style="color:${cfg.color};font-size:11px;font-weight:800;line-height:1">${cfg.icon}</span>
          </div>
          <div class="reg-line"></div>
        </div>
        <div class="reg-content">
          <div class="reg-row1">
            <span class="reg-label">${escHtml(reg.label)}</span>
            ${daysHtml}
          </div>
          <div class="reg-row2">
            <span class="reg-body">${escHtml(reg.body)}</span>
            <span class="reg-date">${dateStr}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── AI Policy Clause Templates ────────────────────────────────────────────────
const POLICY_TEMPLATES = {
  'Data Classification': `3.1  Classification Framework
All data assets shall be classified into one of the following tiers:
  (a) Public — intended for unrestricted disclosure.
  (b) Internal — for internal use only; not for external distribution.
  (c) Confidential — sensitive business data requiring enforced access controls.
  (d) Restricted — highly sensitive data (PII, financial, regulated) with strict
      encryption, logging, and approval requirements.

3.2  Roles & Responsibilities
Data Owners are accountable for assigning and maintaining classification labels.
The Chief Data Officer reviews the classification framework annually.

3.3  Handling Rules
Restricted data must be encrypted in transit (TLS 1.3+) and at rest (AES-256),
and all access events must be logged for a minimum of 12 months.`,

  'Data Retention': `4.1  Retention Schedules
Data shall be retained per schedules defined by data category, aligned with:
  • GDPR Article 5(1)(e) – storage limitation principle
  • CSSF requirements for financial records (min. 10 years)
  • Business operational needs

4.2  Deletion & Anonymisation Procedures
Personal data that has reached its retention limit shall be securely deleted
or irreversibly anonymised within 30 calendar days of the retention date,
unless subject to a valid legal hold.

4.3  Legal Holds
The Legal & Compliance team may place a hold on specific data sets, suspending
automated deletion until the hold is released in writing.`,

  'Data Quality': `5.1  Data Quality Standards
The organisation maintains quality standards across four dimensions:
  (a) Completeness — no mandatory fields shall be null at point of entry.
  (b) Accuracy     — data shall be validated against authoritative source systems.
  (c) Timeliness   — data shall be updated within the SLA defined per domain.
  (d) Consistency  — data definitions shall adhere to the Enterprise Data Dictionary.

5.2  Data Quality Monitoring
Automated quality checks shall run daily; results are published to the Data
Quality Dashboard. Breaches below 95% completeness trigger a P2 incident.

5.3  Remediation
Data Stewards are responsible for remediating quality issues within 5 business
days of detection and documenting root cause in the data governance register.`,

  'Access Control': `6.1  Role-Based Access Control (RBAC)
Access to data assets shall be granted on a need-to-know, least-privilege basis.
All access rights are assigned via roles defined in the corporate IAM system.

6.2  Access Request & Approval
Access requests must be submitted via the IT Service Portal, approved by the
data asset owner, and reviewed quarterly by the Data Governance Committee.

6.3  Privileged Access
Privileged (admin-level) access requires dual-approval, is time-limited to 8 hours,
and is fully logged. Session recordings are retained for 90 days.`,

  'Data Lineage': `7.1  Lineage Documentation
All critical data assets (Tier Confidential and above) shall have documented
lineage covering: source system, transformations applied, and consuming systems.

7.2  Lineage Tooling
Lineage shall be maintained in the organisation's approved metadata management
platform. Manual lineage records must be updated within 5 business days of
any pipeline or transformation change.

7.3  Impact Analysis
Before decommissioning any data source, a lineage-based impact analysis must
be completed and approved by the Data Governance Committee.`,

  'Regulatory Compliance': `8.1  Regulatory Register
The Compliance team maintains a register of all applicable data regulations
(GDPR, CSSF Circulars, DORA, EU AI Act) with mapped obligations and owners.

8.2  Compliance Assessments
Annual compliance assessments shall be conducted against all registered
regulations. Findings are rated Critical / High / Medium / Low and tracked
to remediation in the GRC system.

8.3  Breach Notification
Personal data breaches shall be reported to CNPD within 72 hours of discovery
per GDPR Article 33. Internal escalation must occur within 4 hours.`,
};

function _getPolicyClause(dim, docTitle) {
  const body = POLICY_TEMPLATES[dim] || `[Insert ${dim} policy content here]\n\nThis section should address:\n• Definitions and scope\n• Roles and responsibilities\n• Procedures and controls\n• Monitoring and review cycle`;
  return `\u2500\u2500\u2500 DRAFT CLAUSE \u2014 ${dim} \u2500\u2500\u2500\nDocument : ${docTitle || 'Untitled'}\nGenerated: ${new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}\n\n${body}\n\n\u2500\u2500\u2500 REVIEW BEFORE USE \u2014 Adapt to your organisation \u2500\u2500\u2500`;
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 5 — DOCUMENT UPLOAD  ·  LIVE COMPLIANCE SCORING  ·  CDO REPORT
// ════════════════════════════════════════════════════════════════════════════

// ── Document Upload ──────────────────────────────────────────────────────────
(function initUpload() {
  const fileInput = document.getElementById('gapFileInput');
  const fileNameEl = document.getElementById('gapFileName');
  const clearBtn  = document.getElementById('gapFileClear');
  const gapTitleEl = document.getElementById('gapTitle');
  const gapTextEl  = document.getElementById('gapText');
  if (!fileInput) return;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileNameEl.textContent = 'Uploading ' + file.name + '…';
    fileNameEl.className   = 'gap-file-name';
    clearBtn.hidden        = true;

    const fd = new FormData();
    fd.append('file', file);
    // Add auth token as header; FormData doesn't allow Content-Type override
    const uploadHeaders = _jwtToken ? { 'Authorization': 'Bearer ' + _jwtToken } : {};
    try {
      const r    = await fetch('/api/upload-doc', { method: 'POST', headers: uploadHeaders, body: fd });
      const data = await r.json();
      if (r.status === 401) { _clearAuth(); _showLogin(); return; }
      if (!r.ok) {
        fileNameEl.textContent = '\u26a0 ' + (data.detail || 'Upload failed');
        fileNameEl.className   = 'gap-file-name error';
        clearBtn.hidden = false;
        return;
      }
      gapTextEl.value  = data.text;
      gapTitleEl.value = file.name.replace(/\.[^.]+$/, '');
      const pages = data.pages > 1 ? ' \u00b7 ' + data.pages + ' pages' : '';
      fileNameEl.textContent = '\u2713 ' + file.name + pages;
      fileNameEl.className   = 'gap-file-name loaded';
      clearBtn.hidden        = false;
      gapTextEl.dispatchEvent(new Event('input'));
    } catch(e) {
      fileNameEl.textContent = '\u26a0 Upload error — check server';
      fileNameEl.className   = 'gap-file-name error';
      clearBtn.hidden = false;
    }
    fileInput.value = '';
  });

  clearBtn.addEventListener('click', () => {
    gapTextEl.value        = '';
    fileNameEl.textContent = '';
    fileNameEl.className   = 'gap-file-name';
    clearBtn.hidden        = true;
    document.getElementById('gapLiveBadge').hidden = true;
  });
})();

// ── Live Compliance Scoring ───────────────────────────────────────────────────
(function initLiveScoring() {
  const textarea = document.getElementById('gapText');
  if (!textarea) return;
  let _liveTimer = null;

  textarea.addEventListener('input', () => {
    const text = textarea.value.trim();
    clearTimeout(_liveTimer);
    const badge = document.getElementById('gapLiveBadge');
    if (text.length < 80) { badge.hidden = true; return; }
    badge.hidden = false;

    _liveTimer = setTimeout(() => {
      const title = document.getElementById('gapTitle').value.trim() || 'Live Analysis';
      fetch('/api/gap-analysis', {
        method: 'POST',
        headers: _authHeaders(),
        body: JSON.stringify({ text, title }),
      })
        .then(r => r.json())
        .then(data => {
          const wrap = document.getElementById('gapOverallWrap');
          const oval = document.getElementById('gapOverallVal');
          wrap.style.display = 'flex';
          oval.textContent   = data.overall + '%';
          oval.style.color   = data.overall >= 70 ? '#10b981' : data.overall >= 40 ? '#f59e0b' : '#ef4444';

          document.getElementById('gapResults').hidden = false;
          document.getElementById('gapResultsTitle').textContent =
            '"' + escHtml(data.title) + '" \u2014 Live Compliance Score';

          const list = document.getElementById('gapDimList');
          list.innerHTML = '';
          (data.scores || []).forEach(s => {
            const col      = DIM_COLORS[s.dimension] || '#888';
            const barColor = s.score >= 70 ? '#10b981' : s.score >= 40 ? '#f59e0b' : '#ef4444';
            const div = document.createElement('div');
            div.className = 'gap-dim-row';
            div.innerHTML =
              '<div class="gap-dim-header">' +
              '<span class="gap-dim-name" style="color:' + col + '">' + escHtml(s.dimension) + '</span>' +
              '<span class="gap-dim-score" style="color:' + barColor + '">' + s.score + '%</span>' +
              '</div>' +
              '<div class="gap-dim-track"><div class="gap-dim-bar" style="width:' + s.score + '%;background:' + barColor + ';"></div></div>';
            list.appendChild(div);
          });
        })
        .catch(() => {});
    }, 600);
  });
})();

// ── Executive CDO Report Generator ───────────────────────────────────────────
document.getElementById('genReportBtn').addEventListener('click', generateExecutiveReport);

function generateExecutiveReport() {
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const avgScore = parseFloat(RADAR_AVG);
  const matLevel = avgScore >= 4 ? 'Managed' : avgScore >= 3 ? 'Defined' : avgScore >= 2 ? 'Developing' : 'Initial';
  const labels6  = ['Data Classification','Data Retention','Data Quality','Access Control','Data Lineage','Regulatory Compliance'];
  const priorityDims = RADAR_DIMS.filter(d => d.score < 3).map(function(d){ return labels6[RADAR_DIMS.indexOf(d)]; });

  var matRows = RADAR_DIMS.map(function(d, i) {
    var pct = (d.score / 5 * 100).toFixed(0);
    var stat = d.score >= 4 ? 'On Track' : d.score >= 3 ? 'In Progress' : 'Attention';
    var col  = d.score >= 4 ? '#10b981' : d.score >= 3 ? '#f59e0b' : '#ef4444';
    var gap  = d.target - d.score;
    return '<tr><td>' + labels6[i] + '</td>' +
      '<td style="text-align:center;font-weight:700;color:' + d.color + '">' + d.score + ' / 5</td>' +
      '<td style="text-align:center;color:#888">' + d.target + ' / 5</td>' +
      '<td><div style="background:#e8e8e8;border-radius:4px;height:8px;"><div style="width:' + pct + '%;background:' + d.color + ';height:8px;border-radius:4px;"></div></div></td>' +
      '<td style="color:' + col + ';font-weight:600;font-size:11px;">' + stat + '</td>' +
      '<td style="text-align:center;color:#888;font-size:11px;">' + (gap > 0 ? '+' + gap + ' to target' : '\u2713 Met') + '</td></tr>';
  }).join('');

  var gapResultsEl = document.getElementById('gapResults');
  var gapTitleEl2  = document.getElementById('gapResultsTitle');
  var gapSection   = '<p style="color:#999;font-style:italic;font-size:12px;">No gap analysis run in this session. Use the Policy Gap Analyser tab to generate document-level findings.</p>';
  if (gapResultsEl && !gapResultsEl.hidden) {
    var dimRows = Array.from(document.querySelectorAll('.gap-dim-row')).map(function(row) {
      var name  = row.querySelector('.gap-dim-name')  ? row.querySelector('.gap-dim-name').textContent  : '';
      var score = row.querySelector('.gap-dim-score') ? row.querySelector('.gap-dim-score').textContent : '';
      var found = row.querySelector('.gap-dim-found') ? row.querySelector('.gap-dim-found').textContent : '';
      var sNum  = parseInt(score);
      var c     = sNum >= 70 ? '#10b981' : sNum >= 40 ? '#f59e0b' : '#ef4444';
      return '<tr><td>' + escHtml(name) + '</td>' +
        '<td style="text-align:center;font-weight:700;color:' + c + '">' + escHtml(score) + '</td>' +
        '<td><div style="background:#e8e8e8;border-radius:4px;height:7px;"><div style="width:' + sNum + '%;background:' + c + ';height:7px;border-radius:4px;"></div></div></td>' +
        '<td style="font-size:10px;color:#666;">' + escHtml(found) + '</td></tr>';
    }).join('');
    gapSection = '<p style="font-size:12px;color:#666;margin-bottom:12px;">Document analysed: <strong>' +
      (gapTitleEl2 ? escHtml(gapTitleEl2.textContent) : '') + '</strong></p>' +
      '<table><thead><tr><th>Dimension</th><th>Score</th><th>Coverage</th><th>Keywords Found</th></tr></thead>' +
      '<tbody>' + dimRows + '</tbody></table>';
  }

  var today2 = new Date();
  var REGS_RPT = [
    { date:'2025-02-12', label:'EU Data Act \u2014 Entry into Force',    body:'EU 2023/2854',    status:'done' },
    { date:'2026-01-31', label:'GDPR Art. 30 ROPA Annual Update',        body:'CNPD Luxembourg', status:'done' },
    { date:'2026-06-30', label:'CSSF Circular 22/806 Review',            body:'CSSF Luxembourg', status:'upcoming' },
    { date:'2026-07-31', label:'GDPR Annual DPA Self-Assessment',        body:'CNPD Luxembourg', status:'upcoming' },
    { date:'2026-08-02', label:'EU AI Act High-Risk Compliance',         body:'EU 2024/1689',    status:'planned' },
    { date:'2026-09-30', label:'DORA Technical Standards (TLPT)',        body:'CSSF / EBA',      status:'planned' },
    { date:'2027-01-31', label:'GDPR Art. 30 ROPA Next Update',         body:'CNPD Luxembourg', status:'planned' },
  ];
  var SCOL = { done:'#10b981', upcoming:'#f59e0b', planned:'#3b82f6' };
  var SLBL = { done:'Completed', upcoming:'Upcoming', planned:'Planned' };
  var regRows = REGS_RPT.map(function(r) {
    var d   = new Date(r.date);
    var ds  = d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
    var dys = Math.round((d - today2) / 86400000);
    var dStr = r.status === 'done' ? '' : dys > 0 ? '(in ' + dys + 'd)' : '(' + Math.abs(dys) + 'd overdue)';
    return '<tr><td>' + escHtml(r.label) + '</td><td>' + escHtml(r.body) + '</td>' +
      '<td>' + ds + ' <span style="color:' + SCOL[r.status] + ';font-size:10px;">' + dStr + '</span></td>' +
      '<td style="color:' + SCOL[r.status] + ';font-weight:600;font-size:11px;">' + SLBL[r.status] + '</td></tr>';
  }).join('');

  var recMap = {
    'Data Classification':  'Define and enforce a 4-tier classification framework. Assign Data Owners accountable for labelling all assets within 90 days.',
    'Data Retention':       'Formalise retention schedules per GDPR Art. 5(1)(e) and CSSF requirements. Automate deletion workflows for expired personal data.',
    'Data Quality':         'Implement automated daily quality checks. Set a 95% completeness SLA and publish results to a shared Data Quality Dashboard.',
    'Access Control':       'Migrate all access provisioning to the IAM system. Enforce quarterly entitlement reviews and time-limited privileged access.',
    'Data Lineage':         'Deploy a metadata management tool to capture end-to-end lineage for all Tier Confidential assets. Mandate updates within 5 business days of pipeline changes.',
    'Regulatory Compliance':'Maintain a live regulatory obligation register. Schedule the CSSF Circular 22/806 review before 30 June 2026.',
  };
  var dimsForRecs = priorityDims.length > 0 ? priorityDims : labels6.slice(0,3);
  var recItems = dimsForRecs.map(function(dim, i) {
    return '<div style="display:flex;gap:12px;padding:12px;margin-bottom:8px;border-radius:6px;background:#fdf8f6;border-left:3px solid #d4430f;">' +
      '<span style="font-size:10px;font-weight:700;color:#d4430f;text-transform:uppercase;flex-shrink:0;width:26px;padding-top:2px;">P' + (i+1) + '</span>' +
      '<span style="font-size:12px;color:#333;line-height:1.6;"><strong>' + escHtml(dim) + '</strong> \u2014 ' + escHtml(recMap[dim] || 'Review and uplift governance controls for this dimension.') + '</span></div>';
  }).join('');

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>' +
    '<title>Data Governance Status Report \u2014 Nexum Financial S.A. CDO Office</title>' +
    '<style>' +
    '@import url(\'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap\');' +
    '*{box-sizing:border-box;margin:0;padding:0;}' +
    'body{font-family:\'Inter\',Arial,sans-serif;color:#1a1a2e;background:#fff;}' +
    '.cover{background:linear-gradient(135deg,#d4430f 0%,#e87a53 60%,#f0a070 100%);padding:56px;color:#fff;min-height:260px;}' +
    '.cover-org{font-size:12px;font-weight:600;opacity:.8;letter-spacing:.18em;text-transform:uppercase;margin-bottom:10px;}' +
    '.cover-title{font-size:34px;font-weight:800;line-height:1.2;margin-bottom:8px;}' +
    '.cover-sub{font-size:14px;opacity:.85;margin-bottom:36px;}' +
    '.cover-meta{display:flex;flex-wrap:wrap;gap:40px;margin-top:24px;}' +
    '.cm{display:flex;flex-direction:column;gap:3px;}' +
    '.cm-l{font-size:9px;opacity:.7;text-transform:uppercase;letter-spacing:.14em;}' +
    '.cm-v{font-size:13px;font-weight:700;}' +
    '.body{padding:48px 56px;max-width:920px;margin:0 auto;}' +
    'h2{font-size:17px;font-weight:700;color:#1a1a2e;margin:36px 0 12px;padding-bottom:7px;border-bottom:2px solid #d4430f;}' +
    'h2:first-child{margin-top:0;}' +
    'p{font-size:12px;color:#444;line-height:1.7;margin-bottom:10px;}' +
    '.kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px;}' +
    '.kpi{padding:16px;border-radius:8px;border:1px solid #eee;text-align:center;}' +
    '.kpi-v{font-size:26px;font-weight:800;color:#d4430f;}' +
    '.kpi-l{font-size:10px;color:#888;margin-top:3px;}' +
    'table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12px;}' +
    'th{background:#d4430f;color:#fff;padding:8px 12px;text-align:left;font-weight:600;}' +
    'td{padding:7px 12px;border-bottom:1px solid #f0f0f0;}' +
    'tr:nth-child(even) td{background:#fdf8f6;}' +
    '.footer{margin-top:48px;padding-top:14px;border-top:1px solid #eee;font-size:10px;color:#aaa;display:flex;justify-content:space-between;}' +
    '@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}' +
    '</style></head><body>' +
    '<div class="cover">' +
    '<div class="cover-org">Nexum Financial S.A. \u00b7 CDO Office</div>' +
    '<div class="cover-title">Data Governance<br>Status Report</div>' +
    '<div class="cover-sub">AI-Assisted Governance Maturity Assessment \u00b7 GovPal-GovGuard v1</div>' +
    '<div class="cover-meta">' +
    '<div class="cm"><span class="cm-l">Report Date</span><span class="cm-v">' + dateStr + '</span></div>' +
    '<div class="cm"><span class="cm-l">Classification</span><span class="cm-v">CONFIDENTIAL</span></div>' +
    '<div class="cm"><span class="cm-l">Maturity Level</span><span class="cm-v">' + matLevel + ' (' + avgScore + '/5)</span></div>' +
    '<div class="cm"><span class="cm-l">Prepared by</span><span class="cm-v">GovPal-GovGuard</span></div>' +
    '</div></div>' +
    '<div class="body">' +
    '<h2>1. Executive Summary</h2>' +
    '<div class="kpi-row">' +
    '<div class="kpi"><div class="kpi-v">' + avgScore + '</div><div class="kpi-l">Avg Maturity Score (/ 5)</div></div>' +
    '<div class="kpi"><div class="kpi-v">' + priorityDims.length + '</div><div class="kpi-l">Dimensions Below Target</div></div>' +
    '<div class="kpi"><div class="kpi-v">2</div><div class="kpi-l">Upcoming Regulatory Deadlines</div></div>' +
    '</div>' +
    '<p>Nexum Financial S.A.\'s data governance maturity is currently at the <strong>' + matLevel + '</strong> level (average score ' + avgScore + '/5 across six dimensions). ' +
    (priorityDims.length > 0 ? 'Priority focus areas are: <strong>' + priorityDims.join(', ') + '</strong>.' : 'All six dimensions are at or above target maturity.') +
    ' This report was generated on ' + dateStr + ' by the GovPal-GovGuard AI Governance Assistant.</p>' +
    '<h2>2. Governance Maturity by Dimension</h2>' +
    '<table><thead><tr><th>Dimension</th><th>Current</th><th>Target</th><th>Coverage</th><th>Status</th><th>Gap</th></tr></thead><tbody>' + matRows + '</tbody></table>' +
    '<h2>3. Policy Gap Analysis</h2>' + gapSection +
    '<h2>4. Regulatory Calendar 2025\u20132027</h2>' +
    '<table><thead><tr><th>Regulation / Obligation</th><th>Authority</th><th>Deadline</th><th>Status</th></tr></thead><tbody>' + regRows + '</tbody></table>' +
    '<h2>5. Priority Recommendations</h2>' + recItems +
    '<div class="footer">' +
    '<span>GovPal-GovGuard \u00b7 AI Data Governance Assistant \u00b7 Nexum Financial S.A. CDO Office</span>' +
    '<span>Generated: ' + dateStr + ' \u00b7 CONFIDENTIAL \u2014 Not for external distribution</span>' +
    '</div></div></body></html>';

  var win = window.open('', '_blank');
  if (!win) { alert('Please allow pop-ups to generate the report.'); return; }
  win.document.write(html);
  win.document.close();
  setTimeout(function(){ win.print(); }, 700);
}
