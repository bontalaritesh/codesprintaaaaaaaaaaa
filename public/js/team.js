'use strict';
/* CODE SPRINT — team dashboard */
(function () {
  const $ = (id) => document.getElementById(id);
  const PHASE_ROUND = { round1: 0, round2: 1, round3: 2 };
  const ROUNDS = [
    { key: 'round1', title: 'Round 1 — Logic Quest', stages: ['The Gate', 'The Maze', 'The Cipher'] },
    { key: 'round2', title: 'Round 2 — Code Arena', stages: ['Predict', 'Fix It', 'Complete It', 'Solve', 'Challenge', 'Bonus'] },
    { key: 'round3', title: 'Round 3 — Debug Lab', stages: ['Broken Loop', 'Hidden Bug', 'Final Boss'] },
  ];

  document.getElementById('theme-btn').onclick = () => csToggleTheme();
  document.getElementById('logout-btn').onclick = async () => { await csApi('/api/logout', { method: 'POST' }); location.href = '/'; };

  async function load() {
    let me;
    try { me = await csApi('/api/me'); }
    catch { location.href = '/'; return; }
    if (me.role !== 'team') { location.href = '/judge.html'; return; }

    $('team-title').textContent = me.teamName || me.username;
    $('team-id').textContent = `Team ID: ${me.username}`;
    $('stat-score').textContent = me.score.total;
    $('stat-rank').textContent = me.rank != null ? `#${me.rank}` : '—';
    $('stat-progress').textContent = `${me.progress.pct}%`;
    $('stat-progress-detail').textContent = `${me.progress.answered} of ${me.progress.total} questions graded`;
    $('stat-hint').textContent = `−${me.score.hintPenalty}`;
    $('stat-tabs').textContent = `${me.tabEvents}/${me.tabSwitchLimit}`;

    // Eliminated / paused / disqualified: show the hold screen in place —
    // refreshing keeps the team signed in on this screen instead of dumping
    // them on the login page; reinstatement clears it via 'team status'.
    if (me.eliminated) { showHoldScreen('eliminated'); return; }
    if (me.status === 'stopped' || me.status === 'disqualified') {
      showHoldScreen(me.status === 'stopped' ? 'stopped' : 'disqualified');
      return;
    }
    clearHoldScreen();

    if (me.flags && me.flags.length) {
      $('review-section').hidden = false;
      $('flag-reasons').textContent = me.flags.map((f) => f.reason).join('; ');
    }

    renderJourney(me.phase.phase);
    renderRounds(me.phase.phase);
  }

  function renderJourney(phase) {
    const labels = ['The Gate', 'The Maze', 'The Cipher', 'Code Arena', 'Debug Lab'];
    const el = $('journey');
    el.innerHTML = '';
    const idx = PHASE_ROUND[phase] != null ? PHASE_ROUND[phase] : (phase === 'finished' ? 3 : -1);
    labels.forEach((lab, i) => {
      const d = document.createElement('div');
      d.className = 'stage ' + (i < idx ? 'done' : i === idx && phase !== 'lunch' ? 'active' : phase === 'lunch' && i < 3 ? 'done' : 'locked');
      d.innerHTML = `${csEsc(lab)}<span class="st">${i < idx ? 'Completed' : i === idx ? 'Active' : 'Locked'}</span>`;
      el.appendChild(d);
    });
    $('journey-note').textContent = phase === 'lunch' ? 'Lunch break — submissions disabled. Round 2 opens soon.' : '';
  }

  function renderRounds(phase) {
    const wrap = $('rounds');
    wrap.innerHTML = '';
    for (const r of ROUNDS) {
      const open = phase === r.key;
      const done = phase === 'finished' || (PHASE_ROUND[phase] != null && PHASE_ROUND[phase] > PHASE_ROUND[r.key]);
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <h3>${csEsc(r.title)}</h3>
        <div class="muted small">${r.stages.join(' · ')}</div>
        <div style="margin:12px 0"><span class="badge ${open ? 'badge-live' : done ? 'badge-ok' : ''}">${open ? 'Open' : done ? 'Completed' : 'Locked'}</span></div>
        <a class="btn btn-sm ${open ? 'btn-primary' : ''}" href="/workspace.html?round=${r.key}" ${open ? '' : 'aria-disabled="true"'}>${open ? 'Enter workspace' : 'View questions'}</a>`;
      wrap.appendChild(card);
    }
  }

  // Server-authoritative clock
  let deadline = null;
  function tick() {
    if (window.__csTimerHolds) return; // host round timer owns the clock this tick
    if (!deadline) return;
    const ms = Math.max(0, deadline - Date.now());
    const txt = csFmtClock(ms);
    $('stat-time').textContent = txt;
    $('clock').textContent = new Date().toLocaleTimeString();
    $('stat-time').classList.toggle('critical', ms < 5 * 60 * 1000);
  }
  function applyPhase(p) {
    deadline = Date.parse(p.deadline);
    $('phase-badge').textContent = p.phaseLabel;
    $('phase-badge').className = 'badge' + (p.phase.startsWith('round') ? ' badge-live' : '');
    if (p.phase === 'finished' && deadline && Date.now() > deadline) $('stat-time').textContent = '00:00:00';
    tick();
  }

  // Peer-review block screen shared by eliminated / paused / disqualified.
  // The team stays signed in: refreshing keeps this screen (no login dump),
  // and it clears itself as soon as a judge reinstates / resumes the team.
  function showHoldScreen(kind) {
    const conf = {
      eliminated: { badge: 'ELIMINATED', cls: 'badge-live', title: 'Team eliminated', text: 'Your team left the competition window too many times.<br>A judge can reinstate your team — this page returns to the competition automatically.' },
      stopped: { badge: '⏸ PAUSED', cls: '', title: 'Team paused', text: 'A judge has stopped your team temporarily. Your work is saved.<br>This screen clears automatically when a judge resumes your team.' },
      disqualified: { badge: 'DISQUALIFIED', cls: 'badge-live', title: 'Team disqualified', text: 'A judge has disqualified your team.<br>Contact the judges if you believe this is a mistake.' },
    }[kind];
    if (!conf || document.getElementById('hold-screen')) return;
    const s = document.createElement('div');
    s.id = 'hold-screen';
    s.setAttribute('style', 'position:fixed;inset:0;z-index:500;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px');
    s.innerHTML = `<div class="badge ${conf.cls}" style="font-size:14px">${conf.badge}</div>` +
      `<h1 style="font-size:26px">${conf.title}</h1>` +
      `<p class="muted" style="max-width:460px">${conf.text}</p>` +
      `<button class="btn" id="hold-logout">Log out</button>`;
    document.body.appendChild(s);
    s.querySelector('#hold-logout').onclick = async () => { try { await csApi('/api/logout', { method: 'POST' }); } catch {} location.href = '/'; };
  }
  function clearHoldScreen() { document.getElementById('hold-screen')?.remove(); }

  const socket = typeof io === 'function' ? io() : null;
  if (socket) {
    socket.on('phase', applyPhase);
    socket.on('standings', () => load().catch(() => {}));
    socket.on('team status', (d) => {
      // Judge resumed/reinstated/disqualified this team while logged in.
      if (d.reinstated || d.status === 'active') { clearHoldScreen(); location.reload(); return; }
      showHoldScreen(d.status === 'stopped' ? 'stopped' : d.status === 'disqualified' ? 'disqualified' : 'eliminated');
      load().catch(() => {});
    });
    socket.on('connect', () => load().catch(() => {}));
    socket.on('connect_error', () => {
      let s = document.getElementById('conn-status');
      if (!s) { s = document.createElement('span'); s.id = 'conn-status'; s.className = 'badge badge-live'; document.querySelector('.topbar .statusline')?.prepend(s); }
      s.textContent = 'Reconnecting…';
    });
  }

  csApi('/api/status').then(applyPhase).catch(() => {});
  load();
  setInterval(tick, 500);
  setInterval(() => {
    csApi('/api/status').then(applyPhase).catch(() => {});
    load().catch(() => {});
  }, 15000);

  // Tab-switch monitoring (report to server; server applies threshold)
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    const now = new Date().toISOString();
    if (document.hidden) { hiddenAt = now; }
    else if (hiddenAt) {
      csApi('/api/monitor/tab-event', { method: 'POST', body: { leftAt: hiddenAt, returnedAt: now } })
        .then((r) => {
          if (r.eliminated) { showHoldScreen('eliminated'); return; }
          $('stat-tabs').textContent = `${r.count}/${r.limit}`;
          if (r.count === r.limit - 1) csToast(`FINAL WARNING: one more window switch eliminates your team`, 'err');
          else csToast(`Window switch recorded: ${r.count}/${r.limit}`, 'err');
          hiddenAt = null;
        })
        .catch(() => {});
    }
  });
})();
