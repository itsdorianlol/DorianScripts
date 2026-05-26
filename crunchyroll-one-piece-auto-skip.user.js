// ==UserScript==
// @name         Crunchyroll Auto Skip — Smart
// @namespace    https://github.com/itsdorianlol
// @version      5.0
// @description  Auto-detects and skips intros, recaps, and outros on Crunchyroll using AniSkip + Jikan. Floating GUI button in the top-right corner.
// @author       Dorian
// @match        https://www.crunchyroll.com/*
// @icon         https://www.crunchyroll.com/favicons/favicon-32x32.png
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.jikan.moe
// @connect      api.aniskip.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Settings ────────────────────────────────────────────────────────────────
  function load(k, d) { try { return JSON.parse(GM_getValue(k, JSON.stringify(d))); } catch (e) { return d; } }
  function save(k, v) { GM_setValue(k, JSON.stringify(v)); }

  const cfg = {
    enabled:   load('crs_enabled',   true),
    skipRecap: load('crs_skipRecap', true),
    skipIntro: load('crs_skipIntro', true),
    skipOutro: load('crs_skipOutro', false),
  };
  function saveCfg() { Object.keys(cfg).forEach(k => save('crs_' + k, cfg[k])); }

  // ─── State ────────────────────────────────────────────────────────────────────
  // segments: array of { type: 'recap'|'op'|'ed', startTime, endTime, done }
  // Sorted by startTime so we handle them in order.
  let segments  = [];   // populated after AniSkip lookup
  let malId     = null;
  let lastEp    = null;
  let lastUrl   = '';
  let statusMsg = 'Waiting for episode…';

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const getVid = () => document.querySelector('video');
  const log    = m  => console.log('[CR Skip v5] ' + m);

  function seekTo(s) {
    const v = getVid();
    if (v && isFinite(s)) { v.currentTime = s; log('seeked → ' + s + 's'); }
  }

  function gmGet(url) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload:  r => { try { res(JSON.parse(r.responseText)); } catch (e) { rej(e); } },
        onerror: rej,
      });
    });
  }

  // ─── Read page info ──────────────────────────────────────────────────────────
  function getPageInfo() {
    const info = { title: null, ep: null };

    // 1. JSON-LD
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const arr = [].concat(JSON.parse(el.textContent));
        arr.forEach(item => {
          if (item['@type'] === 'TVEpisode' || item['@type'] === 'Episode') {
            if (item.partOfSeries?.name) info.title = item.partOfSeries.name;
            if (item.episodeNumber)      info.ep    = parseInt(item.episodeNumber, 10);
          }
        });
      } catch (e) {}
    });

    // 2. <title> fallback  e.g. "Episode 5 – One Piece | Crunchyroll"
    if (!info.title || !info.ep) {
      const t  = document.title;
      const em = t.match(/[Ee]pisode\s+(\d+)/);
      const tm = t.match(/–\s*(.+?)\s*\|/);
      if (em) info.ep    = parseInt(em[1], 10);
      if (tm) info.title = tm[1].trim();
    }

    // 3. og:title fallback
    if (!info.title) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og) { const m = og.content.match(/–\s*(.+?)\s*\|/); if (m) info.title = m[1].trim(); }
    }

    return info;
  }

  // ─── Jikan → MAL ID ──────────────────────────────────────────────────────────
  async function fetchMalId(title) {
    try {
      const data = await gmGet('https://api.jikan.moe/v4/anime?q=' + encodeURIComponent(title) + '&limit=5&type=tv');
      if (!data.data?.length) return null;
      const exact = data.data.find(a =>
        a.title?.toLowerCase() === title.toLowerCase() ||
        a.title_english?.toLowerCase() === title.toLowerCase()
      );
      const id = (exact || data.data[0]).mal_id;
      log('MAL ID: ' + id + ' for "' + title + '"');
      return id;
    } catch (e) { log('Jikan err: ' + e); return null; }
  }

  // ─── AniSkip → segments ───────────────────────────────────────────────────────
  async function fetchSegments(mid, ep) {
    try {
      const v      = getVid();
      const epLen  = (v && v.duration && isFinite(v.duration)) ? Math.round(v.duration) : 0;
      const url    = 'https://api.aniskip.com/v2/skip-times/' + mid + '/' + ep
                   + '?types[]=op&types[]=ed&types[]=recap&episodeLength=' + epLen;
      const data   = await gmGet(url);

      if (!data.found || !data.results?.length) {
        log('AniSkip: no results for ep ' + ep);
        return [];
      }

      const segs = data.results.map(r => ({
        type:      r.skipType,          // "op" | "ed" | "recap" | "mixed-op" | "mixed-ed"
        startTime: r.interval.startTime,
        endTime:   r.interval.endTime,
        done:      false,
      }));

      // Sort by startTime so earlier segments are checked first
      segs.sort((a, b) => a.startTime - b.startTime);
      log('Segments: ' + JSON.stringify(segs));
      return segs;
    } catch (e) { log('AniSkip err: ' + e); return []; }
  }

  // ─── Lookup orchestrator ──────────────────────────────────────────────────────
  async function lookup(force) {
    if (!location.pathname.includes('/watch/')) return;

    const { title, ep } = getPageInfo();
    if (!title || !ep) { setStatus('⚠️ Could not read episode info yet'); return; }
    if (!force && ep === lastEp && malId && segments.length) return;

    setStatus('🔍 Looking up "' + title + '" ep ' + ep + '…');

    if (!malId || force) {
      malId = await fetchMalId(title);
      if (!malId) { setStatus('❌ Anime not found on MAL'); return; }
    }

    segments = await fetchSegments(malId, ep);
    lastEp   = ep;

    if (!segments.length) {
      setStatus('⚠️ No AniSkip data for this episode');
    } else {
      const fmt  = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
      const desc = segments.map(s => s.type.toUpperCase() + ' ' + fmt(s.startTime) + '–' + fmt(s.endTime));
      setStatus('✅ ' + desc.join('  |  '));
    }
  }

  // ─── TICK — runs every 300ms ─────────────────────────────────────────────────
  // KEY FIX: We do NOT return early after skipping one segment.
  // We iterate all segments every tick and skip any whose window the playhead is in.
  // We also do NOT reset done flags — once a segment is skipped it stays skipped
  // for this episode. Re-arm button resets them manually.
  function tick() {
    if (!cfg.enabled) return;
    const v = getVid();
    if (!v || isNaN(v.currentTime) || v.paused) return;
    const t = v.currentTime;

    for (const seg of segments) {
      if (seg.done) continue;

      const shouldSkip =
        (seg.type === 'recap'    && cfg.skipRecap) ||
        (seg.type === 'op'       && cfg.skipIntro) ||
        (seg.type === 'mixed-op' && cfg.skipIntro) ||
        (seg.type === 'ed'       && cfg.skipOutro) ||
        (seg.type === 'mixed-ed' && cfg.skipOutro);

      if (!shouldSkip) continue;

      // Inside the window → skip
      if (t >= seg.startTime && t < seg.endTime) {
        seg.done = true;
        log('Skipping ' + seg.type + ' → ' + seg.endTime);
        seekTo(seg.endTime);
        // Don't break — if another segment starts right after, catch it next tick
        return;
      }

      // Passed the window without skipping (user scrubbed past it) → mark done
      if (t >= seg.endTime) {
        seg.done = true;
      }
    }

    // Also click native CR skip buttons if present (some regions/accounts)
    document.querySelectorAll('button').forEach(btn => {
      if (!btn.offsetParent) return;
      const lbl = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (cfg.skipIntro && (lbl === 'skip intro' || lbl === 'skip opening')) btn.click();
      if (cfg.skipRecap &&  lbl === 'skip recap')                            btn.click();
      if (cfg.skipOutro && (lbl === 'skip credits' || lbl === 'skip outro')) btn.click();
    });
  }

  setInterval(tick, 300);

  // ─── SPA nav watcher ─────────────────────────────────────────────────────────
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl  = location.href;
      segments = [];
      lastEp   = null;
      setStatus('New episode — looking up…');
      setTimeout(() => lookup(false), 2500);
      setTimeout(() => lookup(false), 6000);
    }
  }).observe(document, { subtree: true, childList: true });

  // ═══════════════════════════════════════════════════════════════════════════════
  //  GUI — button TOP-RIGHT, panel drops DOWN, panel-close bug FIXED
  // ═══════════════════════════════════════════════════════════════════════════════

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #crs-wrap {
      position: fixed !important;
      top: 16px !important;
      right: 16px !important;
      z-index: 2147483647 !important;
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    #crs-fab {
      width: 44px; height: 44px;
      border-radius: 50%;
      background: #f47521;
      border: none; cursor: pointer;
      box-shadow: 0 3px 14px rgba(244,117,33,.6);
      display: flex; align-items: center; justify-content: center;
      font-size: 19px; color: #fff;
      transition: background .2s, transform .15s;
      user-select: none; flex-shrink: 0;
    }
    #crs-fab:hover { background: #ff8f3a; transform: scale(1.08); }
    #crs-fab.off   { background: #3a3a5c; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
    #crs-panel {
      display: none;
      flex-direction: column;
      margin-top: 8px;
      width: 290px;
      background: #0f0f1a;
      border: 1px solid #252540;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.8);
      color: #fff;
      overflow: hidden;
    }
    #crs-panel.open { display: flex; }
    .crs-head {
      background: #1a1a2e; padding: 10px 13px;
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid #252540;
    }
    .crs-htitle { font-weight: 700; font-size: 13px; color: #f47521; }
    .crs-x {
      background: none; border: none; color: #666;
      cursor: pointer; font-size: 15px; line-height: 1; padding: 0;
    }
    .crs-x:hover { color: #fff; }
    .crs-body { padding: 11px 13px; display: flex; flex-direction: column; gap: 9px; }
    .crs-row  { display: flex; align-items: center; justify-content: space-between; }
    .crs-lbl  { font-size: 13px; }
    .crs-sub  { font-size: 11px; color: #666; margin-top: 1px; }
    .crs-div  { height: 1px; background: #252540; }
    .crs-sec  { font-size: 10px; font-weight: 700; text-transform: uppercase;
                letter-spacing: 1px; color: #555; }
    .crs-tog        { position: relative; width: 34px; height: 19px; flex-shrink: 0; }
    .crs-tog input  { opacity: 0; width: 0; height: 0; }
    .crs-sl {
      position: absolute; inset: 0; border-radius: 19px;
      background: #383858; cursor: pointer; transition: background .2s;
    }
    .crs-sl::before {
      content: ''; position: absolute; left: 3px; top: 3px;
      width: 13px; height: 13px; border-radius: 50%;
      background: #fff; transition: transform .2s;
    }
    .crs-tog input:checked + .crs-sl              { background: #f47521; }
    .crs-tog input:checked + .crs-sl::before      { transform: translateX(15px); }
    .crs-btn {
      background: #f47521; border: none; color: #fff;
      border-radius: 6px; padding: 5px 10px; font-size: 12px;
      cursor: pointer; font-weight: 600; transition: background .2s; flex: 1;
    }
    .crs-btn:hover { background: #ff9040; }
    .crs-btn.sec {
      background: #1a1a2e; border: 1px solid #333355; color: #777; flex: 1;
    }
    .crs-btn.sec:hover { color: #fff; border-color: #f47521; }
    .crs-foot {
      background: #1a1a2e; padding: 7px 13px;
      border-top: 1px solid #252540;
      font-size: 11px; color: #666;
      display: flex; align-items: flex-start; gap: 6px;
    }
    .crs-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
    .crs-dot.on  { background: #4caf50; }
    .crs-dot.off { background: #f44336; }
  `;
  document.head.appendChild(styleEl);

  // Wrapper
  const wrap = document.createElement('div');
  wrap.id = 'crs-wrap';

  // FAB
  const fab = document.createElement('button');
  fab.id = 'crs-fab';
  fab.title = 'CR Smart-Skip';
  fab.textContent = '⏭';
  if (!cfg.enabled) fab.classList.add('off');
  wrap.appendChild(fab);

  // Panel
  const panel = document.createElement('div');
  panel.id = 'crs-panel';
  panel.innerHTML = `
    <div class="crs-head">
      <span class="crs-htitle">⏭ CR Smart-Skip</span>
      <button class="crs-x" id="crs-x">✕</button>
    </div>
    <div class="crs-body">
      <div class="crs-row">
        <div>
          <div class="crs-lbl">Auto-Skip Enabled</div>
          <div class="crs-sub">Master switch</div>
        </div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-cb-enabled" ${cfg.enabled ? 'checked' : ''}>
          <span class="crs-sl"></span>
        </label>
      </div>
      <div class="crs-div"></div>
      <div class="crs-sec">What to skip</div>
      <div class="crs-row">
        <div class="crs-lbl">Skip Recap</div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-cb-recap" ${cfg.skipRecap ? 'checked' : ''}>
          <span class="crs-sl"></span>
        </label>
      </div>
      <div class="crs-row">
        <div class="crs-lbl">Skip Opening / Intro</div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-cb-intro" ${cfg.skipIntro ? 'checked' : ''}>
          <span class="crs-sl"></span>
        </label>
      </div>
      <div class="crs-row">
        <div class="crs-lbl">Skip Credits / Outro</div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-cb-outro" ${cfg.skipOutro ? 'checked' : ''}>
          <span class="crs-sl"></span>
        </label>
      </div>
      <div class="crs-div"></div>
      <div class="crs-row" style="gap:7px">
        <button class="crs-btn"     id="crs-btn-redetect">🔄 Re-detect</button>
        <button class="crs-btn sec" id="crs-btn-rearm">↩ Re-arm</button>
      </div>
    </div>
    <div class="crs-foot">
      <span class="crs-dot ${cfg.enabled ? 'on' : 'off'}" id="crs-dot"></span>
      <span id="crs-stxt">Initialising…</span>
    </div>
  `;
  wrap.appendChild(panel);
  document.body.appendChild(wrap);

  // ─── Status updater ───────────────────────────────────────────────────────────
  function setStatus(msg) {
    statusMsg = msg;
    const dot = document.getElementById('crs-dot');
    const txt = document.getElementById('crs-stxt');
    if (dot) dot.className = 'crs-dot ' + (cfg.enabled ? 'on' : 'off');
    if (txt) txt.textContent = msg;
    fab.classList.toggle('off', !cfg.enabled);
    fab.textContent = cfg.enabled ? '⏭' : '⏸';
  }

  // ─── Panel open/close — FIX: use stopPropagation on FAB click ────────────────
  let panelOpen = false;

  fab.addEventListener('click', e => {
    e.stopPropagation();           // prevent document listener from firing
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
  });

  document.getElementById('crs-x').addEventListener('click', e => {
    e.stopPropagation();
    panelOpen = false;
    panel.classList.remove('open');
  });

  // Close when clicking outside the whole wrap
  document.addEventListener('click', e => {
    if (panelOpen && !wrap.contains(e.target)) {
      panelOpen = false;
      panel.classList.remove('open');
    }
  });

  // ─── Toggle bindings ──────────────────────────────────────────────────────────
  function tog(id, key, cb) {
    document.getElementById(id).addEventListener('change', function () {
      cfg[key] = this.checked;
      saveCfg();
      setStatus(statusMsg);
      if (cb) cb();
    });
  }

  tog('crs-cb-enabled', 'enabled', () => {
    if (cfg.enabled && !segments.length) lookup(false);
  });
  tog('crs-cb-recap', 'skipRecap');
  tog('crs-cb-intro', 'skipIntro');
  tog('crs-cb-outro', 'skipOutro');

  document.getElementById('crs-btn-redetect').addEventListener('click', e => {
    e.stopPropagation();
    segments = []; lastEp = null; malId = null;
    setStatus('🔍 Re-detecting…');
    lookup(true);
  });

  document.getElementById('crs-btn-rearm').addEventListener('click', e => {
    e.stopPropagation();
    segments.forEach(s => s.done = false);
    setStatus('↩ Re-armed — will skip again');
  });

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  setStatus(statusMsg);
  if (location.pathname.includes('/watch/')) {
    setTimeout(() => lookup(false), 2500);
    setTimeout(() => lookup(false), 6000);
  } else {
    setStatus('Open a CR episode to activate');
  }

  log('v5 loaded ✅');
})();
