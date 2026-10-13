'use strict';
/**
 * CODE SPRINT — grading helpers.
 * Answer checking is deterministic and server-side only.
 * For 'code' questions the answer field stores JSON:
 *   { mode: "contains_all", values: ["i += 2;"], caseInsensitive: true }
 *   { mode: "contains_any", values: [...] }
 *   { mode: "exact", value: "return n * n" }
 * IMPORTANT: we do NOT execute participant code. Code questions are graded by
 * pattern/keyword checks against the documented expected fixes (documented
 * limitation — V1). Judges may override marks manually.
 */

function normalize(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function gradeAnswer(question, submitted) {
  const qType = question.type;
  if (qType === 'mcq') {
    // options stored as JSON array; answer is the exact option text
    const ok = normalize(submitted) === normalize(question.answer);
    return { correct: ok, awarded: ok ? question.marks : 0, feedback: ok ? 'Correct' : 'Incorrect' };
  }
  if (qType === 'short') {
    const ans = String(question.answer);
    let spec;
    try { spec = JSON.parse(ans); } catch { spec = { mode: 'exact', value: ans }; }
    const sub = normalize(submitted);
    const norm = (v) => normalize(v);
    if (spec.caseInsensitive) {
      spec = { ...spec, values: (spec.values || [spec.value]).map((v) => String(v).toLowerCase()) };
      return gradeValues(sub.toLowerCase(), spec, question);
    }
    return gradeValues(sub, spec, question);
  }
  if (qType === 'code') {
    let spec;
    try { spec = JSON.parse(question.answer); } catch { spec = { mode: 'exact', value: question.answer }; }
    const sub = String(submitted).replace(/\r\n/g, '\n');
    if (spec.caseInsensitive) {
      return gradeValues(sub.toLowerCase(), { ...spec, values: (spec.values || [spec.value]).map((v) => String(v).toLowerCase()) }, question);
    }
    return gradeValues(sub, spec, question);
  }
  return { correct: false, awarded: 0, feedback: 'Unknown question type' };
}

function gradeValues(sub, spec, question) {
  const values = spec.values || [spec.value];
  const check = (v) => sub.includes(normalize(v));
  let ok;
  if (spec.mode === 'contains_all') ok = values.every(check);
  else if (spec.mode === 'contains_any') ok = values.some(check);
  else ok = normalize(sub) === normalize(spec.value); // exact
  return { correct: ok, awarded: ok ? question.marks : 0, feedback: ok ? 'Correct' : 'Incorrect' };
}

module.exports = { gradeAnswer, normalize };
