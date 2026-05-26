// ==UserScript==
// @name         Crunchyroll Auto Skip — Smart (AniSkip)
// @namespace    https://github.com/itsdorianlol
// @version      3.0
// @description  Auto-detects exact intro/recap/outro timestamps from AniSkip + Jikan APIs. No manual config needed. Floating GUI to control everything.
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

  // ─── Saved prefs ─────────────────────────────────────────────────────────────
  function load(k, d) { try { return JSON.parse(GM_getValue(k, JSON.stringify(d))); } catch(e) { return d; } }
  function save(k, v) { GM_setValue(k, JSON.stringify(v)); }

  const cfg = {
    enabled:    load('enabled', true),
    skipIntro:  load('skipIntro', true),
    skipRecap:  load('skipRecap', true),
    skipOutro:  load('skipOutro', false),
  };
  function saveCfg() { Object.keys(cfg).forEach(k => save(k, cfg[k])); }


  // ─── State ────────────────────────────────────────────────────────────────────
  let skipTimes   = null;   // { op, ed, recap } each = { startTime, endTime } | null
  let lastMalId   = null;
  let lastEpNum   = null;
  let lastUrl     = '';
  let skipped     = { op: false, ed: false, recap: false };
  let statusMsg   = 'Waiting for episode…';

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function getVideo() { return document.querySelector('video'); }

  function seekTo(s) {
    const v = getVideo();
    if (v && isFinite(s)) { v.currentTime = s; log(`Seeked to ${s}s`); }
  }

  function log(msg) { console.log(`[CR Smart-Skip] ${msg}`); }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload:  r => { try { resolve(JSON.parse(r.responseText)); } catch(e) { reject(e); } },
        onerror: reject,
      });
    });
  }


  // ─── Parse episode info from Crunchyroll URL + page ──────────────────────────
  // CR URLs look like: /watch/GXXXXXX/episode-title
  // The episode number and series title live in the page <title> and JSON-LD
  function parsePageInfo() {
    const info = { seriesTitle: null, episodeNum: null };

    // Try JSON-LD first (most reliable)
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const d = JSON.parse(el.textContent);
        const arr = Array.isArray(d) ? d : [d];
        arr.forEach(item => {
          if (item['@type'] === 'TVEpisode' || item['@type'] === 'Episode') {
            if (item.partOfSeries?.name) info.seriesTitle = item.partOfSeries.name;
            if (item.episodeNumber)      info.episodeNum  = parseInt(item.episodeNumber, 10);
          }
        });
      } catch(e) {}
    });

    // Fallback: page <title> often = "Episode 42 – Series Name | Crunchyroll"
    if (!info.seriesTitle || !info.episodeNum) {
      const t = document.title;
      const epMatch    = t.match(/[Ee]pisode\s+(\d+)/);
      const titleMatch = t.match(/^(.*?)\s*[\|–-]/);
      if (epMatch)    info.episodeNum  = parseInt(epMatch[1], 10);
      if (titleMatch) info.seriesTitle = titleMatch[1].replace(/[Ee]pisode\s+\d+\s*[-–]\s*/,'').trim();
    }

    // Fallback 2: meta og:title
    if (!info.seriesTitle) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og) {
        const v = og.content;
        const m = v.match(/^(.*?)\s*[\|–\-]/);
        if (m) info.seriesTitle = m[1].trim();
      }
    }

    return info;
  }


  // ─── Step 1: Get MAL ID via Jikan ─────────────────────────────────────────────
  async function getMalId(seriesTitle) {
    try {
      const q   = encodeURIComponent(seriesTitle);
      const data = await gmFetch(`https://api.jikan.moe/v4/anime?q=${q}&limit=5&type=tv`);
      if (!data.data || data.data.length === 0) return null;
      // Pick best match: exact title match first, else first result
      const exact = data.data.find(a =>
        a.title?.toLowerCase() === seriesTitle.toLowerCase() ||
        a.title_english?.toLowerCase() === seriesTitle.toLowerCase()
      );
      return (exact || data.data[0]).mal_id;
    } catch(e) {
      log('Jikan error: ' + e);
      return null;
    }
  }

  // ─── Step 2: Get skip times via AniSkip ───────────────────────────────────────
  async function getSkipTimes(malId, episodeNum) {
    try {
      const v = getVideo();
      const epLen = v ? Math.round(v.duration) || 0 : 0;
      const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episodeNum}`
                + `?types[]=op&types[]=ed&types[]=recap&episodeLength=${epLen}`;
      const data = await gmFetch(url);
      if (!data.found) return null;
      const out = { op: null, ed: null, recap: null };
      (data.results || []).forEach(r => {
        if (out[r.skipType] !== undefined) {
          out[r.skipType] = { startTime: r.interval.startTime, endTime: r.interval.endTime };
        }
      });
      log(`AniSkip times for MAL ${malId} ep ${episodeNum}: ` + JSON.stringify(out));
      return out;
    } catch(e) {
      log('AniSkip error: ' + e);
      return null;
    }
  }


  // ─── Orchestrate lookup ───────────────────────────────────────────────────────
  async function lookupEpisode(force = false) {
    if (!location.pathname.includes('/watch/')) return;

    const { seriesTitle, episodeNum } = parsePageInfo();
    if (!seriesTitle || !episodeNum) {
      statusMsg = '⚠️ Could not read episode info yet';
      updateStatus(); return;
    }

    if (!force && episodeNum === lastEpNum && lastMalId) return; // already loaded

    statusMsg = `🔍 Looking up "${seriesTitle}" ep ${episodeNum}…`;
    updateStatus();

    let malId = lastMalId;
    if (!malId || force) {
      malId = await getMalId(seriesTitle);
      if (!malId) {
        statusMsg = '❌ Could not find anime on MAL';
        updateStatus(); return;
      }
      lastMalId = malId;
    }

    const times = await getSkipTimes(malId, episodeNum);
    skipTimes  = times;
    lastEpNum  = episodeNum;
    skipped    = { op: false, ed: false, recap: false };

    if (!times) {
      statusMsg = '⚠️ No skip data for this episode';
    } else {
      const parts = [];
      if (times.op)    parts.push(`OP ${fmt(times.op.startTime)}–${fmt(times.op.endTime)}`);
      if (times.recap) parts.push(`Recap ${fmt(times.recap.startTime)}–${fmt(times.recap.endTime)}`);
      if (times.ed)    parts.push(`ED ${fmt(times.ed.startTime)}–${fmt(times.ed.endTime)}`);
      statusMsg = parts.length ? '✅ ' + parts.join('  |  ') : '⚠️ No segments found';
    }
    updateStatus();
  }

  function fmt(s) {
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${m}:${String(sec).padStart(2,'0')}`;
  }


  // ─── Skip tick (runs every 500ms) ─────────────────────────────────────────────
  function tick() {
    if (!cfg.enabled || !skipTimes) return;
    const v = getVideo();
    if (!v || isNaN(v.currentTime)) return;
    const t = v.currentTime;

    if (cfg.skipRecap && skipTimes.recap && !skipped.recap) {
      const { startTime, endTime } = skipTimes.recap;
      if (t >= startTime && t < endTime) { skipped.recap = true; seekTo(endTime); return; }
    }
    if (cfg.skipIntro && skipTimes.op && !skipped.op) {
      const { startTime, endTime } = skipTimes.op;
      if (t >= startTime && t < endTime) { skipped.op = true; seekTo(endTime); return; }
    }
    if (cfg.skipOutro && skipTimes.ed && !skipped.ed) {
      const { startTime, endTime } = skipTimes.ed;
      if (t >= startTime && t < endTime) { skipped.ed = true; seekTo(endTime); return; }
    }

    // Also click any native CR skip buttons in case they appear
    document.querySelectorAll('button').forEach(btn => {
      if (btn.offsetParent === null) return;
      const lbl = (btn.innerText || '').toLowerCase();
      if (cfg.skipIntro && (lbl.includes('skip intro') || lbl.includes('skip opening'))) btn.click();
      if (cfg.skipRecap && lbl.includes('skip recap')) btn.click();
      if (cfg.skipOutro && (lbl.includes('skip credits') || lbl.includes('skip outro'))) btn.click();
    });
  }

  setInterval(tick, 500);

  // ─── SPA navigation watcher ───────────────────────────────────────────────────
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl   = location.href;
      skipTimes = null;
      skipped   = { op: false, ed: false, recap: false };
      lastEpNum = null;
      statusMsg = 'New episode detected, looking up…';
      updateStatus();
      // Wait for page to populate metadata then lookup
      setTimeout(() => lookupEpisode(), 2000);
      setTimeout(() => lookupEpisode(), 5000); // retry if metadata slow
    }
  }).observe(document, { subtree: true, childList: true });


  // ═══════════════════════════════════════════════════════════════════════════════
  //  GUI
  // ═══════════════════════════════════════════════════════════════════════════════
  const C = {
    bg: '#0f0f1a', surface: '#1a1a2e', accent: '#f47521',
    accentHov: '#ff9040', text: '#fff', sub: '#9090b0',
    border: '#252540', green: '#4caf50', red: '#f44336',
    ton: '#f47521', toff: '#383858',
  };

  const css = document.createElement('style');
  css.textContent = `
    #crs-fab{position:fixed;bottom:26px;right:26px;z-index:2147483647;width:50px;height:50px;
      border-radius:50%;background:${C.accent};border:none;cursor:pointer;
      box-shadow:0 4px 20px rgba(244,117,33,.55);display:flex;align-items:center;
      justify-content:center;font-size:20px;color:#fff;transition:all .2s;user-select:none;}
    #crs-fab:hover{background:${C.accentHov};transform:scale(1.1);}
    #crs-fab.off{background:#383858;box-shadow:0 4px 14px rgba(0,0,0,.4);}
    #crs-panel{position:fixed;bottom:88px;right:26px;z-index:2147483646;width:320px;
      background:${C.bg};border:1px solid ${C.border};border-radius:14px;
      box-shadow:0 10px 40px rgba(0,0,0,.75);color:${C.text};
      font-family:'Segoe UI',Arial,sans-serif;font-size:13px;display:none;flex-direction:column;}
    #crs-panel.open{display:flex;}
    .crs-head{background:${C.surface};padding:13px 15px 11px;display:flex;
      align-items:center;justify-content:space-between;border-bottom:1px solid ${C.border};
      border-radius:14px 14px 0 0;}
    .crs-title{font-weight:700;font-size:14px;color:${C.accent};display:flex;align-items:center;gap:7px;}
    .crs-x{background:none;border:none;color:${C.sub};cursor:pointer;font-size:17px;
      line-height:1;padding:0;transition:color .15s;}
    .crs-x:hover{color:${C.text};}
    .crs-body{padding:13px 15px;display:flex;flex-direction:column;gap:11px;}
    .crs-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .crs-lbl{font-size:13px;font-weight:500;}
    .crs-sub{font-size:11px;color:${C.sub};margin-top:1px;}
    .crs-tog{position:relative;width:38px;height:21px;flex-shrink:0;}
    .crs-tog input{opacity:0;width:0;height:0;}
    .crs-sl{position:absolute;inset:0;border-radius:21px;background:${C.toff};cursor:pointer;transition:background .2s;}
    .crs-sl::before{content:'';position:absolute;left:3px;top:3px;width:15px;height:15px;
      border-radius:50%;background:#fff;transition:transform .2s;}
    .crs-tog input:checked+.crs-sl{background:${C.ton};}
    .crs-tog input:checked+.crs-sl::before{transform:translateX(17px);}
    .crs-div{height:1px;background:${C.border};}
    .crs-sec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${C.sub};}
    .crs-status{background:${C.surface};padding:9px 15px;border-top:1px solid ${C.border};
      font-size:11px;color:${C.sub};display:flex;align-items:flex-start;gap:7px;
      border-radius:0 0 14px 14px;word-break:break-word;}
    .crs-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:2px;}
    .crs-dot.on{background:${C.green};}.crs-dot.off{background:${C.red};}
    .crs-btn{background:${C.accent};border:none;color:#fff;border-radius:7px;
      padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600;transition:background .2s;}
    .crs-btn:hover{background:${C.accentHov};}
    .crs-btn.sec{background:${C.surface};border:1px solid ${C.border};color:${C.sub};}
    .crs-btn.sec:hover{color:${C.text};border-color:${C.accent};}
  `;
  document.head.appendChild(css);


  // ─── FAB ──────────────────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'crs-fab'; fab.title = 'CR Smart-Skip'; fab.innerHTML = '⏭';
  if (!cfg.enabled) fab.classList.add('off');
  document.body.appendChild(fab);

  // ─── Panel HTML ───────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'crs-panel';
  panel.innerHTML = `
    <div class="crs-head">
      <div class="crs-title">⏭ CR Smart-Skip</div>
      <button class="crs-x" id="crs-close">✕</button>
    </div>
    <div class="crs-body">
      <div class="crs-row">
        <div><div class="crs-lbl">Auto-Skip Enabled</div>
          <div class="crs-sub">Master on/off</div></div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-enabled" ${cfg.enabled?'checked':''}>
          <span class="crs-sl"></span></label>
      </div>
      <div class="crs-div"></div>
      <div class="crs-sec">What to skip</div>
      <div class="crs-row">
        <div class="crs-lbl">Skip Recap</div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-recap" ${cfg.skipRecap?'checked':''}>
          <span class="crs-sl"></span></label>
      </div>
      <div class="crs-row">
        <div class="crs-lbl">Skip Opening / Intro</div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-intro" ${cfg.skipIntro?'checked':''}>
          <span class="crs-sl"></span></label>
      </div>
      <div class="crs-row">
        <div class="crs-lbl">Skip Credits / Outro</div>
        <label class="crs-tog">
          <input type="checkbox" id="crs-outro" ${cfg.skipOutro?'checked':''}>
          <span class="crs-sl"></span></label>
      </div>
      <div class="crs-div"></div>
      <div class="crs-row" style="gap:8px">
        <button class="crs-btn" id="crs-refresh" title="Re-fetch timestamps for current episode">🔄 Re-detect</button>
        <button class="crs-btn sec" id="crs-reset" title="Force skip flags reset (re-skips current episode)">↩ Re-arm</button>
      </div>
    </div>
    <div class="crs-status">
      <span class="crs-dot ${cfg.enabled?'on':'off'}" id="crs-dot"></span>
      <span id="crs-stxt">Initialising…</span>
    </div>`;
  document.body.appendChild(panel);


  // ─── GUI wiring ───────────────────────────────────────────────────────────────
  function updateStatus() {
    const dot = document.getElementById('crs-dot');
    const txt = document.getElementById('crs-stxt');
    if (dot) dot.className = 'crs-dot ' + (cfg.enabled ? 'on' : 'off');
    if (txt) txt.textContent = statusMsg;
    fab.classList.toggle('off', !cfg.enabled);
    fab.innerHTML = cfg.enabled ? '⏭' : '⏸';
  }

  fab.addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('crs-close').addEventListener('click', () => panel.classList.remove('open'));
  document.addEventListener('click', e => {
    if (!panel.contains(e.target) && e.target !== fab) panel.classList.remove('open');
  });

  function bindTog(id, key, cb) {
    document.getElementById(id).addEventListener('change', function () {
      cfg[key] = this.checked; saveCfg(); if (cb) cb();
    });
  }

  bindTog('crs-enabled', 'enabled', () => {
    updateStatus();
    skipped = { op: false, ed: false, recap: false };
    if (cfg.enabled && !skipTimes) lookupEpisode();
  });
  bindTog('crs-recap', 'skipRecap');
  bindTog('crs-intro', 'skipIntro');
  bindTog('crs-outro', 'skipOutro');

  document.getElementById('crs-refresh').addEventListener('click', () => {
    skipTimes = null; lastEpNum = null; lastMalId = null;
    statusMsg = '🔍 Re-detecting…'; updateStatus();
    lookupEpisode(true);
  });
  document.getElementById('crs-reset').addEventListener('click', () => {
    skipped = { op: false, ed: false, recap: false };
    statusMsg = '↩ Re-armed — will skip again'; updateStatus();
  });

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  updateStatus();
  // On a watch page: start lookup after DOM settles
  if (location.pathname.includes('/watch/')) {
    setTimeout(() => lookupEpisode(), 2000);
    setTimeout(() => lookupEpisode(), 6000);
  } else {
    statusMsg = 'Open an episode to activate';
    updateStatus();
  }

  log('v3 loaded ✅');
})();
