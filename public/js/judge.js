'use strict';
/* CODE SPRINT — judge dashboard client */
(function () {
  const $ = (id) => document.getElementById(id);
  const isAdmin = window.CS_IS_ADMIN === true;

  document.getElementById('theme-btn').onclick = () => csToggleTheme();
  document.getElementById('logout-btn').onclick = async () => { await csApi('/api/logout', { method: 'POST' }); location.href = '/'; };

  let overview = null;

  async function load() {
    let d;
    try { d = await csApi('/api/judge/overview'); }
    catch (e) { if (String(e.message).includes('Forbidden') || String(e.message).includes('403')) location.href = '/team.html'; return; }
    overview = d;
    applyPhase(d.phase);
    renderStats(d);
    renderSettings(d.settings, d.phase);
    renderTeams(d.teams);
    renderSubs(d.recentSubs);
    renderIncidents(d.incidents, d.flags);
    renderAudit(d.audit);
  }

  function applyPhase(p) {
    $('phase-badge').textContent = p.phaseLabel;
    $('phase-badge').className = 'badge' + (p.phase.startsWith('round') ? ' badge-live' : '');
    $('deadline-info').textContent = `Deadline: ${new Date(p.deadline).toLocaleTimeString()} · Server time: ${new Date(p.serverTime).toLocaleTimeString()}`;
  }

  function renderStats(d) {
    $('stat-teams').textContent = d.teamCount;
    $('stat-subs').textContent = d.recentSubs.length;
    $('stat-incidents').textContent = d.incidents.filter((i) => i.status === 'open').length;
    // Health section
    csApi('/api/health').then((h) => {
      $('h-db').textContent = h.db === 'ok' ? '✓ OK' : '✗ Error';
      $('h-conn').textContent = h.connectedSockets;
      const up = h.uptimeSeconds;
      $('h-uptime').textContent = up > 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m`;
      $('h-backup').textContent = h.lastBackupAt ? new Date(h.lastBackupAt).toLocaleTimeString() : 'none';
    }).catch(() => {});
  }

  function renderSettings(s, phase) {
    $('set-date').value = s['competition.date'] || '';
    $('set-r1s').value = s['schedule.r1_start'] || '10:00';
    $('set-r2s').value = s['schedule.r2_start'] || '13:00';
    $('set-r3s').value = s['schedule.r3_start'] || '15:00';
    $('set-r1m').value = s['schedule.r1_minutes'] || '120';
    $('set-r2m').value = s['schedule.r2_minutes'] || '120';
    $('set-r3m').value = s['schedule.r3_minutes'] || '60';
    $('set-threshold').value = s['monitor.tab_threshold'] || '3';
    $('set-hints').value = s['hints.enabled'] || '1';
    $('schedule-conflicts').textContent = (phase.schedule.conflicts || []).join(' ');
  }

  $('save-settings').onclick = async () => {
    try {
      await csApi('/api/judge/settings', {
        method: 'PUT',
        body: {
          'competition.date': $('set-date').value,
          'schedule.r1_start': $('set-r1s').value,
          'schedule.r2_start': $('set-r2s').value,
          'schedule.r3_start': $('set-r3s').value,
          'schedule.r1_minutes': Number($('set-r1m').value) || 120,
          'schedule.r2_minutes': Number($('set-r2m').value) || 120,
          'schedule.r3_minutes': Number($('set-r3m').value) || 60,
          'monitor.tab_threshold': Number($('set-threshold').value) || 3,
          'hints.enabled': $('set-hints').value,
        },
      });
      csToast('Settings saved', 'ok');
      load();
    } catch (e) { csToast(e.message, 'err'); }
  };

  // Quick start / hold — host can start or postpone the competition anytime.
  async function quickStart(minutes, label) {
    try {
      await csApi('/api/judge/quick-start', { method: 'POST', body: { startInMinutes: minutes } });
      csToast(label, 'ok');
      load();
    } catch (e) { csToast(e.message, 'err'); }
  }
  $('qs-now').onclick = () => quickStart(0, 'Competition started — Round 1 is live');
  $('qs-5').onclick = () => quickStart(5, 'Competition will start in 5 minutes');
  $('qs-15').onclick = () => quickStart(15, 'Competition will start in 15 minutes');
  $('hold-btn').onclick = () => openConfirm('Hold / postpone competition',
    'All rounds lock immediately and the status returns to “Not Started”. Nothing is deleted — you can Start again at any time.',
    async () => {
      try { await csApi('/api/judge/hold', { method: 'POST', body: {} }); csToast('Competition on hold — Not Started', 'ok'); load(); }
      catch (e) { csToast(e.message, 'err'); }
    }, false);

  function renderTeams(teams) {
    const filter = $('team-filter').value.toLowerCase();
    const body = $('teams-table').querySelector('tbody');
    const rows = teams.filter((t) => !filter || t.teamName.toLowerCase().includes(filter) || t.username.includes(filter));
    const statusBadge = (t) => t.eliminated ? '<span class="badge badge-live">Eliminated</span>'
      : t.status === 'stopped' ? '<span class="badge">⏸ Stopped</span>'
      : t.status === 'disqualified' ? '<span class="badge badge-live">Disqualified</span>'
      : '<span class="badge badge-ok">Active</span>';
    const actions = (t) => t.eliminated
      ? `<button class="btn btn-sm" data-reinstate="${csEsc(t.username)}">Re-instate</button>`
      : `${t.status !== 'stopped'
          ? `<button class="btn btn-sm" data-act="stop" data-team="${csEsc(t.username)}">Stop</button> `
          : `<button class="btn btn-sm" data-act="resume" data-team="${csEsc(t.username)}">Resume</button> `}
         ${t.status !== 'disqualified'
           ? `<button class="btn btn-sm btn-danger" data-act="disqualify" data-team="${csEsc(t.username)}">Disqualify</button>`
           : `<button class="btn btn-sm" data-act="reactivate" data-team="${csEsc(t.username)}">Reactivate</button>`}
         <button class="btn btn-sm" data-flag="${csEsc(t.username)}">${t.flagged ? 'Flagged' : 'Flag'}</button>`;
    body.innerHTML = rows.map((t) => `
      <tr>
        <td class="num">${t.rank}</td>
        <td>${csEsc(t.teamName)}</td>
        <td class="mono">${csEsc(t.username)}</td>
        <td class="num">${t.total}</td>
        <td class="num">${t.hints}</td>
        <td class="num">${t.tabEvents}</td>
        <td>${statusBadge(t)}${t.flagged ? ' <span class="badge badge-live">Flagged</span>' : ''}</td>
        <td style="white-space:nowrap">${actions(t)}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">No teams.</td></tr>';
    body.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act, team = b.dataset.team;
        const labels = { stop: ['Stop team', `Pause ${team}? They cannot submit until resumed.`],
          resume: ['Resume team', `Let ${team} continue competing again?`],
          disqualify: ['Disqualify team', `Disqualify ${team}? Their submissions stay for review but they cannot compete.`],
          reactivate: ['Reactivate team', `Allow ${team} to compete again after disqualification?`] };
        openConfirm(labels[act][0], labels[act][1], async (reason) => {
          try {
            await csApi('/api/judge/team-status', { method: 'POST', body: { teamId: team, action: act, reason } });
            csToast(`${team}: ${act} applied`, 'ok'); load();
          } catch (e) { csToast(e.message, 'err'); }
        }, act === 'stop' || act === 'disqualify');
      };
    });
    body.querySelectorAll('[data-flag]').forEach((b) => {
      b.onclick = () => openConfirm('Flag team', `Flag ${b.dataset.flag} for review?`, async (reason) => {
        await csApi('/api/judge/flag', { method: 'POST', body: { teamId: b.dataset.flag, reason } });
        csToast('Team flagged', 'ok'); load();
      });
    });
    body.querySelectorAll('[data-reinstate]').forEach((b) => {
      b.onclick = async () => {
        try { await csApi('/api/judge/reinstate', { method: 'POST', body: { teamId: b.dataset.reinstate } }); csToast(`${b.dataset.reinstate} re-instated`, 'ok'); load(); }
        catch (e) { csToast(e.message, 'err'); }
      };
    });
  }

  function renderSubs(subs) {
    const body = $('subs-table').querySelector('tbody');
    body.innerHTML = subs.slice(0, 30).map((s) => `
      <tr>
        <td class="mono small">${csEsc(s.submitted_at)}</td>
        <td>${csEsc(s.team_name || s.team_id)}</td>
        <td class="small">${csEsc(s.title)}</td>
        <td><span class="badge ${s.is_correct ? 'badge-ok' : ''}">${s.is_correct ? 'Correct' : 'Incorrect'}</span></td>
        <td class="num">${s.awarded_marks}</td>
        <td><button class="btn btn-sm" data-regrade="${s.id}" data-max="${s.awarded_marks}" data-title="${csEsc(s.title)}">Re-grade</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No submissions yet.</td></tr>';
    body.querySelectorAll('[data-regrade]').forEach((b) => {
      b.onclick = () => {
        $('regrade-info').textContent = b.dataset.title;
        $('regrade-marks').value = b.dataset.max;
        $('regrade-dialog').showModal();
        $('regrade-save').onclick = async () => {
          try {
            await csApi(`/api/judge/submissions/${b.dataset.regrade}/regrade`, { method: 'POST', body: { awarded: Number($('regrade-marks').value) } });
            $('regrade-dialog').close();
            csToast('Re-graded', 'ok'); load();
          } catch (e) { csToast(e.message, 'err'); }
        };
      };
    });
  }

  function renderIncidents(incidents, flags) {
    $('incidents-list').innerHTML = incidents.filter((i) => i.status === 'open').slice(0, 20).map((i) => `
      <div style="border-bottom:1px solid var(--border);padding:8px 0;display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span><strong>${csEsc(i.team_id)}</strong> — ${csEsc(i.kind)} <span class="muted">${csEsc(i.created_at)}</span></span>
        <button class="btn btn-sm" data-clear="${i.id}">Clear</button>
      </div>`).join('') || '<p class="muted">No open incidents.</p>';
    $('incidents-list').querySelectorAll('[data-clear]').forEach((b) => {
      b.onclick = async () => { await csApi(`/api/judge/incidents/${b.dataset.clear}/clear`, { method: 'POST', body: {} }); load(); };
    });

    $('flags-list').innerHTML = flags.slice(0, 20).map((f) => `
      <div style="border-bottom:1px solid var(--border);padding:8px 0;display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span><strong>${csEsc(f.team_id)}</strong> — ${csEsc(f.reason)}</span>
        <button class="btn btn-sm" data-unflag="${f.id}">Clear flag</button>
      </div>`).join('') || '<p class="muted">No active flags.</p>';
    $('flags-list').querySelectorAll('[data-unflag]').forEach((b) => {
      b.onclick = async () => { await csApi(`/api/judge/flags/${b.dataset.unflag}/clear`, { method: 'POST', body: {} }); load(); };
    });
  }

  function renderAudit(audit) {
    const body = $('audit-table').querySelector('tbody');
    body.innerHTML = audit.slice(0, 40).map((a) => `
      <tr><td class="mono small">${csEsc(a.created_at)}</td><td>${csEsc(a.actor_name || 'system')}</td><td class="small">${csEsc(a.action)}</td><td class="small muted">${csEsc(a.detail || '')}</td></tr>`).join('');
  }

  // Score adjustment
  $('adj-btn').onclick = async () => {
    try {
      await csApi('/api/judge/score-adjust', {
        method: 'POST',
        body: { teamId: $('adj-team').value.trim(), delta: Number($('adj-delta').value), reason: $('adj-reason').value.trim() },
      });
      csToast('Score adjusted', 'ok');
      load();
    } catch (e) { csToast(e.message, 'err'); }
  };

  // ============ QUESTION BANK MANAGER (master prompt §4) ============
  let bankCache = [];
  async function loadBank() {
    const list = $('bank-list');
    list.textContent = 'Loading…';
    const params = new URLSearchParams();
    if ($('bank-search').value.trim()) params.set('q', $('bank-search').value.trim());
    if ($('bank-round').value) params.set('round', $('bank-round').value);
    if ($('bank-review').value) params.set('review', $('bank-review').value);
    try {
      const d = await csApi(`/api/judge/bank?${params}`);
      bankCache = d.questions;
      $('bank-count').textContent = `${d.questions.length} questions`;
      renderBank(d.questions);
    } catch (e) { list.textContent = e.message; }
  }
  const STAGE_BADGE = (q) => `${csEsc(q.round_key)} · ${csEsc(q.stage_key)} · Q${q.order_num}`;
  function renderBank(qs) {
    const list = $('bank-list');
    if (!qs.length) { list.innerHTML = '<p class="muted">No questions match.</p>'; return; }
    list.innerHTML = qs.map((q) => `
      <div data-qid="${q.id}" style="border-bottom:1px solid var(--border);padding:10px 0;display:flex;gap:12px;align-items:flex-start;justify-content:space-between">
        <div style="min-width:0">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <strong>${csEsc(q.title)}</strong>
            <span class="badge">${csEsc(q.type)} · ${q.marks}m</span>
            <span class="badge">${STAGE_BADGE(q)}</span>
            ${q.difficulty ? `<span class="badge">${csEsc(q.difficulty)}</span>` : ''}
            ${q.review_status !== 'verified' ? `<span class="badge badge-live">${csEsc(q.review_status)}</span>` : ''}
            ${q.archived ? '<span class="badge">archived</span>' : (!q.enabled ? '<span class="badge">disabled</span>' : '')}
            <span class="muted small">${q.submissions} subs</span>
          </div>
          ${q.review_note ? `<div class="small" style="margin-top:4px;font-weight:600">⚠ ${csEsc(q.review_note)}</div>` : ''}
        </div>
        <div style="white-space:nowrap;display:flex;gap:6px">
          <button class="btn btn-sm" data-bank-act="edit" data-id="${q.id}">Edit</button>
          <button class="btn btn-sm" data-bank-act="dup" data-id="${q.id}">Duplicate</button>
          <button class="btn btn-sm" data-bank-act="toggle" data-id="${q.id}">${q.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm btn-danger" data-bank-act="archive" data-id="${q.id}">${q.archived ? 'Restore' : 'Archive'}</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-bank-act]').forEach((b) => {
      b.onclick = () => bankAction(b.dataset.bankAct, Number(b.dataset.id));
    });
  }
  async function bankAction(act, id) {
    const q = bankCache.find((x) => x.id === id);
    if (!q) return;
    if (act === 'edit') return openQEdit(q);
    if (act === 'dup') {
      try { await csApi(`/api/judge/bank/${id}/duplicate`, { method: 'POST', body: {} }); csToast('Duplicated as disabled draft', 'ok'); loadBank(); }
      catch (e) { csToast(e.message, 'err'); }
      return;
    }
    if (act === 'toggle') {
      try { await csApi(`/api/judge/bank/${id}`, { method: 'PUT', body: { enabled: !q.enabled } }); loadBank(); }
      catch (e) { csToast(e.message, 'err'); }
      return;
    }
    if (act === 'archive') {
      const doIt = async () => {
        try { await csApi(`/api/judge/bank/${id}/${q.archived ? 'restore' : 'archive'}`, { method: 'POST', body: {} }); csToast(q.archived ? 'Restored' : 'Archived', 'ok'); loadBank(); }
        catch (e) { csToast(e.message, 'err'); }
      };
      if (q.archived) return doIt();
      return openConfirm('Archive question', `Archive "${q.title}"? It disappears from all participant screens. Submissions are kept.`, doIt, false);
    }
  }
  function openQEdit(q) {
    $('qedit-title').textContent = `Edit — ${q.external_key || 'new'}`;
    $('qe-round').value = q.round_key || 'round1';
    $('qe-stage').value = q.stage_key || '';
    $('qe-title').value = q.title || '';
    $('qe-category').value = q.category || '';
    $('qe-difficulty').value = q.difficulty || '';
    $('qe-topic').value = q.topic || '';
    $('qe-statement').value = q.statement || '';
    $('qe-type').value = q.type || 'mcq';
    $('qe-marks').value = q.marks ?? 10;
    $('qe-options').value = (q.options || []).join('\n');
    let ansText = q.answer || '';
    try { ansText = JSON.stringify(JSON.parse(ansText), null, 1); } catch { /* plain string */ }
    $('qe-answer').value = ansText;
    $('qe-explanation').value = q.explanation || '';
    $('qe-snippet').value = q.code_snippet || '';
    $('qe-sample-in').value = q.sample_input || '';
    $('qe-sample-out').value = q.sample_output || '';
    $('qe-constraints').value = q.constraints || '';
    $('qe-hint').value = q.hint || '';
    $('qe-hint-penalty').value = q.hint_penalty || 0;
    $('qe-review').value = q.review_status || 'verified';
    $('qe-pub').value = q.publication_status || 'approved';
    $('qedit-dialog').dataset.qid = q.id || '';
    syncQEditFields();
    $('qedit-dialog').showModal();
  }
  function syncQEditFields() {
    const isMcq = $('qe-type').value === 'mcq';
    $('qe-options-label').style.display = isMcq ? '' : 'none';
    $('qe-options').style.display = isMcq ? '' : 'none';
    $('qe-answer-label').textContent = isMcq ? 'Answer key (must match one option exactly)' : 'Answer key (for code: JSON grading spec, e.g. {"mode":"contains_all","values":["i += 2;"]})';
  }
  $('qe-type').onchange = syncQEditFields;
  $('qedit-cancel').onclick = () => $('qedit-dialog').close();
  $('qedit-save').onclick = async () => {
    const body = {
      round_key: $('qe-round').value,
      stage_key: $('qe-stage').value.trim(),
      title: $('qe-title').value.trim(),
      category: $('qe-category').value.trim(),
      difficulty: $('qe-difficulty').value.trim(),
      topic: $('qe-topic').value.trim(),
      statement: $('qe-statement').value,
      type: $('qe-type').value,
      marks: Number($('qe-marks').value) || 10,
      explanation: $('qe-explanation').value,
      code_snippet: $('qe-snippet').value,
      sample_input: $('qe-sample-in').value,
      sample_output: $('qe-sample-out').value,
      constraints: $('qe-constraints').value,
      hint: $('qe-hint').value,
      hint_penalty: Number($('qe-hint-penalty').value) || 0,
      review_status: $('qe-review').value,
      publication_status: $('qe-pub').value,
    };
    if (body.type === 'mcq') {
      const opts = $('qe-options').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (opts.length < 2) { csToast('MCQ needs at least 2 options (first line is the answer key)', 'err'); return; }
      body.options = opts;
      body.answer = opts[0];
    } else {
      body.answer = $('qe-answer').value.trim();
      if (!body.answer) { csToast('Answer key is required', 'err'); return; }
    }
    try {
      const qid = $('qedit-dialog').dataset.qid;
      if (qid) await csApi(`/api/judge/bank/${qid}`, { method: 'PUT', body });
      else await csApi('/api/judge/bank', { method: 'POST', body });
      $('qedit-dialog').close();
      csToast('Question saved', 'ok');
      loadBank();
    } catch (e) { csToast(e.message, 'err'); }
  };
  $('bank-load').onclick = loadBank;
  $('bank-search').onkeydown = (e) => { if (e.key === 'Enter') loadBank(); };
  $('bank-new').onclick = () => {
    openQEdit({ round_key: $('bank-round').value || 'round1', type: 'mcq', marks: 10, review_status: 'verified', publication_status: 'approved' });
    $('qedit-title').textContent = 'New question';
  };

  $('backup-btn').onclick = async () => {
    try { const r = await csApi('/api/judge/backup-now', { method: 'POST', body: {} }); csToast(`Backup saved: ${r.file}`, 'ok'); load(); }
    catch (e) { csToast(e.message, 'err'); }
  };

  // Freeze / unfreeze with confirmation
  function openConfirm(title, text, onOk, needReason) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-reason-label').style.display = needReason ? '' : 'none';
    $('confirm-reason').style.display = needReason ? '' : 'none';
    $('confirm-reason').value = '';
    $('confirm-dialog').showModal();
    $('confirm-ok').onclick = () => { $('confirm-dialog').close(); onOk($('confirm-reason').value.trim()); };
  }
  $('confirm-cancel').onclick = () => $('confirm-dialog').close();

  $('freeze-btn').onclick = () => openConfirm('Freeze final leaderboard',
    'This freezes ALL scores permanently. Use only after the competition ends and verification is complete.',
    async () => {
      try { await csApi('/api/judge/freeze', { method: 'POST', body: { confirm: true } }); csToast('Results frozen', 'ok'); load(); }
      catch (e) { csToast(e.message, 'err'); }
    }, false);

  $('unfreeze-btn').onclick = () => openConfirm('Unfreeze results (authorized correction)',
    'Results will return to provisional. A correction reason is recorded in the audit log. Re-freeze after correcting.',
    async (reason) => {
      try { await csApi('/api/judge/unfreeze', { method: 'POST', body: { confirm: true, correctionReason: reason } }); csToast('Unfrozen — make corrections, then re-freeze', 'ok'); load(); }
      catch (e) { csToast(e.message, 'err'); }
    }, true);

  let deadline = null;
  function tick() {
    if (deadline) $('clock').textContent = csFmtClock(Math.max(0, deadline - Date.now()));
  }
  const socket = io();
  socket.on('phase', (p) => { deadline = Date.parse(p.deadline); applyPhase(p); tick(); });
  socket.on('incident', () => { csToast('New incident reported', 'err'); load(); });
  setInterval(tick, 500);
  setInterval(load, 30000);
  load();
})();

