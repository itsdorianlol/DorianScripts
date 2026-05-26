// ==UserScript==
// @name         Crunchyroll Auto Skip — Smart
// @namespace    https://github.com/itsdorianlol
// @version      4.0
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

  // ─── Settings (saved across sessions) ────────────────────────────────────────
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
  let times     = null;   // { op, recap, ed } — each null or { startTime, endTime }
  let malId     = null;
  let lastEp    = null;
  let lastUrl   = '';
  let done      = { op: false, recap: false, ed: false };
  let statusMsg = 'Waiting for episode…';

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  const vid = () => document.querySelector('video');
  const log = m => console.log('[CR Skip] ' + m);

  function seekTo(s) {
    const v = vid();
    if (v && isFinite(s)) { v.currentTime = s; log('seeked to ' + s + 's'); }
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

  // ─── Read series title + episode number from the page ────────────────────────
  function getPageInfo() {
    const info = { title: null, ep: null };

    // 1. JSON-LD structured data (most reliable)
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const d   = JSON.parse(el.textContent);
        const arr = Array.isArray(d) ? d : [d];
        arr.forEach(item => {
          if (item['@type'] === 'TVEpisode' || item['@type'] === 'Episode') {
            if (item.partOfSeries?.name) info.title = item.partOfSeries.name;
            if (item.episodeNumber)      info.ep    = parseInt(item.episodeNumber, 10);
          }
        });
      } catch (e) {}
    });

    // 2. Page <title> fallback — e.g. "Episode 5 – One Piece | Crunchyroll"
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
      if (og) {
        const m = og.content.match(/–\s*(.+?)\s*\|/);
        if (m) info.title = m[1].trim();
      }
    }

    return info;
  }

  // ─── Step 1: MAL ID via Jikan ─────────────────────────────────────────────────
  async function fetchMalId(title) {
    try {
      const data = await gmGet('https://api.jikan.moe/v4/anime?q=' + encodeURIComponent(title) + '&limit=5&type=tv');
      if (!data.data?.length) return null;
      const exact = data.data.find(a =>
        a.title?.toLowerCase()         === title.toLowerCase() ||
        a.title_english?.toLowerCase() === title.toLowerCase()
      );
      const id = (exact || data.data[0]).mal_id;
      log('MAL ID for "' + title + '": ' + id);
      return id;
    } catch (e) { log('Jikan error: ' + e); return null; }
  }

  // ─── Step 2: Skip timestamps via AniSkip ──────────────────────────────────────
  async function fetchTimes(mid, ep) {
    try {
      const v      = vid();
      const epLen  = v ? Math.round(v.duration) || 0 : 0;
      const url    = `https://api.aniskip.com/v2/skip-times/${mid}/${ep}?types[]=op&types[]=ed&types[]=recap&episodeLength=${epLen}`;
      const data   = await gmGet(url);

      if (!data.found) { log('AniSkip: no data for ep ' + ep); return null; }

      const out = { op: null, recap: null, ed: null };
      (data.results || []).forEach(r => {
        // AniSkip type strings: "op", "ed", "recap", "mixed-ed", "mixed-op"
        const t = r.skipType;
        if      (t === 'op'    || t === 'mixed-op') out.op    = r.interval;
        else if (t === 'ed'    || t === 'mixed-ed') out.ed    = r.interval;
        else if (t === 'recap'                     ) out.recap = r.interval;
      });

      log('AniSkip result: ' + JSON.stringify(out));
      return out;
    } catch (e) { log('AniSkip error: ' + e); return null; }
  }

  // ─── Lookup orchestrator ──────────────────────────────────────────────────────
  async function lookup(force) {
    if (!location.pathname.includes('/watch/')) return;

    const { title, ep } = getPageInfo();
    if (!title || !ep) {
      setStatus('⚠️ Could not read episode info yet');
      return;
    }

    if (!force && ep === lastEp && malId) return;  // already have data

    setStatus(`🔍 Looking up "${title}" ep ${ep}…`);

    if (!malId || force) {
      malId = await fetchMalId(title);
      if (!malId) { setStatus('❌ Anime not found on MAL'); return; }
    }

    times  = await fetchTimes(malId, ep);
    lastEp = ep;
    done   = { op: false, recap: false, ed: false };

    if (!times) {
      setStatus('⚠️ No AniSkip data for this episode');
    } else {
      const fmt = s => { const m = Math.floor(s / 60); const sec = Math.round(s % 60); return m + ':' + String(sec).padStart(2, '0'); };
      const parts = [];
      if (times.recap) parts.push('Recap ' + fmt(times.recap.startTime) + '–' + fmt(times.recap.endTime));
      if (times.op)    parts.push('OP '    + fmt(times.op.startTime)    + '–' + fmt(times.op.endTime));
      if (times.ed)    parts.push('ED '    + fmt(times.ed.startTime)    + '–' + fmt(times.ed.endTime));
      setStatus(parts.length ? '✅ ' + parts.join('  |  ') : '⚠️ No segments found');
    }
  }

  // ─── Tick — runs every 500ms, does the actual skipping ───────────────────────
  function tick() {
    if (!cfg.enabled) return;

    const v = vid();
    if (!v || isNaN(v.currentTime)) return;
    const t = v.currentTime;

    if (times) {
      if (cfg.skipRecap && times.recap && !done.recap) {
        if (t >= times.recap.startTime && t < times.recap.endTime) {
          done.recap = true;
          seekTo(times.recap.endTime);
          return;
        }
      }
      if (cfg.skipIntro && times.op && !done.op) {
        if (t >= times.op.startTime && t < times.op.endTime) {
          done.op = true;
          seekTo(times.op.endTime);
          return;
        }
      }
      if (cfg.skipOutro && times.ed && !done.ed) {
        if (t >= times.ed.startTime && t < times.ed.endTime) {
          done.ed = true;
          seekTo(times.ed.endTime);
          return;
        }
      }
    }

    // Also click native CR skip buttons if they appear (some regions/accounts get them)
    document.querySelectorAll('button').forEach(btn => {
      if (!btn.offsetParent) return;
      const lbl = (btn.innerText || '').toLowerCase();
      if (cfg.skipIntro && (lbl === 'skip intro' || lbl === 'skip opening')) btn.click();
      if (cfg.skipRecap &&  lbl === 'skip recap')                            btn.click();
      if (cfg.skipOutro && (lbl === 'skip credits' || lbl === 'skip outro')) btn.click();
    });
  }

  setInterval(tick, 500);

  // ─── SPA navigation ───────────────────────────────────────────────────────────
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      times   = null;
      done    = { op: false, recap: false, ed: false };
      lastEp  = null;
      setStatus('New episode — looking up…');
      setTimeout(() => lookup(false), 2500);
      setTimeout(() => lookup(false), 6000);
    }
  }).observe(document, { subtree: true, childList: true });

  // ═══════════════════════════════════════════════════════════════════════════════
  //  GUI — button TOP-RIGHT, panel drops DOWN from it
  // ═══════════════════════════════════════════════════════════════════════════════

  const CSS = `
    #crs-wrap {
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 2147483647;
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
    }
    #crs-fab {
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: #f47521;
      border: none;
      cursor: pointer;
      box-shadow: 0 3px 14px rgba(244,117,33,.6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #fff;
      transition: background .2s, transform .15s;
      user-select: none;
      margin-left: auto;
    }
    #crs-fab:hover  { background: #ff8f3a; transform: scale(1.08); }
    #crs-fab.off    { background: #3a3a5c; box-shadow: 0 3px 10px rgba(0,0,0,.4); }
    #crs-panel {
      display: none;
      flex-direction: column;
      margin-top: 10px;
      width: 300px;
      background: #0f0f1a;
      border: 1px solid #252540;
      border-radius: 12px;
      box-shadow: 0 8px 36px rgba(0,0,0,.75);
      color: #fff;
      overflow: hidden;
    }
    #crs-panel.open { display: flex; }
    .crs-head {
      background: #1a1a2e;
      padding: 11px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #252540;
    }
    .crs-head-title { font-weight: 700; font-size: 13px; color: #f47521; }
    .crs-x {
      background: none; border: none; color: #888; cursor: pointer;
      font-size: 16px; line-height: 1; padding: 0;
    }
    .crs-x:hover { color: #fff; }
    .crs-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .crs-row  { display: flex; align-items: center; justify-content: space-between; }
    .crs-lbl  { font-size: 13px; }
    .crs-sub  { font-size: 11px; color: #888; margin-top: 1px; }
    .crs-div  { height: 1px; background: #252540; }
    .crs-sec  { font-size: 10px; font-weight: 700; text-transform: uppercase;
                letter-spacing: 1px; color: #666; }
    /* toggle switch */
    .crs-tog        { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
    .crs-tog input  { opacity: 0; width: 0; height: 0; }
    .crs-sl {
      position: absolute; inset: 0; border-radius: 20px;
      background: #383858; cursor: pointer; transition: background .2s;
    }
    .crs-sl::before {
      content: ''; position: absolute; left: 3px; top: 3px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #fff; transition: transform .2s;
    }
    .crs-tog input:checked + .crs-sl              { background: #f47521; }
    .crs-tog input:checked + .crs-sl::before      { transform: translateX(16px); }
    /* buttons */
    .crs-btn {
      background: #f47521; border: none; color: #fff;
      border-radius: 6px; padding: 5px 11px; font-size: 12px;
      cursor: pointer; font-weight: 600; transition: background .2s;
    }
    .crs-btn:hover { background: #ff9040; }
    .crs-btn.sec {
      background: #1a1a2e; border: 1px solid #333355; color: #888;
    }
    .crs-btn.sec:hover { color: #fff; border-color: #f47521; }
    /* status bar */
    .crs-foot {
      background: #1a1a2e; padding: 8px 14px;
      border-top: 1px solid #252540;
      font-size: 11px; color: #777;
      display: flex; align-items: flex-start; gap: 6px;
    }
    .crs-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
    .crs-dot.on  { background: #4caf50; }
    .crs-dot.off { background: #f44336; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // Wrapper div (positions everything)
  const wrap = document.createElement('div');
  wrap.id = 'crs-wrap';

  // FAB circle button
  const fab = document.createElement('button');
  fab.id = 'crs-fab';
  fab.title = 'CR Smart-Skip';
  fab.textContent = '⏭';
  if (!cfg.enabled) fab.classList.add('off');
  wrap.appendChild(fab);

  // Panel (drops below fab)
  const panel = document.createElement('div');
  panel.id = 'crs-panel';
  panel.innerHTML = `
    <div class="crs-head">
      <span class="crs-head-title">⏭ CR Smart-Skip</span>
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
      <div class="crs-row" style="gap:8px">
        <button class="crs-btn"     id="crs-btn-redetect">🔄 Re-detect</button>
        <button class="crs-btn sec" id="crs-btn-rearm"   >↩ Re-arm</button>
      </div>
    </div>
    <div class="crs-foot">
      <span class="crs-dot ${cfg.enabled ? 'on' : 'off'}" id="crs-dot"></span>
      <span id="crs-stxt">Initialising…</span>
    </div>
  `;
  wrap.appendChild(panel);
  document.body.appendChild(wrap);

  // ─── UI helpers ───────────────────────────────────────────────────────────────
  function setStatus(msg) {
    statusMsg = msg;
    const dot = document.getElementById('crs-dot');
    const txt = document.getElementById('crs-stxt');
    if (dot) dot.className = 'crs-dot ' + (cfg.enabled ? 'on' : 'off');
    if (txt) txt.textContent = msg;
    fab.classList.toggle('off', !cfg.enabled);
    fab.textContent = cfg.enabled ? '⏭' : '⏸';
  }

  fab.addEventListener('click', e => { e.stopPropagation(); panel.classList.toggle('open'); });
  document.getElementById('crs-x').addEventListener('click', () => panel.classList.remove('open'));
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) panel.classList.remove('open');
  });

  function tog(id, key, cb) {
    document.getElementById(id).addEventListener('change', function () {
      cfg[key] = this.checked;
      saveCfg();
      setStatus(statusMsg); // refresh dot colour
      if (cb) cb();
    });
  }

  tog('crs-cb-enabled', 'enabled', () => {
    done = { op: false, recap: false, ed: false };
    if (cfg.enabled && !times) lookup(false);
  });
  tog('crs-cb-recap', 'skipRecap');
  tog('crs-cb-intro', 'skipIntro');
  tog('crs-cb-outro', 'skipOutro');

  document.getElementById('crs-btn-redetect').addEventListener('click', () => {
    times = null; lastEp = null; malId = null;
    setStatus('🔍 Re-detecting…');
    lookup(true);
  });
  document.getElementById('crs-btn-rearm').addEventListener('click', () => {
    done = { op: false, recap: false, ed: false };
    setStatus('↩ Re-armed');
  });

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  setStatus(statusMsg);
  if (location.pathname.includes('/watch/')) {
    setTimeout(() => lookup(false), 2500);
    setTimeout(() => lookup(false), 6000);
  } else {
    setStatus('Open a CR episode to activate');
  }

  log('v4 loaded ✅');
})();
