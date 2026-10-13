'use strict';
/**
 * CODE SPRINT — host-controlled round timer: participant display.
 *
 * The SERVER is the authority (snapshot: state + remainingMs + serverNow + a
 * monotonic version). This module only renders that snapshot:
 *  • RUNNING → animates locally from the authoritative anchor
 *  • frozen states (READY/PAUSED/STOPPED/EXPIRED/ENDED) render remainingMs exactly
 *  • a version guard drops out-of-order/duplicate broadcasts
 *  • on socket reconnect the authoritative snapshot is re-fetched (page reloads
 *    and refreshes never restart or reset the timer)
 *
 * While this module owns the clock (round phases only), pages must not fight
 * over it: their own tick() respects window.__csTimerHolds.
 */
(function () {
  const ROUND_RE = /^round[123]$/;
  const COPY = {
    ready: 'Waiting for host to start',
    running: '',
    paused: 'Timer paused by host',
    stopped: 'Timer stopped by host',
    expired: 'Time expired',
    ended: 'Round ended by host',
  };

  let phase = null;          // current schedule phase key (round1/round2/round3/…)
  let snap = null;
  let mono = 0;              // performance.now() at snapshot reception
  let version = -1;          // monotonic version guard
  let pill = null;
  let blockedNote = null;

  const fmt = window.csFmtClock || ((ms) => {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    return `00:${m}:${String(s % 60).padStart(2, '0')}`;
  });

  const el = (id) => document.getElementById(id);

  function ensurePill() {
    if (pill) return pill;
    const clock = el('clock');
    if (!clock) return null;
    pill = document.createElement('span');
    pill.id = 'timer-state';
    pill.className = 'badge';
    pill.style.marginLeft = '4px';
    clock.after(pill);
    return pill;
  }

  function currentRound() { return ROUND_RE.test(phase || '') ? phase : null; }

  function release() {
    window.__csTimerHolds = false;
    if (blockedNote) { blockedNote.remove(); blockedNote = null; }
    const p = el('timer-state'); if (p) p.remove();
    pill = null;
  }

  function render() {
    if (!snap) { release(); return; }
    const r = currentRound();
    if (!r || snap.round !== r) { release(); return; }
    window.__csTimerHolds = true;

    let rem = snap.remainingMs;
    if (snap.state === 'running') rem = Math.max(0, snap.remainingMs - (performance.now() - mono));

    const clock = el('clock');
    if (clock) clock.textContent = fmt(rem);
    if (el('stat-time')) el('stat-time').textContent = fmt(rem);

    const p = ensurePill();
    if (p) {
      p.textContent = COPY[snap.state] || snap.state.toUpperCase();
      p.classList.toggle('badge-live', snap.state === 'running');
    }

    // §6 ENDED/EXPIRED: disable actions the server would reject anyway.
    const sub = el('submit-btn'); const hint = el('hint-btn');
    if (sub) {
      const blocked = snap.state === 'ended' || snap.state === 'expired';
      if (blocked) {
        sub.disabled = true;
        sub.title = COPY[snap.state];
        if (!blockedNote) {
          blockedNote = document.createElement('div');
          blockedNote.className = 'muted small';
          blockedNote.style.marginTop = '6px';
          blockedNote.textContent = COPY[snap.state] + ' — submissions for this round are closed.';
          sub.after(blockedNote);
        }
      } else {
        sub.disabled = false; sub.title = '';
        if (blockedNote) { blockedNote.remove(); blockedNote = null; }
      }
      if (hint) hint.disabled = blocked;
    }
  }

  function apply(t) {
    if (!t || !t.round) return;
    if (version > -1 && t.version < version) return; // stale / duplicated broadcast
    version = t.version;
    snap = t;
    mono = performance.now();
    render();
  }

  async function refresh() {
    const r = currentRound();
    if (!r) { release(); return; }
    try {
      const res = await fetch(`/api/timer/${r}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
      if (res.ok) apply(await res.json());
    } catch { /* offline; socket reconnect will retry */ }
  }

  // Own lightweight socket + phase fetch so pages need no extra wiring.
  const socket = typeof io === 'function' ? io() : null;
  if (socket) {
    socket.on('round timer', apply);
    socket.on('phase', (p) => { phase = p?.phase ?? phase; refresh(); });
    socket.on('connect', () => { version = -1; refresh(); }); // re-sync authority
  }
  fetch('/api/status').then((r) => r.ok ? r.json() : null).then((p) => { if (p?.phase) { phase = p.phase; refresh(); } }).catch(() => {});

  setInterval(() => { if (window.__csTimerHolds && snap) render(); }, 500);
})();
