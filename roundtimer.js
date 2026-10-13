'use strict';
/**
 * CODE SPRINT — host-controlled round timer engine.
 *
 * The SERVER is the single authority for timer state (master prompt §5):
 * remaining time is derived from persisted timestamps, never by counting
 * seconds in the browser. All host commands go through transition() which
 * validates the lifecycle and persists every state change.
 *
 * Lifecycle (master prompt §2):
 *   READY ──▶ RUNNING            host START
 *   RUNNING ⇄ PAUSED             host PAUSE / RESUME
 *   RUNNING | PAUSED ──▶ STOPPED host STOP (freezes remaining; round intact)
 *   STOPPED ──▶ RUNNING          host START (explicit restart policy)
 *   RUNNING | PAUSED | STOPPED ──▶ READY     host RESET (confirm required)
 *   RUNNING ──▶ EXPIRED          countdown reached 0 naturally (once)
 *   READY | RUNNING | PAUSED | STOPPED | EXPIRED ──▶ ENDED  host END ROUND
 *
 * Reconciliation for clients: state + remainingAt = authoritative remaining
 * milliseconds (running timers re-derive from serverNow on read).
 */
const { getDb } = require('./db');

const STATES = ['ready', 'running', 'paused', 'stopped', 'expired', 'ended'];

// transition[from] = Set of allowed targets
const TRANSITIONS = {
  ready:   new Set(['running', 'ended']),
  running: new Set(['running', 'paused', 'stopped', 'ready', 'expired', 'ended']),
  paused:  new Set(['running', 'stopped', 'ready', 'ended']),
  stopped: new Set(['running', 'ready', 'ended']),
  expired: new Set(['ready', 'ended']),
  ended:   new Set([]),
};

const ACTIONS = {
  start:  { from: ['ready', 'stopped'],        to: 'running' },
  pause:  { from: ['running'],                 to: 'paused' },
  resume: { from: ['paused'],                  to: 'running' },
  stop:   { from: ['running', 'paused'],       to: 'stopped' },
  reset:  { from: ['running', 'paused', 'stopped', 'expired', 'ready'], to: 'ready' },
  end:    { from: ['ready', 'running', 'paused', 'stopped', 'expired'], to: 'ended' },
  extend: { from: ['running', 'paused', 'stopped'],           to: null }, // host-only; state-preserving
};

function normalizeState(s) { return STATES.includes(s) ? s : null; }

function getTimer(roundKey) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM round_timers WHERE round_key = ?').get(roundKey);
  if (!row) {
    db.prepare(`INSERT INTO round_timers (round_key, state, duration_ms, remaining_ms, payload) VALUES (?, 'ready', ?, ?, '{}')`)
      .run(roundKey, 30 * 60000, 30 * 60000);
    row = db.prepare('SELECT * FROM round_timers WHERE round_key = ?').get(roundKey);
  }
  return row;
}

/**(ms since epoch like Date.now()); monotonic measurement helper. */
function nowMs() { return Date.now(); }

/** Compute the authoritative snapshot for a client. */
function snapshot(roundKey) {
  const t = getTimer(roundKey);
  const now = nowMs();
  let remaining = t.remaining_ms;
  if (t.state === 'running') {
    remaining = Math.max(0, DateTime(t).remaining);
    if (remaining <= 0) {
      // Natural expiry handled by the server's expiry sweeper; snapshot
      // reports the authoritative frozen value without mutating here.
    }
  }
  return {
    eventId: `timer-${t.round_key}-v${t.version}`,
    round: t.round_key,
    stage: t.stage_key || null,
    questionKey: t.stage_key || null,
    state: t.state,
    durationMs: t.duration_ms,
    remainingMs: remaining,
    serverNow: now,
    version: t.version,
    lastAction: t.last_action,
    lastActor: t.last_actor,
    lastActionAt: t.last_action_at,
    payload: JSON.parse(t.payload || '{}'),
  };
}

