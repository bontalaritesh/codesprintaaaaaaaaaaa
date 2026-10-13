# CODE SPRINT

A one-day college coding competition platform. Node.js + Express + SQLite
(`node:sqlite`, no external DB), vanilla JS frontend, Socket.IO live updates.
Built for ~36 teams on a college LAN, run from a single laptop.

## Quick start (Windows)

```
cd codesprint
npm install
node seed.js --admin-pass CHANGE_ME_admin --judge-pass CHANGE_ME_judge --teams 36
npm start
```

Open `http://localhost:3000`. For LAN access, use the host machine's IP:
`http://<host-ip>:3000` (allow port 3000 through Windows Firewall when prompted,
or: `netsh advfirewall firewall add rule name="CodeSprint" dir=in action=allow protocol=TCP localport=3000`).

## Default accounts

| Role   | Username  | Password (provisioned)          |
|--------|-----------|---------------------------------|
| Admin  | `admin`   | value of `--admin-pass` (default `admin123` — CHANGE IT) |
| Judge  | `judge`   | value of `--judge-pass` (default `judge123` — CHANGE IT) |
| Teams  | `team01`…`team36` | `sprint01`…`sprint36` — **change before the event** |

**Provisioning teams:** `node seed.js --teams N` creates `team01..teamNN`
(idempotent — existing accounts are never modified or duplicated). To give a
team a custom password, log in as admin and use the judge dashboard, or add
teams individually via `POST /api/judge/teams`. To create extra judge/admin
accounts: `POST /api/judge/accounts` (admin only).

To reset a team's password as admin (SQL, server stopped):

```
node -e "const {getDb}=require('./db');const {hashPassword}=require('./seed');const db=getDb();
db.prepare('UPDATE accounts SET password_hash=? WHERE username=?').run(hashPassword('NEWPASS'),'team07');"
```

## Competition schedule

Defaults reproduce the source document: Round 1 (Logic Quest) 10:00–12:00,
Lunch 12:00–13:00, Round 2 (Code Arena) 13:00–15:00, Round 3 (Debug Lab)
15:00–16:00, submissions close at 16:00.

Configure via **Judge dashboard → Schedule Settings** (competition date, start
times, tab-switch threshold, hints on/off) or seed flags. All timing is
server-controlled; the client only displays it. If configured durations and
start times disagree, the judge dashboard shows the conflict explicitly.

Manual override (server stopped or admin SQL): rows in the `settings` table —
`competition.date` (`YYYY-MM-DD`), `schedule.r1_start` / `r2_start` / `r3_start`
(`HH:MM` local), `schedule.r1_minutes` etc.

## Flow

1. Team logs in → dashboard (score, rank, timer, journey Gate→Maze→Cipher→Code
   Arena→Debug Lab).
2. Workspace per round: MCQ / code answers, autosaved drafts (20 s), one graded
   submission per question (no resubmission), server-side grading, hints with
   server-applied penalty and confirmation dialog.
3. Live leaderboard (Socket.IO). Tie-break: score → earlier first correct
   submission → team ID lexicographic.
4. Judge dashboard: teams, submissions, re-grading, score adjustments (reason
   mandatory, audited), flags, tab-switch incidents, audit log, freeze.
5. Freeze (admin only, requires confirmation) → results page shows FINAL.
   Unfreeze requires an explicit correction reason and is audited; re-freeze
   after correcting.

## Questions content

All 40 questions (15 Logic Quest MCQ, 14 Code Arena core + 6 bonus, 5 Debug
Lab) are transcribed verbatim from `questions for all years.docx`. Import is
idempotent (stable external keys `roundN-qM`): re-running `node seed.js`
never duplicates. Grading: MCQ exact match; code questions are pattern-checked
against the documented expected fixes (e.g. `i += 2;`, `arr[0] = last`) — see
"Known limitations" for what this means.

## Backup & restore

Backup (server can stay running):

```
npm run backup            # → backups/codesprint-<timestamp>.db + results JSON
npm run backup D:\safe    # custom directory
```

Restore: stop the server (Ctrl+C in its console), replace `codesprint.db` with
the backup file (delete leftover `codesprint.db-wal` / `-shm` first), restart
with `npm start`.

Safe shutdown: stop the server with Ctrl+C (or end the process). SQLite WAL
mode guarantees no corruption on clean shutdown; all state is committed per
request.

## Tests

```
npm test
```

19 automated tests covering: unauthenticated access blocked, uniform credential
errors, role separation (team→judge APIs = 403), score forging blocked, expired
sessions rejected, idempotent import, answer/hint key non-leakage, phase
locking (lunch + finished), duplicate submission protection, server-side hint
penalties, leaderboard ordering, frozen results immutability, unfreeze reason
requirement, draft isolation between teams, 3-tab-switch elimination + judge
reinstate, answer-key spot checks, SQL-injection-resistant login.

## Starting the competition anytime (host controls)

Judge/Admin dashboard → **Quick Start**:

- **▶ Start now** — Round 1 opens immediately; lunch and Rounds 2/3 are
  scheduled automatically from the configured round lengths (1-hour lunch).
