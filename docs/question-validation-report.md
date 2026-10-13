# Question Import & Content-Validation Report

Source: **"questions for all years.docx"** (`D:\spiderfoot\New folder\`, 21.7 KB).
Verbatim extraction kept for provenance at [test/questions-all-years.txt](../test/questions-all-years.txt).
Import is idempotent (`node seed.js`) — judge-edited questions are never overwritten (safe-update via `question_edits` + `question_history` versioning).

## Coverage

| Round | Stage groupings preserved | Questions imported | Marks |
|---|---|---|---|
| Round 1 — Logic Quest | GATE (Q1–5) / MAZE (Q6–10) / CIPHER (Q11–15) | 15/15 MCQs | 10 each |
| Round 2 — Code Arena | Predict (3) / Fix It (2) / Complete It (3) / Solve (3) / Challenge (3) / Optional (6) | 20/20 | 30 core stage, 20 challenge, 10 bonus |
| Round 3 — Debug Lab | Broken Loop (2) / Hidden Bug (2) / Final Boss (1) | 5/5 | **10 each (source explicit; was 20 in old import — corrected to match source)** |

## Source-content validation findings (NOT silently corrected)

### 1. round1-q13 — Reverse Coding "CHAIR" — ⚠ NEEDS REVIEW
- Source prints **options A, B and C identically as `XSZRI`** (duplicate MCQ option corruption in the original document) and D as `XHZRI`.
- Correct derivation: C→X, H→S, A→Z, I→R, R→I ⇒ `XSZRI`.
- Imported options A = `XSZRI` (source), B = `XSZBJ`, C = `XSARI` as *plausible intended distractors*; flagged `needs_review` so this does not silently become the authoritative correction. **Organizer must confirm/replace options B and C before the live event.**

### 2. round1-q4 — Probability — ⚠ NEEDS REVIEW
- Options B (`1/3`) and C (`4/12`) are **mathematically equal** — a participant choosing either could argue correctness.
- Source answer key is B (`1/3`). No silent change; auto-grading accepts only B. Organizer should either reword option C (e.g. `4/15`) or accept both.

### 3. Round-3 marks mismatch (fixed toward source)
- Source explicitly states **10 marks** per Debug Lab question; the existing import had 20. Re-imported at 10 as the source-of-truth value — flagged in this report rather than silently retained.

### 4. Marks absent in source for Round 1 / Round 2
- The document gives no mark values for Round 1 MCQs or Round-2 stages. Existing values (10 / 30 / 20 / 10) are retained as previously configured and are editable per question in the judge Question Bank Manager.

### 5. Verified-correct spot checks
- Q1 72% ✔, Q2 75 ✔, Q3 7.2 ✔, Q5 27 ✔, Q6 6 m East ✔, Q7 159 ✔, Q8 P ✔ (U S P Q R T consistent), Q9 A ✔, Q10 F-C-G-A-B-E-D ✔ (G between C and A holds), Q11 EPH ✔, Q12 47 ✔, Q14 3-15-4-5 ✔, Q15 72 ✔
- Round-3 code fixes verified by execution where applicable: Q1 `i += 2` terminates ✔; Q2 `j <= 3` prints three rows ✔; Q5 `arr[0] = last` rotates correctly ✔.

## Review statuses in the database
- `verified` + `approved`: 38 questions — live to participants.
- `needs_review` + withheld from participants: **round1-q4, round1-q13** (visible to judges in the Question Bank Manager with the notes above; approve via Edit → status).

## Reveal policy
- Default `reveal.policy = immediately` (verdict + correct option + explanation right after a team's own submission).
- Set `reveal.policy = judge_triggered` (or per-question `answer_reveal_policy`) to withhold explanations until the judge broadcasts the reveal; participant question payloads never contain answer or explanation fields regardless of policy.
