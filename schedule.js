'use strict';
/**
 * CODE SPRINT — schedule engine.
 * Server-controlled phases. Times are stored in settings as ISO strings (UTC).
 *
 * Settings keys (set by admin CLI or judge dashboard):
 *   competition.date     YYYY-MM-DD local event date (default: today)
 *   schedule.r1_start    local HH:MM (default 10:00)
 *   schedule.r2_start    local HH:MM (default 13:00)
 *   schedule.r3_start    local HH:MM (default 15:00)
 *   schedule.r1_minutes  default 120
 *   schedule.r2_minutes  default 120
 *   schedule.r3_minutes  default 60
 *   monitor.tab_threshold  tab switches allowed before auto-elimination (default 3)
 *   hints.enabled        "1" default
 */
const { getDb } = require('./db');

// Phase machine: order and derivation of deadlines from settings.
const PHASES = [
  { key: 'not_started', label: 'Not Started' },
  { key: 'round1', label: 'Round 1 — Logic Quest', doc: '10:00 AM – 12:00 PM' },
  { key: 'lunch', label: 'Lunch Lock', doc: '12:00 PM – 1:00 PM' },
  { key: 'round2', label: 'Round 2 — Code Arena', doc: '1:00 PM – 3:00 PM' },
  { key: 'round3', label: 'Round 3 — Debug Lab', doc: '3:00 PM – 4:00 PM' },
  { key: 'finished', label: 'Finished — submissions closed' },
];

function getSetting(key, fallback) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  return row.value;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function allSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Build local Date from event date (YYYY-MM-DD) + HH:MM on host timezone. */
function localDateTime(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** Compute concrete UTC instants for every boundary. */
function computeSchedule(now = new Date()) {
  const dateStr = getSetting('competition.date', localDate(now));
  const r1Min = Number(getSetting('schedule.r1_minutes', '120'));
  const r2Min = Number(getSetting('schedule.r2_minutes', '120'));
  const r3Min = Number(getSetting('schedule.r3_minutes', '60'));
  const DAY = 24 * 3600000;
  // Round-1 start anchors the timeline: nearest occurrence of the r1_start wall
  // time relative to `now` (today, or yesterday when running past midnight),
  // constrained to the configured competition date and at most one day behind
  // `now`. Later boundaries roll FORWARD only via nextAtOr().
  const anchorWall = getSetting('schedule.r1_start', '10:00');
  const [ah, am] = anchorWall.split(':').map(Number);
  const onDate = localDateTime(dateStr, anchorWall);        // wall time on event date
  const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ah, am, 0, 0);
  const yesterdayAt = new Date(todayAt.getTime() - DAY);
  let r1Start;
  // "Running past midnight" catch applies ONLY when the configured event date
  // is yesterday (server kept running after midnight of the event). Otherwise:
  // future date → planned start (Not Started once now < r1_start); event date
  // reached → normal timeline; past date → that day's timeline (→ finished).
  const isYesterday = dateStr === localDate(yesterdayAt);
  if (now.getTime() >= onDate.getTime()) r1Start = onDate;          // event date reached
  else if (isYesterday && now.getTime() >= yesterdayAt.getTime()) r1Start = yesterdayAt; // running past midnight
  else r1Start = onDate;                                            // future date: planned start
  function nextAtOr(after, wall) {
    // wall: {hours, minutes} desired wall-clock time following `after`.
    let cand = new Date(after.getFullYear(), after.getMonth(), after.getDate(), wall.hours, wall.minutes, 0, 0);
    if (cand.getTime() < after.getTime()) cand = new Date(cand.getTime() + DAY);
    return cand;
  }
  const wallOf = (key, fallback) => {
    const v = getSetting(key, fallback);
    const [h, m] = String(v).split(':').map(Number);
    return { hours: h, minutes: m };
  };
  const r2Wall = wallOf('schedule.r2_start', '13:00');
  const r3Wall = wallOf('schedule.r3_start', '15:00');

  const r1EndBase = new Date(r1Start.getTime() + r1Min * 60000);   // duration only
  const r2StartEff = nextAtOr(r1EndBase, r2Wall);                  // R2 never before R1 ends
  const r2EndByDuration = new Date(r2StartEff.getTime() + r2Min * 60000);
  const r3StartEffective = nextAtOr(r2EndByDuration, r3Wall);      // R3 never before R2 ends
  const r3End = new Date(r3StartEffective.getTime() + r3Min * 60000);
  const r1End = r1EndBase <= r2StartEff ? r1EndBase : r2StartEff;

  return {
    date: dateStr,
    boundaries: {
      r1_start: r1Start, r1_end: r1End,
      lunch_start: r1End, lunch_end: r2StartEff,
      r2_start: r2StartEff, r2_end: r2EndByDuration <= r3StartEffective ? r2EndByDuration : r3StartEffective,
      r3_start: r3StartEffective, r3_end: r3End,
    },
    conflicts: buildConflicts({ r1EndBase, r2StartEff, r2EndByDuration, r3StartEffective }),
  };
}

function buildConflicts({ r1EndBase, r2StartEff, r2EndByDuration, r3StartEffective }) {
  const c = [];
  const hm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (r1EndBase.getTime() !== r2StartEff.getTime()) {
    c.push(`Round 1 duration (${getSetting('schedule.r1_minutes', '120')} min from ${getSetting('schedule.r1_start', '10:00')}) would end at ${hm(r1EndBase)} but Round 2 is scheduled to start at ${getSetting('schedule.r2_start', '13:00')}. Lunch length adapts to the gap.`);
  }
  if (r2EndByDuration.getTime() !== r3StartEffective.getTime()) {
    c.push(`Round 2 duration (${getSetting('schedule.r2_minutes', '120')} min from ${getSetting('schedule.r2_start', '13:00')}) would end at ${hm(r2EndByDuration)} but Round 3 is scheduled to start at ${getSetting('schedule.r3_start', '15:00')}.`);
  }
  return c;
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Current phase + ms remaining, from server clock. */
function currentPhase(now = new Date()) {
  const s = computeSchedule(now);
  const b = s.boundaries;
  const t = now.getTime();
  let phase, deadline;
  if (t < b.r1_start.getTime()) { phase = 'not_started'; deadline = b.r1_start; }
  else if (t < b.r1_end.getTime()) { phase = 'round1'; deadline = b.r1_end; }
  else if (t < b.r2_start.getTime()) { phase = 'lunch'; deadline = b.r2_start; }
  else if (t < b.r2_end.getTime()) { phase = 'round2'; deadline = b.r2_end; }
  else if (t < b.r3_end.getTime()) { phase = 'round3'; deadline = b.r3_end; }
  else { phase = 'finished'; deadline = b.r3_end; }
  return {
    phase,
    phaseLabel: PHASES.find((p) => p.key === phase).label,
    deadline: deadline.toISOString(),
    msRemaining: Math.max(0, deadline.getTime() - t),
    serverTime: now.toISOString(),
    schedule: {
      boundaries: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toISOString()])),
      conflicts: s.conflicts,
    },
  };
}

/** Is submission open for a given round key right now? */
function submissionOpen(roundKey, now = new Date()) {
  const cp = currentPhase(now);
  return cp.phase === roundKey;
}

module.exports = { PHASES, getSetting, setSetting, allSettings, computeSchedule, currentPhase, submissionOpen, localDate, localDateTime };
