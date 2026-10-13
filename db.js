'use strict';
/**
 * CODE SPRINT — SQLite layer.
 * Uses node:sqlite (Node 22.5+, stable in Node 24). No external DB dependency.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.CODESPRINT_DB || path.join(__dirname, 'codesprint.db');

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d) {
  migrate2(d);
  // Column additions for existing databases (safe to re-run; tables now exist).
  const addCols = (table, defs) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [col, ddl] of defs) if (!cols.includes(col)) d.exec(ddl);
  };
  addCols('accounts', [
    ['eliminated', "ALTER TABLE accounts ADD COLUMN eliminated INTEGER NOT NULL DEFAULT 0"],
    ['eliminated_at', "ALTER TABLE accounts ADD COLUMN eliminated_at TEXT"],
    ['status', "ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"],
  ]);
  // Question-bank management columns (master prompt §6): additive, nullable.
  addCols('questions', [
    ['difficulty', "ALTER TABLE questions ADD COLUMN difficulty TEXT"],
    ['topic', "ALTER TABLE questions ADD COLUMN topic TEXT"],
    ['code_snippet', "ALTER TABLE questions ADD COLUMN code_snippet TEXT"],
    ['sample_input', "ALTER TABLE questions ADD COLUMN sample_input TEXT"],
    ['sample_output', "ALTER TABLE questions ADD COLUMN sample_output TEXT"],
    ['constraints', "ALTER TABLE questions ADD COLUMN constraints TEXT"],
    ['explanation', "ALTER TABLE questions ADD COLUMN explanation TEXT"],
    ['answer_reveal_policy', "ALTER TABLE questions ADD COLUMN answer_reveal_policy TEXT NOT NULL DEFAULT 'round_default'"],
    ['publication_status', "ALTER TABLE questions ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'approved'"],
    ['source_ref', "ALTER TABLE questions ADD COLUMN source_ref TEXT"],
    ['review_status', "ALTER TABLE questions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'verified'"],
    ['review_note', "ALTER TABLE questions ADD COLUMN review_note TEXT"],
    ['enabled', "ALTER TABLE questions ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"],
    ['archived', "ALTER TABLE questions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"],
    ['revision', "ALTER TABLE questions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"],
    ['updated_at', "ALTER TABLE questions ADD COLUMN updated_at TEXT"],
  ]);
}

function migrate2(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('team','judge','admin')),
    team_name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','disqualified')),
    eliminated INTEGER NOT NULL DEFAULT 0,
    eliminated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    stage_keys TEXT NOT NULL,        -- JSON array of stage keys in order
    auto_advance INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_key TEXT NOT NULL UNIQUE,   -- stable key for idempotent re-import
    round_key TEXT NOT NULL,
    stage_key TEXT NOT NULL,
    order_num INTEGER NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    marks INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('mcq','short','code')),
    statement TEXT NOT NULL,
    options TEXT,              -- JSON array for MCQ
    answer TEXT NOT NULL,      -- canonical answer / required substring(s) JSON for code
    hint TEXT,
    hint_penalty INTEGER NOT NULL DEFAULT 0,
    languages TEXT,            -- JSON array, for code questions
    starter_code TEXT,
    UNIQUE (round_key, stage_key, order_num)
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES questions(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    content TEXT NOT NULL,
    language TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','graded','rejected')),
    awarded_marks INTEGER NOT NULL DEFAULT 0,
    is_correct INTEGER,
    feedback TEXT,
    late INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (question_id, account_id)      -- one graded submission per question per team
  );

  CREATE TABLE IF NOT EXISTS hint_usage (
    question_id INTEGER NOT NULL REFERENCES questions(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    penalty_applied INTEGER NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (question_id, account_id)
  );

  CREATE TABLE IF NOT EXISTS tab_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    left_at TEXT NOT NULL,
    returned_at TEXT,
    duration_s INTEGER,
    UNIQUE (account_id, left_at)
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,            -- e.g. 'tab_switch_threshold'
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','flagged')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    reason TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES accounts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cleared_at TEXT,
    cleared_by INTEGER REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS score_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES accounts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS results_published (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    frozen_at TEXT NOT NULL,
    published_by INTEGER NOT NULL REFERENCES accounts(id),
    snapshot TEXT NOT NULL,          -- JSON of final standings
    corrected INTEGER NOT NULL DEFAULT 0
  );

  -- Host-controlled round timers (authoritative state per round)
  CREATE TABLE IF NOT EXISTS round_timers (
    round_key TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','running','paused','stopped','expired','ended')),
    duration_ms INTEGER NOT NULL DEFAULT 1800000,
    remaining_ms INTEGER NOT NULL DEFAULT 1800000,
    started_at INTEGER,                 -- epoch ms anchor of the current running segment
    remaining_at_start_ms INTEGER,      -- remaining at anchor (running timers derive from these)
    stage_key TEXT,
    version INTEGER NOT NULL DEFAULT 1, -- monotonic state version (stale-command guard)
    last_action TEXT,
    last_actor TEXT,
    last_action_at TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Judge edit tracking (safe updates; seed skips judge-edited questions)
  CREATE TABLE IF NOT EXISTS question_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_key TEXT NOT NULL UNIQUE,
    edited_by INTEGER,
    edited_at TEXT NOT NULL DEFAULT (datetime('now')),
    summary TEXT
  );

  -- Version history for question content changes
  CREATE TABLE IF NOT EXISTS question_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES questions(id),
    actor TEXT,
    changes_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_account ON submissions(account_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_question ON submissions(question_id);
  CREATE INDEX IF NOT EXISTS idx_tab_events_account ON tab_events(account_id);
  `);
}

module.exports = { getDb, DB_PATH };