/** Derives remaining ms for a running timer from persisted timestamps.
 * started_at is the epoch anchor of the current running segment; the segment
 * never accumulates across freezes because remaining_ms is rewritten to the
 * exact frozen value on pause/stop/end. remaining = remainingAtStart - elapsed. */
function DateTime(t) {
  if (t.state !== 'running' || !t.started_at || t.remaining_at_start_ms == null) return { remaining: t.remaining_ms };
  const elapsed = Math.max(0, nowMs() - t.started_at);
  return { remaining: Math.max(0, t.remaining_at_start_ms - elapsed) };
}

/**
 * Apply a host action. Throws { status, error } on invalid transition or
 * wrong version (optimistic concurrency for duplicate/stale commands).
 * `options.extendMs` (milliseconds) is required for the `extend` action.
 */
function transition(roundKey, action, { actor, expectedVersion, extendMs } = {}) {
  const db = getDb();
  const t = getTimer(roundKey);
  const a = ACTIONS[action];
  if (!a) throw { status: 400, error: `Unknown action "${action}"` };
  const cur = normalizeState(t.state);
  if (!a.from.includes(cur)) {
    throw { status: 409, error: `Cannot ${action} ${/^[aeiou]/.test(cur) ? 'an' : 'a'} ${cur} timer` };
  }
  if (cur === 'expired' && action !== 'reset' && action !== 'end') {
    throw { status: 409, error: `Expired timers only support reset or end` };
  }
  // READY before ENDED for expired timers
  if (expectedVersion !== undefined && Number(expectedVersion) !== t.version) {
    throw { status: 409, error: `Stale command (client v${expectedVersion} vs server v${t.version}) — refresh and retry` };
  }

  const now = nowMs();
  let remaining = t.remaining_ms;
  let startedAt = t.started_at;
  let remainingAtStart = t.remaining_at_start_ms;

  switch (action) {
    case 'start': {
      remainingAtStart = t.remaining_ms;
      startedAt = now;
      break;
    }
    case 'pause': {
      // freeze: rewrite remaining to exact remaining now, clear anchor
      const { remaining: rem } = DateTime(t);
      remaining = rem;
      startedAt = null;
      remainingAtStart = null;
      break;
    }
    case 'resume': // continues from frozen remaining
    case 'stop': {
      const { remaining: rem } = action === 'stop' ? DateTime(t) : { remaining: t.remaining_ms };
      remaining = rem;
      startedAt = action === 'resume' ? now : null;
      remainingAtStart = action === 'resume' ? t.remaining_ms : null;
      break;
    }
    case 'reset': {
      remaining = t.duration_ms;
      startedAt = null;
      remainingAtStart = null;
      break;
    }
    case 'end': {
      const { remaining: rem } = DateTime(t);
      remaining = rem;
      startedAt = null;
      remainingAtStart = null;
      break;
    }
    case 'extend': { // authorized host-only; never automatic
      if (!Number.isInteger(extendMs) || extendMs <= 0 || extendMs > 4 * 3600000) {
        throw { status: 400, error: 'Extension must be within 1ms..4h, in milliseconds' };
      }
      if (cur === 'running') {
        // Anchor stays put; the REMAINING at anchor grows, so the clock gains time.
        remainingAtStart = (t.remaining_at_start_ms ?? t.remaining_ms) + extendMs;
        startedAt = t.started_at;
        remaining = Math.max(0, remainingAtStart - (nowMs() - t.started_at));
      } else {
        // paused/stopped: the frozen remaining grows.
        remaining = t.remaining_ms + extendMs;
        startedAt = null;
        remainingAtStart = null;
      }
      break;
    }
  }

  // extend keeps the current lifecycle state (never starts/stops the clock)
  let newState = a.to === null ? cur : a.to;
  if (newState === 'running' && remaining <= 0) {
    // Zero-duration start: treat as instant expiry (avoid negative loops).
    newState = 'expired';
    remaining = 0;
    startedAt = null;
  }

  const version = t.version + 1;
  // NOTE: bind list MUST match the placeholder count exactly — node:sqlite
  // silently binds missing args as NULL (which here would make the WHERE
  // clause match zero rows: state changes "succeeding" in the response but
  // never persisting). Placeholders: state, remaining_ms, started_at,
  // remaining_at_start_ms, version, last_action, last_actor, stage_key,
  // payload, round_key.
  const updated = db.prepare(`UPDATE round_timers SET state = ?, remaining_ms = ?, started_at = ?, remaining_at_start_ms = ?,
      version = ?, last_action = ?, last_actor = ?, last_action_at = datetime('now'), stage_key = ?,
      payload = ?  WHERE round_key = ? AND state = ?`)
    .run(newState, remaining, startedAt, remainingAtStart, version, action, actor || 'host',
         t.stage_key, JSON.stringify({ by: actor || 'host', action, at: now }), roundKey, cur);
  if (updated.changes === 0) {
    // Concurrent command raced us (state moved after our read) — reject as stale.
    throw { status: 409, error: `Timer changed concurrently — refresh and retry` };
  }
  return { ...snapshot(roundKey), state: newState };
}