/**
 * Host-controlled Round Timer Control panel.
 * The SERVER owns the state machine; this panel is a remote control.
 * A click is only “done” after the server responds 200 — errors are shown.
 */
(function roundTimerPanel() {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = {
    round: $('timer-round'), durMin: $('timer-dur-min'), durSec: $('timer-dur-sec'),
    setDur: $('timer-set-duration'), extMin: $('timer-ext-min'), extend: $('timer-extend'),
    clock: $('timer-clock'), badge: $('timer-state-badge'), msg: $('timer-state-msg'),
    start: $('timer-start'), pause: $('timer-pause'), resume: $('timer-resume'),
    stop: $('timer-stop'), reset: $('timer-reset'), end: $('timer-end'),
    last: $('timer-last-action'), actor: $('timer-last-actor'), version: $('timer-version'), sync: $('timer-sync'),
  };

  let snap = null;
  let mono = 0;          // performance.now() at snapshot reception
  let knownVersion = -1; // stale-broadcast guard (ignores out-of-order events)

  // Enabled buttons per state (§7 matrix)
  const ENABLE = {
    ready:    { start: 1, reset: 1, end: 1, setDur: 1 },
    running:  { pause: 1, stop: 1, extend: 1, reset: 1, end: 1 },
    paused:   { resume: 1, stop: 1, extend: 1, reset: 1, end: 1 },
    stopped:  { start: 1, extend: 1, reset: 1, end: 1, setDur: 1 },
    expired:  { reset: 1, end: 1, setDur: 1 },
    ended:    {},
  };
  const COPY = {
    ready: 'Waiting for host to start',
    running: 'Running — counting down',
    paused: 'Timer paused by host',
    stopped: 'Timer stopped by host',
    expired: 'Time expired',
    ended: 'Round ended by host',
  };
  const BADGE = { ready: 'READY', running: 'RUNNING', paused: 'PAUSED', stopped: 'STOPPED', expired: 'EXPIRED', ended: 'ENDED' };

  function drawClock() {
    if (!snap) return;
    let rem = snap.remainingMs;
    if (snap.state === 'running') rem = Math.max(0, snap.remainingMs - (performance.now() - mono));
    el.clock.textContent = csFmtClock(rem);
    el.clock.classList.toggle('timer', true);
    el.clock.style.color = snap.state === 'running' && rem < 60000 ? 'var(--danger, #e5484d)' : '';
  }

  function render() {
    if (!snap) return;
    const s = snap.state;
    el.badge.textContent = BADGE[s] || s.toUpperCase();
    el.msg.textContent = COPY[s] || '';
    const on = ENABLE[s] || {};
    for (const [btn, key] of [[el.start, 'start'], [el.pause, 'pause'], [el.resume, 'resume'], [el.stop, 'stop'], [el.reset, 'reset'], [el.end, 'end'], [el.extend, 'extend'], [el.setDur, 'setDur']]) {
      btn.disabled = !on[key];
    }
    const durTotal = Math.round(snap.durationMs / 1000);
    if (on.setDur) { el.durMin.value = Math.floor(durTotal / 60); el.durSec.value = durTotal % 60; }
    el.last.textContent = snap.lastAction || '—';
    el.actor.textContent = snap.lastActor || '—';
    el.version.textContent = snap.version;
  }

  async function refresh() {
    try {
      const t = await csApi(`/api/timer/${el.round.value}`);
      apply(t);
      el.sync.textContent = 'synced';
    } catch (e) { el.sync.textContent = 'sync lost — retrying'; }
  }

  function apply(t) {
    if (!t || t.round !== el.round.value) return;
    if (knownVersion > -1 && t.version < knownVersion) return; // stale broadcast
    knownVersion = t.version;
    snap = t;
    mono = performance.now();
    render(); drawClock();
  }

  async function cmd(action, body = {}) {
    const round = el.round.value;
    try {
      const res = await csApi(`/api/judge/timer/${round}/${action}`, { method: 'POST', body: { expectedVersion: snap?.version, ...body } });
      apply(res.timer);
      el.sync.textContent = 'synced';
    } catch (e) {
      csToast(`Timer ${action} rejected: ${e.message}`, 'err');
      refresh(); // restore authoritative state on rejection
    }
  }

  el.round.addEventListener('change', () => { knownVersion = -1; snap = null; el.clock.textContent = '00:00:00'; el.badge.textContent = '—'; el.msg.textContent = ''; refresh(); });
  el.start.onclick = () => cmd('start');
  el.pause.onclick = () => cmd('pause');
  el.resume.onclick = () => cmd('resume');
  el.stop.onclick = () => cmd('stop');
  el.reset.onclick = () => {
    if (['running', 'paused'].includes(snap?.state) && !confirm('Resetting a ' + snap.state + ' timer restores the full configured duration and discards the elapsed portion. Continue?')) return;
    cmd('reset');
  };
  el.end.onclick = () => {
    if (!confirm('End this round for every team now? Submissions for this round will be rejected. This is recorded in the audit log.')) return;
    cmd('end');
  };
  el.extend.onclick = () => {
    const mins = Number(el.extMin.value) || 0;
    if (!(mins > 0)) { csToast('Enter a positive number of minutes to extend', 'err'); return; }
    cmd('extend', { minutes: mins });
  };
  el.setDur.onclick = () => {
    const mins = Number(el.durMin.value) || 0, secs = Number(el.durSec.value) || 0;
    if (mins === 0 && secs === 0) { csToast('Duration cannot be 00:00', 'err'); return; }
    cmd('duration', { minutes: mins, seconds: secs });
  };

  const socket = io();
  socket.on('round timer', apply);
  socket.on('connect', () => refresh());      // restore authority after reconnection
  socket.on('connect_error', () => { el.sync.textContent = 'offline — commands via HTTP still work when reconnected'; });
  refresh();
  setInterval(drawClock, 500); // local animation; server remains the authority
})();
