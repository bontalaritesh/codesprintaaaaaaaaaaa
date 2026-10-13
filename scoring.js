'use strict';
/**
 * CODE SPRINT — scoring & leaderboard.
 * Score = sum of awarded submission marks + score adjustments − hint penalties.
 * Tie-breaking (documented, deterministic):
 *   1. Higher total score wins.
 *   2. If tied: earlier time of the FIRST correct submission that contributed marks wins.
 *   3. If still tied: lexicographically smaller team ID wins.
 */
const { getDb } = require('./db');

/** Compute score components for one account. */
function scoreFor(accountId) {
  const db = getDb();
  const subs = db.prepare(`
    SELECT COALESCE(SUM(s.awarded_marks), 0) AS marks, MIN(CASE WHEN s.is_correct = 1 THEN s.submitted_at END) AS first_correct
    FROM submissions s WHERE s.account_id = ? AND s.status = 'graded'`).get(accountId);
  const hints = db.prepare('SELECT COALESCE(SUM(penalty_applied), 0) AS p FROM hint_usage WHERE account_id = ?').get(accountId);
  const adj = db.prepare('SELECT COALESCE(SUM(delta), 0) AS d FROM score_adjustments WHERE account_id = ?').get(accountId);
  const marks = subs.marks || 0;
  return {
    submissionMarks: marks,
    hintPenalty: hints.p || 0,
    adjustments: adj.d || 0,
    total: marks - (hints.p || 0) + (adj.d || 0),
    firstCorrect: subs.first_correct || null,
  };
}

/** Full standings: array of {accountId, username, teamName, total, ...}, rank assigned. */
function standings() {
  const db = getDb();
  const teams = db.prepare("SELECT id, username, team_name, status, eliminated FROM accounts WHERE role = 'team'").all();
  const rows = teams.map((t) => {
    const s = scoreFor(t.id);
    return { accountId: t.id, username: t.username, teamName: t.team_name || t.username, status: t.status || 'active', eliminated: !!t.eliminated, ...s };
  });
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    // tie-break 2: earlier first correct submission
    const ta = a.firstCorrect ? Date.parse(a.firstCorrect) : Infinity;
    const tb = b.firstCorrect ? Date.parse(b.firstCorrect) : Infinity;
    if (ta !== tb) return ta - tb;
    // tie-break 3: team id lexicographic
    return a.username < b.username ? -1 : 1;
  });
  // competition ranking (1,2,2,4)
  let lastTotal = null, lastRank = 0;
  rows.forEach((r, i) => {
    if (r.total !== lastTotal) { lastRank = i + 1; lastTotal = r.total; }
    r.rank = lastRank;
  });
  return rows;
}

function progressFor(accountId) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS c FROM questions').get().c;
  const done = db.prepare("SELECT COUNT(DISTINCT question_id) AS c FROM submissions WHERE account_id = ? AND status = 'graded'").get(accountId).c;
  return { answered: done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

module.exports = { scoreFor, standings, progressFor };
