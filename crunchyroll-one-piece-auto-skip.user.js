// ==UserScript==
// @name         Crunchyroll Auto Skip — GUI
// @namespace    https://github.com/itsdorianlol
// @version      2.0
// @description  Auto-skips intros, recaps, and outros on Crunchyroll. No skip button needed — seeks the video directly. Includes a floating GUI panel to control all settings.
// @author       Dorian
// @match        https://www.crunchyroll.com/*
// @icon         https://www.crunchyroll.com/favicons/favicon-32x32.png
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Default Settings ────────────────────────────────────────────────────────
  const DEFAULTS = {
    enabled:       true,
    skipIntro:     true,
    skipRecap:     true,
    skipOutro:     false,
    introStart:    0,    // seconds — when the intro begins
    introEnd:      90,   // seconds — seek to here to skip intro (≈ 1 min 30 s)
    recapStart:    0,    // seconds — when recap plays (usually before intro)
    recapEnd:      60,   // seconds — seek past recap
    outroStart:    1380, // seconds — when credits start (23 min)
    outroEnd:      1440, // seconds — seek to here (or next ep)
    showOnAnyPage: true, // show GUI button on all CR pages, not just video pages
  };

  // ─── Load / Save settings via GM storage ─────────────────────────────────────
  function load(key)       { try { return JSON.parse(GM_getValue(key, JSON.stringify(DEFAULTS[key]))); } catch(e) { return DEFAULTS[key]; } }
  function save(key, val)  { GM_setValue(key, JSON.stringify(val)); }

  const cfg = {};
  Object.keys(DEFAULTS).forEach(k => { cfg[k] = load(k); });

  function saveCfg() { Object.keys(cfg).forEach(k => save(k, cfg[k])); }

  // ─── Video helpers ────────────────────────────────────────────────────────────
  function getVideo() {
    return document.querySelector('video');
  }

  function seekTo(seconds) {
    const v = getVideo();
    if (v && isFinite(seconds)) {
      v.currentTime = seconds;
      console.log(`[CR Skip] Seeked to ${seconds}s`);
    }
  }

  // ─── Skip logic (runs every 500 ms) ──────────────────────────────────────────
  // Since CR doesn't always show skip buttons, we watch the video time and
  // jump over the known intro / recap / outro windows.
  // We also still click any CR skip buttons that do appear (some regions get them).

  let skippedIntro  = false;
  let skippedRecap  = false;
  let skippedOutro  = false;
  let lastVideoSrc  = '';

  function resetSkipFlags() {
    skippedIntro = false;
    skippedRecap = false;
    skippedOutro = false;
  }

  // Attempt to click CR's native skip buttons (some users/regions see them)
  const NATIVE_SELECTORS = [
    '[data-testid="skipIntroBtn"]',
    '[data-testid="skipRecapBtn"]',
    '[data-testid="skipCreditsBtn"]',
    '[data-testid="vilos-skip_intro_button"]',
    '.skip-btn', '.skipButton', 'button.player-skip-button',
  ];

  function clickNativeButtons() {
    for (const sel of NATIVE_SELECTORS) {
      document.querySelectorAll(sel).forEach(btn => {
        if (btn.offsetParent !== null) {
          const lbl = (btn.innerText || btn.textContent || '').toLowerCase();
          if (cfg.skipIntro && (lbl.includes('intro') || lbl.includes('opening'))) { btn.click(); }
          if (cfg.skipRecap && lbl.includes('recap'))  { btn.click(); }
          if (cfg.skipOutro && (lbl.includes('credit') || lbl.includes('outro') || lbl.includes('ending'))) { btn.click(); }
        }
      });
    }
    // Fallback: all buttons
    document.querySelectorAll('button').forEach(btn => {
      if (btn.offsetParent === null) return;
      const lbl = (btn.innerText || btn.textContent || '').toLowerCase();
      if (cfg.skipIntro && (lbl.includes('skip intro') || lbl.includes('skip opening'))) btn.click();
      if (cfg.skipRecap && lbl.includes('skip recap'))   btn.click();
      if (cfg.skipOutro && (lbl.includes('skip credits') || lbl.includes('skip outro') || lbl.includes('skip ending'))) btn.click();
    });
  }

  function tick() {
    if (!cfg.enabled) return;

    const v = getVideo();
    if (!v) return;

    // Reset flags when a new video starts
    if (v.src !== lastVideoSrc) {
      lastVideoSrc = v.src;
      resetSkipFlags();
    }

    const t = v.currentTime;

    // Try native buttons first
    clickNativeButtons();

    // Time-based seeking fallback
    if (cfg.skipRecap && !skippedRecap && t >= cfg.recapStart && t < cfg.recapEnd) {
      skippedRecap = true;
      seekTo(cfg.recapEnd);
    }
    if (cfg.skipIntro && !skippedIntro && t >= cfg.introStart && t < cfg.introEnd) {
      skippedIntro = true;
      seekTo(cfg.introEnd);
    }
    if (cfg.skipOutro && !skippedOutro && t >= cfg.outroStart && t < cfg.outroEnd) {
      skippedOutro = true;
      seekTo(cfg.outroEnd);
    }
  }

  setInterval(tick, 500);

  // ─── SPA re-arm ───────────────────────────────────────────────────────────────
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      resetSkipFlags();
    }
  }).observe(document, { subtree: true, childList: true });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── GUI ──────────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════

  const COLORS = {
    bg:       '#1a1a2e',
    surface:  '#16213e',
    accent:   '#f47521',   // CR orange
    accentHover: '#ff8c3a',
    text:     '#ffffff',
    subtext:  '#a0a0b0',
    border:   '#2a2a4a',
    green:    '#4caf50',
    red:      '#f44336',
    toggle_on:  '#f47521',
    toggle_off: '#444466',
  };

  const style = document.createElement('style');
  style.textContent = `
    #cr-skip-fab {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 2147483647;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: ${COLORS.accent};
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(244,117,33,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, background 0.2s, box-shadow 0.2s;
      font-size: 22px;
      color: #fff;
      user-select: none;
    }
    #cr-skip-fab:hover {
      background: ${COLORS.accentHover};
      transform: scale(1.1);
      box-shadow: 0 6px 28px rgba(244,117,33,0.7);
    }
    #cr-skip-fab.off {
      background: #444466;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    #cr-skip-panel {
      position: fixed;
      bottom: 92px;
      right: 28px;
      z-index: 2147483646;
      width: 310px;
      background: ${COLORS.bg};
      border: 1px solid ${COLORS.border};
      border-radius: 14px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.7);
      color: ${COLORS.text};
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
      overflow: hidden;
      display: none;
      flex-direction: column;
    }
    #cr-skip-panel.open { display: flex; }
    .cr-panel-header {
      background: ${COLORS.surface};
      padding: 14px 16px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid ${COLORS.border};
    }
    .cr-panel-header-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 14px;
      color: ${COLORS.accent};
      letter-spacing: 0.3px;
    }
    .cr-panel-header-title span.logo { font-size: 18px; }
    .cr-close-btn {
      background: none;
      border: none;
      color: ${COLORS.subtext};
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0;
      transition: color 0.15s;
    }
    .cr-close-btn:hover { color: ${COLORS.text}; }
    .cr-panel-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .cr-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .cr-row-label {
      font-size: 13px;
      color: ${COLORS.text};
      font-weight: 500;
    }
    .cr-row-sub {
      font-size: 11px;
      color: ${COLORS.subtext};
      margin-top: 1px;
    }
    .cr-toggle {
      position: relative;
      width: 40px;
      height: 22px;
      flex-shrink: 0;
    }
    .cr-toggle input { opacity: 0; width: 0; height: 0; }
    .cr-toggle-slider {
      position: absolute;
      inset: 0;
      border-radius: 22px;
      background: ${COLORS.toggle_off};
      cursor: pointer;
      transition: background 0.2s;
    }
    .cr-toggle-slider::before {
      content: '';
      position: absolute;
      left: 3px; top: 3px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: white;
      transition: transform 0.2s;
    }
    .cr-toggle input:checked + .cr-toggle-slider { background: ${COLORS.toggle_on}; }
    .cr-toggle input:checked + .cr-toggle-slider::before { transform: translateX(18px); }
    .cr-divider {
      height: 1px;
      background: ${COLORS.border};
      margin: 2px 0;
    }
    .cr-section-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: ${COLORS.subtext};
      margin-bottom: 2px;
    }
    .cr-time-row {
      display: flex;
      align-items: center;
      gap: 6px;
      justify-content: space-between;
    }
    .cr-time-label {
      font-size: 12px;
      color: ${COLORS.subtext};
      min-width: 90px;
    }
    .cr-time-input {
      background: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      border-radius: 6px;
      color: ${COLORS.text};
      font-size: 12px;
      padding: 4px 8px;
      width: 68px;
      text-align: center;
      outline: none;
      transition: border-color 0.15s;
    }
    .cr-time-input:focus { border-color: ${COLORS.accent}; }
    .cr-status-bar {
      background: ${COLORS.surface};
      padding: 8px 16px;
      border-top: 1px solid ${COLORS.border};
      font-size: 11px;
      color: ${COLORS.subtext};
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cr-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .cr-dot.on  { background: ${COLORS.green}; }
    .cr-dot.off { background: ${COLORS.red}; }
    .cr-group { display: flex; flex-direction: column; gap: 8px; }
    .cr-collapse { display: flex; flex-direction: column; gap: 8px; }
    .cr-collapse.hidden { display: none; }
    .cr-expand-btn {
      background: none;
      border: none;
      color: ${COLORS.accent};
      font-size: 11px;
      cursor: pointer;
      padding: 0;
      text-align: left;
      text-decoration: underline;
    }
  `;
  document.head.appendChild(style);

  // ─── FAB (floating circle button) ────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'cr-skip-fab';
  fab.title = 'CR Auto-Skip Settings';
  fab.innerHTML = '⏭';
  if (!cfg.enabled) fab.classList.add('off');
  document.body.appendChild(fab);

  // ─── Panel ────────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'cr-skip-panel';
  panel.innerHTML = `
    <div class="cr-panel-header">
      <div class="cr-panel-header-title">
        <span class="logo">⏭</span> CR Auto-Skip
      </div>
      <button class="cr-close-btn" id="cr-close">✕</button>
    </div>
    <div class="cr-panel-body">

      <!-- Master toggle -->
      <div class="cr-row">
        <div>
          <div class="cr-row-label">Auto-Skip Enabled</div>
          <div class="cr-row-sub">Master on/off switch</div>
        </div>
        <label class="cr-toggle">
          <input type="checkbox" id="cr-tog-enabled" ${cfg.enabled ? 'checked' : ''}>
          <span class="cr-toggle-slider"></span>
        </label>
      </div>

      <div class="cr-divider"></div>

      <!-- Skip toggles -->
      <div class="cr-section-title">What to skip</div>
      <div class="cr-group">
        <div class="cr-row">
          <div class="cr-row-label">Skip Recap</div>
          <label class="cr-toggle">
            <input type="checkbox" id="cr-tog-recap" ${cfg.skipRecap ? 'checked' : ''}>
            <span class="cr-toggle-slider"></span>
          </label>
        </div>
        <div class="cr-row">
          <div class="cr-row-label">Skip Opening / Intro</div>
          <label class="cr-toggle">
            <input type="checkbox" id="cr-tog-intro" ${cfg.skipIntro ? 'checked' : ''}>
            <span class="cr-toggle-slider"></span>
          </label>
        </div>
        <div class="cr-row">
          <div class="cr-row-label">Skip Credits / Outro</div>
          <label class="cr-toggle">
            <input type="checkbox" id="cr-tog-outro" ${cfg.skipOutro ? 'checked' : ''}>
            <span class="cr-toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="cr-divider"></div>

      <!-- Time settings -->
      <div class="cr-section-title">Skip times (seconds)</div>
      <button class="cr-expand-btn" id="cr-expand-btn">▶ Show / hide time settings</button>
      <div class="cr-collapse hidden" id="cr-collapse">
        <div class="cr-group">
          <div class="cr-section-title" style="margin-top:4px">Recap window</div>
          <div class="cr-time-row">
            <span class="cr-time-label">Start at (s)</span>
            <input class="cr-time-input" id="cr-recap-start" type="number" min="0" value="${cfg.recapStart}">
          </div>
          <div class="cr-time-row">
            <span class="cr-time-label">Seek to (s)</span>
            <input class="cr-time-input" id="cr-recap-end" type="number" min="0" value="${cfg.recapEnd}">
          </div>

          <div class="cr-section-title" style="margin-top:4px">Intro / Opening window</div>
          <div class="cr-time-row">
            <span class="cr-time-label">Start at (s)</span>
            <input class="cr-time-input" id="cr-intro-start" type="number" min="0" value="${cfg.introStart}">
          </div>
          <div class="cr-time-row">
            <span class="cr-time-label">Seek to (s)</span>
            <input class="cr-time-input" id="cr-intro-end" type="number" min="0" value="${cfg.introEnd}">
          </div>

          <div class="cr-section-title" style="margin-top:4px">Credits / Outro window</div>
          <div class="cr-time-row">
            <span class="cr-time-label">Start at (s)</span>
            <input class="cr-time-input" id="cr-outro-start" type="number" min="0" value="${cfg.outroStart}">
          </div>
          <div class="cr-time-row">
            <span class="cr-time-label">Seek to (s)</span>
            <input class="cr-time-input" id="cr-outro-end" type="number" min="0" value="${cfg.outroEnd}">
          </div>
        </div>
      </div>

    </div>
    <div class="cr-status-bar">
      <span class="cr-dot ${cfg.enabled ? 'on' : 'off'}" id="cr-status-dot"></span>
      <span id="cr-status-text">${cfg.enabled ? 'Active — watching for skips' : 'Disabled'}</span>
    </div>
  `;
  document.body.appendChild(panel);

  // ─── GUI interactions ─────────────────────────────────────────────────────────

  // Open / close panel
  fab.addEventListener('click', () => {
    panel.classList.toggle('open');
  });
  document.getElementById('cr-close').addEventListener('click', () => {
    panel.classList.remove('open');
  });
  // Close panel if clicking outside
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== fab) {
      panel.classList.remove('open');
    }
  });

  // Expand / collapse time settings
  document.getElementById('cr-expand-btn').addEventListener('click', () => {
    const col = document.getElementById('cr-collapse');
    const btn = document.getElementById('cr-expand-btn');
    col.classList.toggle('hidden');
    btn.textContent = col.classList.contains('hidden')
      ? '▶ Show / hide time settings'
      : '▼ Hide time settings';
  });

  function updateStatus() {
    const dot  = document.getElementById('cr-status-dot');
    const txt  = document.getElementById('cr-status-text');
    dot.className = 'cr-dot ' + (cfg.enabled ? 'on' : 'off');
    txt.textContent = cfg.enabled ? 'Active — watching for skips' : 'Disabled';
    fab.classList.toggle('off', !cfg.enabled);
    fab.innerHTML = cfg.enabled ? '⏭' : '⏸';
  }

  function bindToggle(id, key, cb) {
    document.getElementById(id).addEventListener('change', function () {
      cfg[key] = this.checked;
      saveCfg();
      if (cb) cb();
    });
  }

  function bindNumber(id, key) {
    document.getElementById(id).addEventListener('change', function () {
      const v = parseFloat(this.value);
      if (!isNaN(v) && v >= 0) { cfg[key] = v; saveCfg(); }
    });
  }

  bindToggle('cr-tog-enabled', 'enabled', () => { updateStatus(); resetSkipFlags(); });
  bindToggle('cr-tog-recap',   'skipRecap',  () => resetSkipFlags());
  bindToggle('cr-tog-intro',   'skipIntro',  () => resetSkipFlags());
  bindToggle('cr-tog-outro',   'skipOutro',  () => resetSkipFlags());

  bindNumber('cr-recap-start',  'recapStart');
  bindNumber('cr-recap-end',    'recapEnd');
  bindNumber('cr-intro-start',  'introStart');
  bindNumber('cr-intro-end',    'introEnd');
  bindNumber('cr-outro-start',  'outroStart');
  bindNumber('cr-outro-end',    'outroEnd');

  updateStatus();

  console.log('[CR Auto-Skip v2] Loaded ✅  — click the ⏭ circle to open settings');
})();
