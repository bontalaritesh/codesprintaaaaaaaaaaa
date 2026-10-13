'use strict';
/* CODE SPRINT — workspace client */
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const roundKey = params.get('round') || 'round1';

  let questions = [];
  let current = null;
  let cm = null; // CodeMirror instance if the CDN loaded
  let draftTimer = null;

  // ---- Fullscreen enforcement on round entry ----
  // Attempts to enter fullscreen immediately (allowed only via user gesture in
  // some browsers). If blocked, shows a full-screen gate requiring one click —
  // the click satisfies the gesture requirement and enters fullscreen.
  (function enforceFullscreen() {
    const el = document.documentElement;
    const enter = () => {
      if (!document.fullscreenElement && el.requestFullscreen) {
        el.requestFullscreen().catch(() => { /* user may have denied */ });
      }
      document.getElementById('fs-gate')?.remove();
      if (lockSocket) { lockSocket.emit('fs:entered'); }
    };
    if (document.fullscreenElement) return;
    if (el.requestFullscreen) {
      // try without gesture first (works if navigation came from a click on our own site)
      el.requestFullscreen().catch(() => showGate());
    }
    function showGate() {
      if (document.getElementById('fs-gate')) return;
      const gate = document.createElement('div');
      gate.id = 'fs-gate';
      gate.setAttribute('style', 'position:fixed;inset:0;z-index:1000;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:24px');
      gate.innerHTML = `<div><h2 style="font-size:26px">FULLSCREEN REQUIRED</h2>` +
        `<p class="muted" style="max-width:420px">The competition window must run in full screen.<br>` +
        `Leaving this window more than 3 times will eliminate your team.</p></div>` +
        `<button class="btn btn-primary" id="fs-enter">Enter fullscreen</button>`;
      document.body.appendChild(gate);
      gate.querySelector('#fs-enter').onclick = enter;
    }
    document.addEventListener('fullscreenchange', () => {
      // If the user exits fullscreen mid-round, warn (the tab-event handler
      // counts visibilitychange separately for window minimization/tab switch).
      if (!document.fullscreenElement && document.getElementById('fs-gate') === null && questions && questions.length) {
        // Re-show gate (click needed to re-enter).
        showGate();
      }
    });
  })();

  document.getElementById('theme-btn').onclick = () => csToggleTheme();

  // ---- CodeMirror editor (single source of truth; textarea is hidden) ----
  const ta = $('answer');
  if (window.CodeMirror) {
    cm = CodeMirror.fromTextArea(ta, {
      lineNumbers: true,
      mode: 'text/x-python',
      indentUnit: 4,
      lineWrapping: true,
    });
    cm.setSize('100%', '340px');
    $('editor-fallback-note').style.display = 'none';
  } else {
    // CDN unavailable — plain textarea fallback stays visible.
    ta.style.minHeight = '340px';
  }
  const hasCM = () => !!cm;
  function getEditorValue() { return cm ? cm.getValue() : ta.value; }
  function setEditorValue(v) {
    if (cm) cm.setValue(v || '');
    else ta.value = v || '';
  }
  function setLangMode(lang) {
    if (!cm) return;
    const modes = {
      python: { name: 'python', version: 3, singleLineStringErrors: false },
      c: 'text/x-csrc',
      cpp: 'text/x-c++src',
      java: 'text/x-java',
    };
    cm.setOption('mode', modes[lang] || 'text/x-csrc');
  }

  let lockSocket = typeof io === 'function' ? io() : null;

  async function load() {
    let data;
    try { data = await csApi(`/api/questions/${roundKey}`); }
    catch (e) {
      csToast(e.message, 'err');
      if (/eliminated/i.test(e.message)) showEliminatedScreen();
      return;
    }

    $('phase-badge').textContent = data.locked ? 'Locked' : 'Open';
    $('phase-badge').className = 'badge' + (data.locked ? '' : ' badge-live');
    $('locked-msg').hidden = !data.locked;
    if (data.locked) {
      $('locked-detail').textContent = 'Submissions are disabled for this round. You can still review questions.';
      $('workspace-grid').style.opacity = '.5';
      $('submit-btn').disabled = true;
      $('save-btn').disabled = true;
    }
    questions = data.questions;
    renderNav();
    if (questions.length) select(0);
  }

  function renderNav() {
    const nav = $('q-nav');
    nav.innerHTML = '';
    questions.forEach((q, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `Q${q.order_num}`;
      b.title = `${q.title} — ${q.stage_key}`;
      if (q.submission && q.submission.status === 'graded') b.classList.add('answered');
      b.onclick = () => select(i);
      nav.appendChild(b);
    });
  }

  function select(i) {
    if (!questions.length) return;
    current = questions[i];
    [...$('q-nav').children].forEach((b, j) => b.classList.toggle('current', j === i));
    $('q-title').textContent = current.title;
    $('q-marks').textContent = `${current.marks} marks`;
    $('q-meta').textContent = `Stage: ${current.stage_key} · Category: ${current.category || '—'} · Type: ${current.type}`;
    $('q-statement').textContent = current.statement;

    // Code snippet / sample I/O panels (source-document fields, §3 of master prompt)
    $('q-snippet').hidden = !current.code_snippet;
    if (current.code_snippet) $('q-snippet-pre').textContent = current.code_snippet;
    $('q-sample').hidden = !(current.sample_input || current.sample_output || current.constraints);
    if (current.sample_input) $('q-sample-in').textContent = current.sample_input;
    if (current.sample_output) $('q-sample-out').textContent = current.sample_output;
    $('q-constraints').textContent = current.constraints || '';

    const isMCQ = current.type === 'mcq' && current.options;
    $('q-options').innerHTML = '';

    // flush any pending autosave for the previous question before switching
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }

    if (isMCQ) {
      current.options.forEach((o, idx) => {
        const label = document.createElement('label');
        label.style.cssText = 'text-transform:none;font-weight:normal;display:flex;gap:8px;align-items:center';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'mcq';
        radio.value = o;
        radio.style.width = 'auto';
        label.appendChild(radio);
        label.appendChild(document.createTextNode(`${String.fromCharCode(65 + idx)}) ${o}`));
        $('q-options').appendChild(label);
      });
      $('editor-host').style.display = 'none';
      $('lang-label').style.display = 'none';
      $('lang-select').style.display = 'none';
      $('stdin-label').style.display = 'none';
      $('stdin-input').style.display = 'none';
      $('run-btn').hidden = true;
      if (hasCM()) cm.getWrapperElement().style.display = 'none';
      else ta.style.display = 'none';
      $('answer').style.display = 'none';
    } else {
      $('editor-host').style.display = '';
      $('lang-label').style.display = '';
      $('lang-select').style.display = '';
      if (hasCM()) {
        cm.getWrapperElement().style.display = '';
        ta.style.display = 'none'; // textarea stays hidden; CM syncs on submit
      } else {
        ta.style.display = '';
      }
      const langs = current.languages || [];
      const sel = $('lang-select');
      sel.innerHTML = '';
      if (langs.length === 0) sel.appendChild(new Option('—', ''));
      else langs.forEach((l) => sel.appendChild(new Option(l.toUpperCase(), l)));
      setLangMode(langs[0] || 'python');
      updateRunVisibility();
    }

    // submission state / drafts
    if (current.submission && current.submission.status === 'graded') {
      if (isMCQ) {
        const radios = document.querySelectorAll('input[name="mcq"]');
        radios.forEach((r) => { r.disabled = true; });
      } else {
        setEditorValue(current.starter_code || '');
      }
      $('result').innerHTML = `Submitted ${csEsc(current.submission.submittedAt)} — <strong>${current.submission.correct ? 'Correct' : 'Incorrect'}</strong>, awarded ${current.submission.awarded} marks.`;
      $('submit-btn').disabled = true;
      $('save-btn').disabled = true;
      $('hint-btn').disabled = true;
    } else {
      $('result').textContent = '';
      $('submit-btn').disabled = false;
      $('save-btn').disabled = false;
      $('hint-btn').disabled = false;
      loadDraft();
    }

    if (current.hintUsed) { $('hint-btn').disabled = true; $('hint-btn').textContent = 'Hint used'; }
    else { $('hint-btn').textContent = 'Hint'; }
  }

  function getAnswer() {
    if (current.type === 'mcq' && current.options) {
      const r = document.querySelector('input[name="mcq"]:checked');
      return r ? r.value : '';
    }
    return getEditorValue();
  }

  async function loadDraft() {
    try {
      const d = await csApi(`/api/drafts/${current.id}`);
      if (d.content) {
        if (current.type === 'mcq' && current.options) {
          const radios = document.querySelectorAll('input[name="mcq"]');
          radios.forEach((r) => { if (r.value === d.content) r.checked = true; });
        } else {
          setEditorValue(d.content);
        }
      } else if (current.type !== 'mcq') {
        setEditorValue(current.starter_code || '');
      }
    } catch { /* no draft yet */ }
  }

  // Debounced autosave (1.2 s after typing stops, or on question switch).
  async function saveDraft(silent = true) {
    if (!current || (current.submission && current.submission.status === 'graded')) return;
    try {
      await csApi(`/api/questions/${current.id}/draft`, { method: 'PUT', body: { content: getEditorValue() } });
      if (!silent) csToast('Draft saved', 'ok');
    } catch (e) { if (!silent) csToast(e.message, 'err'); }
  }
  function scheduleAutosave() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveDraft(true), 1200);
  }
  if (cm) cm.on('change', scheduleAutosave);
  else ta.addEventListener('input', scheduleAutosave);
  // clear the indicator timer when leaving the page
  window.addEventListener('beforeunload', () => { if (draftTimer) clearTimeout(draftTimer); });

  $('lang-select').onchange = () => setLangMode($('lang-select').value);
  $('save-btn').onclick = () => saveDraft(false);

  // ---- Run button: execute code server-side, show stdout/stderr ----
  let runtimes = null;
  csApi('/api/runtimes').then((r) => {
    runtimes = r;
    if (Object.values(r).some((x) => x.available)) $('run-btn').hidden = false;
  }).catch(() => {});

  $('run-btn').onclick = async () => {
    const outPanel = $('output-panel');
    const outPre = $('output-pre');
    outPanel.hidden = false;
    outPre.textContent = 'Running…';
    $('run-btn').disabled = true;
    try {
      const r = await csApi('/api/run', {
        method: 'POST',
        body: {
          questionId: current.id,
          language: $('lang-select').value,
          code: getEditorValue(),
          stdin: $('stdin-input').value,
        },
      });
      let text = '';
      if (r.stdout) text += r.stdout;
      if (r.stderr) text += (text ? '\n' : '') + '[stderr] ' + r.stderr;
      if (!text) text = '(no output)';
      outPre.textContent = text;
    } catch (e) {
      outPanel.hidden = false;
      outPre.textContent = e.message;
    } finally {
      $('run-btn').disabled = false;
    }
  };

  function updateRunVisibility() {
    if (!runtimes) return;
    const lang = $('lang-select').value;
    const ok = runtimes[lang] && runtimes[lang].available;
    $('run-btn').hidden = !ok;
    $('stdin-label').style.display = ok ? '' : 'none';
    $('stdin-input').style.display = ok ? '' : 'none';
  }
  $('lang-select').addEventListener('change', updateRunVisibility);

  $('submit-btn').onclick = async () => {
    const content = getAnswer();
    if (!content.trim()) { csToast('Answer is empty', 'err'); return; }
    if (current.type !== 'mcq' && !confirm('Submit your answer? You cannot resubmit.')) return;
    try {
      await saveDraft(true);
      const r = await csApi(`/api/questions/${current.id}/submit`, {
        method: 'POST',
        body: { content, language: $('lang-select').value || null },
      });
      $('result').innerHTML = `Result: <strong>${r.correct ? 'Correct' : 'Incorrect'}</strong> — awarded <strong>${r.awarded}</strong> marks. ${csEsc(r.feedback)}`;
      csToast(r.correct ? `Correct! +${r.awarded} marks` : 'Submitted — incorrect', r.correct ? 'ok' : 'err');
      const i = questions.findIndex((q) => q.id === current.id);
      await load();
      select(Math.min(i + 1, questions.length - 1));
    } catch (e) { csToast(e.message, 'err'); }
  };

  $('hint-btn').onclick = () => {
    $('hint-penalty').textContent = current.hint_penalty || 0;
    $('hint-dialog').showModal();
  };
  $('hint-cancel').onclick = () => $('hint-dialog').close();
  $('hint-confirm').onclick = async () => {
    $('hint-dialog').close();
    try {
      const r = await csApi(`/api/questions/${current.id}/hint`, { method: 'POST', body: {} });
      $('result').innerHTML = `Hint: ${csEsc(r.hint)} ${r.penalty ? `<em>(−${r.penalty} marks)</em>` : ''}`;
      $('hint-btn').disabled = true;
      $('hint-btn').textContent = 'Hint used';
    } catch (e) { csToast(e.message, 'err'); }
  };

  function showEliminatedScreen() {
    if (document.getElementById('elim-screen')) return;
    const el = document.createElement('div');
    el.id = 'elim-screen';
    el.setAttribute('style', 'position:fixed;inset:0;z-index:1002;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px');
    el.innerHTML = `<div class="badge badge-live" style="font-size:14px">ELIMINATED</div>` +
      `<h2 style="font-size:24px">Your team has been eliminated</h2>` +
      `<p class="muted" style="max-width:460px">You left the competition window more than the allowed number of times.<br>` +
      `A judge can reinstate your team from the judge dashboard.</p>`;
    document.body.appendChild(el);
    document.getElementById('fs-gate')?.remove();
  }

  function showStatusScreen(status) {
    const id = 'status-screen';
    if (status !== 'stopped' && status !== 'disqualified') { document.getElementById(id)?.remove(); return; }
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('style', 'position:fixed;inset:0;z-index:1001;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px');
      document.body.appendChild(el);
    }
    el.innerHTML = status === 'stopped'
      ? `<div class="badge" style="font-size:14px">⏸ PAUSED BY JUDGE</div>` +
        `<h2 style="font-size:24px">Your team is paused</h2>` +
        `<p class="muted" style="max-width:460px">A judge has stopped your team temporarily. Your work is saved.<br>This screen clears automatically when a judge resumes your team.</p>`
      : `<div class="badge badge-live" style="font-size:14px">DISQUALIFIED</div>` +
        `<h2 style="font-size:24px">Your team has been disqualified</h2>` +
        `<p class="muted" style="max-width:460px">A judge has disqualified your team from the competition.<br>Contact the judges if you believe this is a mistake.</p>`;
  }

  // Tab-switch monitoring with attempts + elimination.
  let hiddenAt = null;
  let tabState = { count: 0, limit: 3, eliminated: false };
  async function refreshTabState() {
    try {
      const me = await csApi('/api/me');
      tabState.count = me.tabEvents; tabState.limit = me.tabSwitchLimit;
      tabState.eliminated = me.eliminated;
      updateAttemptsBadge();
      if (me.eliminated) showEliminatedScreen();
      else if (me.status && me.status !== 'active') showStatusScreen(me.status);
      else showStatusScreen('active');
    } catch { /* offline */ }
  }
  function updateAttemptsBadge() {
    let b = document.getElementById('attempts-badge');
    if (!b) {
      b = document.createElement('span');
      b.id = 'attempts-badge';
      b.className = 'badge';
      const bar = document.querySelector('.topbar .statusline');
      if (bar) bar.insertBefore(b, bar.firstChild);
      else document.querySelector('.topbar .container').appendChild(b);
    }
    const remaining = Math.max(0, tabState.limit - tabState.count);
    b.textContent = `Window switches: ${tabState.count}/${tabState.limit} (${remaining} left)`;
    b.className = 'badge' + (remaining === 0 ? ' badge-live' : remaining === 1 ? ' badge-live' : '');
    b.title = 'Leaving the fullscreen competition window uses an attempt. Attempt limit reached = elimination.';
  }
  document.addEventListener('visibilitychange', () => {
    const now = new Date().toISOString();
    if (document.hidden) { hiddenAt = now; }
    else if (hiddenAt) {
      csApi('/api/monitor/tab-event', { method: 'POST', body: { leftAt: hiddenAt, returnedAt: now } })
        .then((r) => {
          if (r.eliminated) {
            tabState.eliminated = true;
            showEliminatedScreen();
            return;
          }
          tabState.count = r.count; tabState.limit = r.limit;
          updateAttemptsBadge();
          if (r.count === r.limit - 1) csToast(`FINAL WARNING: ${r.count}/${r.limit} window switches — one more and your team is eliminated`, 'err');
          else csToast(`Window switch recorded: ${r.count}/${r.limit}`, 'err');
          hiddenAt = null;
        })
        .catch((e) => {
          if (/Eliminated/i.test(e.message)) { showEliminatedScreen(); }
          hiddenAt = null;
        });
    }
  });
  refreshTabState();

  // Server clock
  let deadline = null;
  function tick() {
    if (window.__csTimerHolds) return; // host round timer owns the clock this tick
    if (deadline) $('clock').textContent = csFmtClock(Math.max(0, deadline - Date.now()));
    else $('clock').textContent = new Date().toLocaleTimeString();
  }
  const socket = typeof io === 'function' ? io() : null;
  if (socket) {
    socket.on('phase', (p) => { deadline = Date.parse(p.deadline); tick(); });
    lockSocket = socket;
    socket.on('eliminated', () => { showEliminatedScreen(); });
    socket.on('team status', (d) => {
      showStatusScreen(d.status);
      if (d.reinstated) { document.getElementById('elim-screen')?.remove(); document.getElementById('status-screen')?.remove(); location.reload(); }
    });
  }
  csApi('/api/status').then((p) => { deadline = Date.parse(p.deadline); tick(); }).catch(() => {});
  setInterval(tick, 500);
  setInterval(refreshTabState, 15000);

  load();
})();