/** Host sets the configured duration (before start, or on reset screen). */
function setDuration(roundKey, ms, { actor } = {}) {
  const db = getDb();
  const t = getTimer(roundKey);
  if (!Number.isFinite(ms) || ms < 0 || ms > 24 * 3600000) throw { status: 400, error: 'Duration must be 0..24h in ms' };
  if (t.state === 'running' || t.state === 'paused') {
    throw { status: 409, error: 'Pause or stop the timer before changing duration' };
  }
  db.prepare(`UPDATE round_timers SET duration_ms = ?, remaining_ms = ?, version = version + 1,
    last_action = 'set_duration', last_actor = ? WHERE round_key = ?`).run(Math.round(ms), Math.round(ms), actor || 'host', roundKey);
  return snapshot(roundKey);
}

/** Attach the currently displayed stage/question to timer broadcasts. */
function setStage(roundKey, stageKey) {
  const db = getDb();
  db.prepare('UPDATE round_timers SET stage_key = ? WHERE round_key = ?').run(stageKey || null, roundKey);
}

/** Recover after a server crash: running timers KEEP their wall-clock anchor
 * (remaining -= downtime) per the no-free-time recovery policy; the sweeper
 * expires any timer whose remaining has run out during downtime. */
function recoverUptime() {
  const db = getDb();
  const rows = db.prepare("SELECT round_key, state, started_at, remaining_at_start_ms FROM round_timers WHERE state = 'running'").all();
  let expiredDuringDowntime = 0;
  for (const row of rows) {
    const { remaining } = DateTime(row);
    if (remaining <= 0) {
      db.prepare(`UPDATE round_timers SET state = 'expired', remaining_ms = 0, started_at = NULL, remaining_at_start_ms = NULL, version = version + 1,
        last_action = 'expired_recovery' WHERE round_key = ? AND state = 'running'`).run(row.round_key);
      expiredDuringDowntime++;
    }
  }
  return { checked: rows.length, expiredDuringDowntime };
}

/** Background sweeper: RUNNING → EXPIRED exactly once (server-side). */
function sweepExpired() {
  const db = getDb();
  // NOTE: `state` MUST be selected — DateTime() gates on it (a narrower SELECT
  // leaves t.state undefined → remaining NaN → `NaN <= 0` never fires and
  // running timers would never expire).
  const rows = db.prepare("SELECT round_key, state, started_at, remaining_at_start_ms FROM round_timers WHERE state = 'running'").all();
  const expired = [];
  for (const t of rows) {
    const { remaining } = DateTime(t);
    if (remaining <= 0) {
      db.prepare(`UPDATE round_timers SET state = 'expired', remaining_ms = 0, started_at = NULL, remaining_at_start_ms = NULL, version = version + 1,
        last_action = 'expired', last_action_at = datetime('now') WHERE round_key = ? AND state = 'running'`).run(t.round_key);
      expired.push(t.round_key);
    }
  }
  return expired;
}

module.exports = { STATES, TRANSITIONS, ACTIONS, getTimer, snapshot, transition, setDuration, setStage, recoverUptime, sweepExpired };