- **Start in 5 / 15 min** — same, with a countdown.
- **⏸ Hold / postpone** — everything locks back to “Not Started”. Nothing is
  deleted; use Start again at any time (works any hour, any day — the schedule
  rolls to the next calendar day automatically when it runs past midnight).

Fine-grained control (date, per-round start times and lengths, tab-switch
limit, hints) lives in **Schedule Settings** below it.

## Cloud deployment

The app needs a **long-running Node process** with **WebSockets** (Socket.IO
leaderboard), a **writable disk** (SQLite), and optionally `gcc`/`g++`/`jdk`
/`python` installed for the Run button (works without them, Run is hidden).
That rules out pure serverless platforms (Vercel functions, Cloudflare Workers
for the API): no WebSockets + no persistent filesystem.

| Platform | Fit | Notes |
|---|---|---|
| **Railway** (recommended) | ★★★★ | Simplest: one service + one volume, WebSocket support, deploys from GitHub or CLI. ~$5/mo Hobby + ~$0.15/GB volume. `npx @railway/cli deploy` or repo connect. Attach a volume, mount at `/data`, set `CODESPRINT_DB=/data/codesprint.db`. |
| **Render** | ★★★ | Similar setup; Web Service + persistent disk (disk needs paid instance). |
| **Fly.io** | ★★★ | Very good fit (real VMs + volumes) but more CLI-heavy. |
| **LAN laptop** (current design) | ★★★★★ for the event day | Zero cost, zero latency for participants, gcc/python already installed, fullscreen/tab monitoring most reliable on school LAN. |

Deploy checklist: set a strong `--admin-pass`/`--judge-pass` at seed, switch to
`better-sqlite3`+Docker if you need gcc inside a container, and back up
`codesprint.db` (`npm run backup`) before/after the event.

18 automated tests covering: unauthenticated access blocked, uniform credential
errors, role separation (team→judge APIs = 403), score forging blocked, expired
sessions rejected, idempotent import, answer/hint key non-leakage, phase
locking (lunch + finished), duplicate submission protection, server-side hint
penalties, leaderboard ordering, frozen results immutability, unfreeze reason
requirement, draft isolation between teams, tab-event dedupe + threshold
incident, answer-key spot checks, SQL-injection-resistant login.

## Known limitations (V1 — documented, not faked)

- **Code execution (Run button):** teams can run their Python / C / C++ / Java
  code against optional stdin before submitting. Runtimes are auto-detected on
  the server (`GET /api/runtimes`); if a compiler is missing (e.g. no gcc for
  C), the Run button hides for that language and grading is unaffected. Limits:
  5 s per run, output capped at 10 KB, 30 runs per team per 5 minutes, runs only
  during the question's open round. **This is not a security sandbox** — run
  the server on a trusted LAN where participants are accountable; it executes
  participant code in a temp dir with timeouts but no OS-level isolation.
- **No automatic test-case evaluation.** The Run button shows program output for
  manual checking, but grading is still by deterministic
  pattern/keyword checks against the documented expected fixes (e.g. `i += 2;`,
  `arr[0] = last`) plus judge re-grade. Several
  Solve/Challenge/Bonus questions are marked
  `judgeNote` in the DB and should be verified by judges using the re-grade
  control.
- **Round 2 marks:** the source doc lists Predict/Fix/Complete/Solve at 30 each
  and Challenge at 20, totalling 140 (3+2+3+3+3 = 14 questions × 30/20). Bonus
  (6 × 10) is extra credit per the doc's "BONUS ROUND = EXTRA MARKS". Debug Lab
  stages are 20/20 in the source doc's question text (10+10 stated per question
  conflicts with the stage heading's 20 marks — we used the question-level 20
  and Final Boss 20; adjust in the questions table if the organizers decide
  otherwise).
- **Final Boss marks** ("to be finalized by the question-setting team") default
  to 20 — edit `questions.marks` for `round3-q5` to change.
- **Source-document discrepancy (unresolved):** Round 1 "duration 2 hours" with
  a 10:00 start ends at 12:00, which the schedule confirms; if the actual start
  differs, set `schedule.r1_start` and the platform derives lunch from the gap
  to `schedule.r2_start` (conflict is surfaced on the judge dashboard).
- **Pause:** pausing the whole competition is not implemented; judges can
  lock/unlock by editing schedule settings. Round/phase locking follows the
  server clock only.
- Q13 of Round 1 (Reverse Coding) has a duplicated options list in the source
  (XSZRI repeated) — distinct distractors were substituted (`XSZSJ`, `XSARI`),
  correct answer unchanged.
- Q19 of Round 2 in the seed carries a stray no-op field from transcription;
  it has no runtime effect.

## Security notes

- Sessions: HttpOnly, SameSite=Lax cookies, scrypt-hashed passwords, uniform
  login errors, 12 h expiry (configurable). Sessions stored server-side.
- Role checks on every API route; teams can never read answer keys, other
  teams' submissions/drafts, or judge data; sockets join rooms by role.
- Score mutations require an authenticated judge/admin and a mandatory reason;
  every consequential action lands in the audit log.
- Freeze makes results immutable without an explicit, audited correction.
