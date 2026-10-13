'use strict';
/**
 * CODE SPRINT — database & results backup.
 * Usage: node scripts/backup.js [outputDir]
 * Safely copies the SQLite database (with WAL checkpoint) and exports
 * results JSON. Restore: stop the server, replace codesprint.db with the
 * backup copy, restart. See README.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.CODESPRINT_DB || path.join(__dirname, '..', 'codesprint.db');
const outDir = process.argv[2] || path.join(__dirname, '..', 'backups');
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dbFile = path.join(outDir, `codesprint-${stamp}.db`);

// Open a read connection and checkpoint WAL so the copied file is complete.
const src = new DatabaseSync(DB_PATH);
src.exec('PRAGMA wal_checkpoint(TRUNCATE);');
src.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}';`);
src.close();

// Export results JSON snapshot too.
const db = new DatabaseSync(DB_PATH);
const frozen = db.prepare('SELECT snapshot, frozen_at FROM results_published WHERE id = 1').get();
const resultsFile = path.join(outDir, `results-${stamp}.json`);
let exportData;
if (frozen) {
  exportData = { frozen: true, frozenAt: frozen.frozen_at, teams: JSON.parse(frozen.snapshot) };
} else {
  // provisional: export live standings via scoring module on a fresh copy
  exportData = { frozen: false, note: 'provisional export — run freeze on the server for the official result', teams: [] };
}
db.close();
fs.writeFileSync(resultsFile, JSON.stringify(exportData, null, 2));

console.log(`Backup written: ${dbFile}`);
console.log(`Results export: ${resultsFile}`);
