// ==UserScript==
// @name         Crunchyroll One Piece Auto Skip (Intro & Recap)
// @namespace    https://github.com/itsdorianlol
// @version      1.0
// @description  Automatically skips the opening and recap on One Piece episodes on Crunchyroll, jumping straight to the title screen / episode content.
// @author       Dorian
// @match        https://www.crunchyroll.com/*
// @match        https://static.crunchyroll.com/*
// @icon         https://www.crunchyroll.com/favicons/favicon-32x32.png
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Config ──────────────────────────────────────────────────────────────────
  const SKIP_INTRO  = true;   // Skip the opening / intro
  const SKIP_RECAP  = true;   // Skip the recap
  const SKIP_OUTRO  = false;  // Set true if you also want to skip credits
  const CHECK_MS    = 500;    // How often (ms) to look for skip buttons
  const ONE_PIECE_ONLY = true; // Only auto-skip on One Piece episodes

  // ─── Crunchyroll skip-button selectors (2024-2025 player) ────────────────────
  // CR renders skip buttons as <button> elements whose visible text contains
  // "Skip Intro", "Skip Recap", "Skip Credits", etc.
  // We also target the data-testid attributes used in the React player.
  const BUTTON_SELECTORS = [
    '[data-testid="skipIntroBtn"]',
    '[data-testid="skipRecapBtn"]',
    '[data-testid="skipCreditsBtn"]',
    '[data-testid="vilos-skip_intro_button"]',
    '.skip-btn',
    '.skipButton',
    'button.player-skip-button',
  ];

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function isOnePiecePage() {
    if (!ONE_PIECE_ONLY) return true;
    const url   = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();
    return url.includes('one-piece') || url.includes('one_piece') ||
           title.includes('one piece');
  }

  function labelOf(btn) {
    return (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase().trim();
  }

  function shouldClick(btn) {
    const label = labelOf(btn);
    if (SKIP_INTRO && (label.includes('intro') || label.includes('opening'))) return true;
    if (SKIP_RECAP && label.includes('recap'))  return true;
    if (SKIP_OUTRO && (label.includes('credit') || label.includes('outro') || label.includes('ending'))) return true;
    return false;
  }

  function clickVisibleSkipButtons() {
    if (!isOnePiecePage()) return;

    // 1️⃣  Try known selectors first
    for (const sel of BUTTON_SELECTORS) {
      document.querySelectorAll(sel).forEach(btn => {
        if (btn.offsetParent !== null && shouldClick(btn)) {
          console.log(`[CR Auto-Skip] Clicking: "${labelOf(btn)}"`);
          btn.click();
        }
      });
    }

    // 2️⃣  Fallback: scan ALL visible buttons for matching text
    document.querySelectorAll('button').forEach(btn => {
      if (btn.offsetParent !== null && shouldClick(btn)) {
        console.log(`[CR Auto-Skip] Fallback click: "${labelOf(btn)}"`);
        btn.click();
      }
    });
  }

  // ─── Observer: watch for dynamically injected skip buttons ───────────────────

  const observer = new MutationObserver(() => {
    clickVisibleSkipButtons();
  });

  function startObserver() {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Interval fallback (catches timed appearances) ───────────────────────────

  let intervalId = setInterval(clickVisibleSkipButtons, CHECK_MS);

  // ─── Init ─────────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }

  // Clean up if the user navigates away (SPA navigation)
  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    clearInterval(intervalId);
  });

  // Re-hook on Crunchyroll SPA navigation (URL changes without full page reload)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Reset interval for new episode page
      clearInterval(intervalId);
      intervalId = setInterval(clickVisibleSkipButtons, CHECK_MS);
      console.log('[CR Auto-Skip] SPA navigation detected, re-armed.');
    }
  }).observe(document, { subtree: true, childList: true });

  console.log('[CR Auto-Skip] One Piece auto-skipper loaded ✅');
})();
