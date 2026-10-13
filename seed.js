'use strict';
/**
 * CODE SPRINT — seed/import.
 * Idempotent: questions use stable external_key so re-running never duplicates.
 * Content transcribed verbatim from "questions for all years.docx".
 * Usage: node seed.js [--teams N] [--judge-user name] [--judge-pass pw] [--admin-pass pw]
 */
const { getDb } = require('./db');
const { setSetting, getSetting } = require('./schedule');
const crypto = require('crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const check = crypto.scryptSync(pw, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}  // ---------------------------------------------------------------------------
  // ROUND 1 — LOGIC QUEST (15 MCQ questions, verbatim from source doc)
  // srcDiff: content-validation flags from the source audit (Phase 3) — shown
  // to judges for review; the source wording is preserved, never "corrected".
  // ---------------------------------------------------------------------------
const ROUND1 = [
  // GATE — Quantitative Aptitude
  { stage: 'gate', n: 1, diff: 'Easy', cat: 'Percentages', marks: 10,
    statement: 'A student scored 360 marks out of 500. What percentage did the student score?',
    options: ['68%', '70%', '72%', '75%'], answer: '72%', explanation: '360/500 × 100 = 72%.' },
  { stage: 'gate', n: 2, diff: 'Easy–Moderate', cat: 'Ratio', marks: 10,
    statement: 'The ratio of boys to girls in a class is 3 : 2. If there are 45 boys, how many students are there in total?',
    options: ['60', '70', '75', '80'], answer: '75' },
  { stage: 'gate', n: 3, diff: 'Moderate', cat: 'Time & Work', marks: 10,
    statement: 'A can complete a task in 12 days and B can complete the same task in 18 days. If they work together, how many days will they take?',
    options: ['6.2 days', '7.2 days', '8 days', '9 days'], answer: '7.2 days', explanation: '1/12 + 1/18 = 5/36 per day ⇒ 36/5 = 7.2 days.',
    review: 'verified' },
  { stage: 'gate', n: 4, diff: 'Moderate–Hard', cat: 'Probability', marks: 10,
    statement: 'A box contains 5 red, 4 blue and 3 green balls. One ball is selected at random. What is the probability that the ball is neither red nor green?',
    options: ['1/4', '1/3', '4/12', '5/12'], answer: '1/3',
    explanation: 'neither red nor green → only blue: 4/12 = 1/3. Source flags: options B (1/3) and C (4/12) are mathematically equal — a participant choosing 4/12 is also correct. Needs organizer decision before the live event.',
    review: 'needs_review', note: 'options B and C are equivalent (4/12 = 1/3); two valid answers in the source' },
  { stage: 'gate', n: 5, diff: 'Challenging', cat: 'Average & Replacement', marks: 10,
    statement: 'The average age of 8 students is 20 years. When one student leaves the group, the average becomes 19 years. What was the age of the student who left?',
    options: ['25 years', '26 years', '27 years', '28 years'], answer: '27 years' },
  // MAZE — Logical Reasoning
  { stage: 'maze', n: 6, diff: 'Easy', cat: 'Direction Sense', marks: 10,
    statement: 'A person walks 8 m north, then turns right and walks 6 m. He then turns right again and walks 8 m. Where is he now with respect to his starting point?',
    options: ['6 m East', '6 m West', '8 m East', '8 m South'], answer: '6 m East' },
  { stage: 'maze', n: 7, diff: 'Easy–Moderate', cat: 'Number Pattern', marks: 10,
    statement: 'Find the missing number: 4, 9, 19, 39, 79, ?',
    options: ['149', '158', '159', '160'], answer: '159' },
  { stage: 'maze', n: 8, diff: 'Moderate', cat: 'Seating Arrangement', marks: 10,
    statement: 'Six students P, Q, R, S, T and U are sitting in a row. P sits to the left of Q. R sits immediately to the right of Q. S sits to the left of P. T sits to the right of R. U sits at the extreme left. Who occupies the third position from the left?',
    options: ['P', 'Q', 'R', 'S'], answer: 'P' },
  { stage: 'maze', n: 9, diff: 'Moderate–Hard', cat: 'Logical Deduction', marks: 10,
    statement: 'Five people A, B, C, D and E have different heights. A is taller than B. C is shorter than D. B is taller than C. D is shorter than A. Who is definitely the tallest?',
    options: ['A', 'B', 'C', 'D'], answer: 'A' },
  { stage: 'maze', n: 10, diff: 'Challenging', cat: 'Arrangement', marks: 10,
    statement: 'Seven people A, B, C, D, E, F and G are standing in a line. B is immediately to the right of A. C is somewhere to the left of A. D is immediately to the right of E. F is at the extreme left. G is between C and A. Which of the following could be the correct arrangement?',
    options: ['F C G A B E D', 'F G C A B E D', 'C F G A B D E', 'F C A G B E D'], answer: 'F C G A B E D' },
  // CIPHER — Pattern & Analytical Reasoning
  { stage: 'cipher', n: 11, diff: 'Easy', cat: 'Letter Coding', marks: 10,
    statement: 'If CAT → DBU using the same pattern, what is DOG → ?',
    options: ['EPH', 'EOG', 'FPH', 'DPH'], answer: 'EPH' },
  { stage: 'cipher', n: 12, diff: 'Easy–Moderate', cat: 'Number Coding', marks: 10,
    statement: 'If APPLE = 50 using A=1, B=2, ..., Z=26, what is GRAPE = ?',
    options: ['45', '47', '49', '51'], answer: '47' },
  { stage: 'cipher', n: 13, diff: 'Moderate', cat: 'Reverse Coding', marks: 10,
    statement: 'In a certain code: TABLE → GZYOV (each letter replaced by its opposite: A↔Z, B↔Y, C↔X...). Using the same rule, what is CHAIR → ?',
    options: ['XSZRI', 'XSZBJ', 'XSARI', 'XHZRI'], answer: 'XSZRI',
    explanation: 'C→X, H→S, A→Z, I→R, R→I ⇒ XSZRI.',
    review: 'needs_review', note: 'Source document prints options A, B and C identically as "XSZRI" (duplicate) and D as "XHZRI". This import shows B as XSZBJ and C as XSARI as the most plausible intended distractors — MUST be confirmed by the organizer before the live event.' },
  { stage: 'cipher', n: 14, diff: 'Moderate–Hard', cat: 'Pattern Coding', marks: 10,
    statement: 'In a certain code: ROAD → 18-15-1-4 and GAME → 7-1-13-5. What would be the code for CODE?',
    options: ['3-15-4-5', '4-15-3-5', '3-14-4-5', '2-15-4-6'], answer: '3-15-4-5' },
  { stage: 'cipher', n: 15, diff: 'Challenging', cat: 'Pattern Recognition', marks: 10,
    statement: 'A special code follows an unknown rule: 2→6, 3→12, 4→20, 5→30, 6→42. Using the same rule: 8 → ?',
    options: ['56', '64', '72', '80'], answer: '72' },
];

// ---------------------------------------------------------------------------
// ROUND 2 — CODE ARENA (14 core + 6 optional coding = 20 questions)
// ---------------------------------------------------------------------------
const ROUND2 = [
  // STAGE 1 — PREDICT (3)
  { stage: 'predict', n: 1, diff: 'Easy', cat: 'Predict', marks: 30, type: 'mcq',
    statement: 'What is the output?\nx = 5\ny = 2\nx = x + y\ny = x - y\nx = x - y\nprint(x, y)',
    options: ['5 2', '2 5', '7 5', '5 7'], answer: '2 5' },
  { stage: 'predict', n: 2, diff: 'Moderate', cat: 'Predict', marks: 30, type: 'mcq',
    statement: 'What is the output?\nint x = 10;\nfor(int i = 1; i <= 3; i++)\n{\nx = x - i;\n}\nprintf("%d", x);',
    options: ['3', '4', '5', '6'], answer: '4' },
  { stage: 'predict', n: 3, diff: 'Hard', cat: 'Predict', marks: 30, type: 'mcq',
    statement: 'What is the output?\narr = [2, 4, 6, 8]\nresult = 0\nfor i in range(len(arr)):\n    result += arr[i] * i\nprint(result)',
    options: ['30', '40', '44', '50'], answer: '44' },
  // STAGE 2 — FIX IT (2)
  { stage: 'fixit', n: 4, diff: 'Moderate', cat: 'Fix It', marks: 30, type: 'code', languages: ['python', 'c'],
    statement: 'The program should find the smallest element.\narr = [8, 3, 12, 5, 1]\nsmallest = 0\nfor x in arr:\n    if x < smallest:\n        smallest = x\nprint(smallest)\n\nWhat should be changed? Submit the corrected line of code.',
    starterCode: '# Fix the bug\narr = [8, 3, 12, 5, 1]\nsmallest = 0\nfor x in arr:\n    if x < smallest:\n        smallest = x\nprint(smallest)',
    answer: { mode: 'contains_all', values: ['smallest = arr[0]'], caseInsensitive: true } },
  { stage: 'fixit', n: 5, diff: 'Moderate', cat: 'Fix It', marks: 30, type: 'code', languages: ['c'],
    statement: 'The program should print:\n1 2 3 4 5\n\nint i = 1;\nwhile(i <= 5)\n{\nprintf("%d ", i);\ni--;\n}\n\nIdentify and fix the error. Submit the corrected line.',
    starterCode: 'int i = 1;\nwhile(i <= 5)\n{\nprintf("%d ", i);\ni--;\n}',
    answer: { mode: 'contains_all', values: ['i++'], caseInsensitive: true } },
  // STAGE 3 — COMPLETE IT (3)
  { stage: 'complete', n: 6, diff: 'Easy', cat: 'Complete It', marks: 30, type: 'code', languages: ['python'],
    statement: 'Complete the function to return the square of a number.\ndef square(n):\n    __________\nprint(square(6))\n\nSubmit the missing line.',
    starterCode: 'def square(n):\n    # your code here\n\nprint(square(6))',
    answer: { mode: 'contains_all', values: ['return n * n', 'return n**2'], caseInsensitive: true } },
  { stage: 'complete', n: 7, diff: 'Moderate', cat: 'Complete It', marks: 30, type: 'code', languages: ['c'],
    statement: 'Find whether an array contains a target value.\nint arr[] = {4, 7, 2, 9, 5};\nint target = 9;\nint found = 0;\nfor(int i = 0; i < 5; i++)\n{\nif(______________)\n{\nfound = 1;\nbreak;\n}\n}\n\nSubmit the missing condition.',
    answer: { mode: 'contains_all', values: ['arr[i] == target'], caseInsensitive: true } },
  { stage: 'complete', n: 8, diff: 'Moderate', cat: 'Complete It', marks: 30, type: 'code', languages: ['python'],
    statement: 'Complete the code to reverse a string.\ns = "HELLO"\nrev = ""\nfor i in range(____________):\n    rev += s[i]\nprint(rev)\n\nInstead of simply filling len(s), use reverse traversal. Submit the range arguments.',
    answer: { mode: 'contains_all', values: ['len(s)-1, -1, -1'], caseInsensitive: true } },
  // STAGE 4 — SOLVE (3)
  { stage: 'solve', n: 9, diff: 'Moderate', cat: 'Solve', marks: 30, type: 'code', languages: ['python', 'c', 'java', 'cpp'],
    statement: 'Two Sum — Given an array and a target, find whether two different elements add up to the target.\n\nInput format:\ncase 1: n; case 2: n integers; case 3: target\nDecision: print "Yes" if two different elements add to target, else "No".',
    sampleInput: '6\n2 7 11 15 3 6\n9',
    sampleOutput: 'Yes',
    explanation: '2 + 7 = 9 → Yes.',
    answer: { mode: 'contains_any', values: ['yes'], caseInsensitive: true } },
  { stage: 'solve', n: 10, diff: 'Moderate', cat: 'Solve', marks: 30, type: 'code', languages: ['python', 'c', 'java', 'cpp'],
    statement: 'Character Frequency — Given a string, find the frequency of each character. Spaces should be ignored. Print each character with its count (e.g. P → 1).\n\nInput format: one string per case.',
    sampleInput: 'PROGRAMMING',
    sampleOutput: 'P → 1\nR → 2\nO → 1\nG → 2\nA → 1\nM → 2\nI → 1\nN → 1',
    explanation: 'Count occurrences of every character; the source documents P:1, R:2, O:1, G:2.',
    answer: { mode: 'contains_all', values: ['R', 'G'], caseInsensitive: false, judgeNote: 'Manual review recommended; auto-grade checks R and G counts present.' } },
  { stage: 'solve', n: 11, diff: 'Moderate', cat: 'Solve', marks: 30, type: 'code', languages: ['python', 'c', 'java', 'cpp'],
    statement: 'Rotate Array — Rotate an array to the right by K positions.\n\nInput format: case 1: n, case 2: the array, case 3: k. Print the rotated array on one line.',
    sampleInput: '5\n1 2 3 4 5\n2',
    sampleOutput: '4 5 1 2 3',
    explanation: 'Right rotation by 2: last k elements move to the front.',
    answer: { mode: 'contains_all', values: ['4 5 1 2 3'], caseInsensitive: false, judgeNote: 'Auto-grade checks the sample output appears.' } },
  // STAGE 5 — CHALLENGE (3)
  { stage: 'challenge', n: 12, diff: 'Hard', cat: 'Challenge', marks: 20, type: 'code', languages: ['python', 'c', 'java', 'cpp'],
    statement: 'Longest Increasing Subarray — Find the length of the longest contiguous strictly increasing portion of an array.\n\nInput format: case 1: n, case 2: the array. Print the length.',
    sampleInput: '8\n1 2 3 2 3 4 5 1',
    sampleOutput: '4',
    explanation: 'The run 2 3 4 5 has length 4.',
    answer: { mode: 'contains_all', values: ['4'], caseInsensitive: false, judgeNote: 'Manual review recommended.' } },
  { stage: 'challenge', n: 13, diff: 'Hard', cat: 'Challenge', marks: 20, type: 'code', languages: ['python', 'c', 'java', 'cpp'],
    statement: 'First Non-Repeating Character — Given a string, print the first character that occurs exactly once.\n\nInput format: one string. Print the character, or a sensible not-found marker of your choice.',
    sampleInput: 'SWISS',
    sampleOutput: 'W',
    explanation: 'W is the first character occurring only once.',
    answer: { mode: 'contains_all', values: ['W'], caseInsensitive: false, judgeNote: 'Manual review recommended.' } },
  { stage: 'challenge', n: 14, diff: 'Hard', cat: 'Challenge', marks: 20, type: 'code', languages: ['python', 'c', 'java', 'cpp'],
    statement: 'Maximum Subarray Sum — Given an array containing positive and negative integers, print the maximum sum of a contiguous subarray.\n\nInput format: case 1: n, case 2: the array. Print the sum.',
    sampleInput: '8\n-2 1 -3 4 -1 2 1 -5',
    sampleOutput: '6',
    explanation: 'The maximum subarray is 4 -1 2 1 → sum 6.',
    answer: { mode: 'contains_all', values: ['6'], caseInsensitive: false, judgeNote: 'Manual review recommended.' } },
  // CODING QUESTIONS [Optional] (Q15–Q20)
  { stage: 'bonus', n: 15, diff: 'Easy', cat: 'Bonus', marks: 10, type: 'code', languages: ['python', 'c', 'java', 'cpp'], bonus: 1,
    statement: 'Palindrome String — Determine whether a given string is a palindrome. Print "Palindrome" or "Not Palindrome".\n\nInput format: one string per case.',
    sampleInput: 'MADAM',
    sampleOutput: 'Palindrome',
    explanation: 'MADAM reversed is MADAM.',
    answer: { mode: 'contains_any', values: ['palindrome'], caseInsensitive: true, judgeNote: 'Manual review recommended.' } },
  { stage: 'bonus', n: 16, diff: 'Moderate', cat: 'Bonus', marks: 10, type: 'code', languages: ['python', 'c', 'java', 'cpp'], bonus: 1,
    statement: 'Second Largest Distinct Element — Find the second largest distinct element WITHOUT sorting.\n\nInput format: case 1: n, case 2: the array. Print the value, or a marker if none exists.',
    sampleInput: '7\n10 25 8 25 30 15 30',
    sampleOutput: '25',
    explanation: 'Distinct values: 30, 25, … → second largest is 25.',
    answer: { mode: 'contains_all', values: ['25'], judgeNote: 'Manual review recommended.' } },
  { stage: 'bonus', n: 17, diff: 'Moderate', cat: 'Bonus', marks: 10, type: 'code', languages: ['python', 'c', 'java', 'cpp'], bonus: 1,
    statement: 'Move Zeros — Move all zeros to the end while maintaining the order of non-zero elements.\n\nInput format: case 1: n, case 2: the array. Print the rearranged array on one line.',
    sampleInput: '7\n0 1 0 3 12 0 5',
    sampleOutput: '1 3 12 5 0 0 0',
    explanation: 'Stable partition: non-zeros keep order, zeros trail.',
    answer: { mode: 'contains_all', values: ['1 3 12 5 0 0 0'], judgeNote: 'Manual review recommended.' } },
  { stage: 'bonus', n: 18, diff: 'Easy', cat: 'Bonus', marks: 10, type: 'code', languages: ['python', 'c', 'java', 'cpp'], bonus: 1,
    statement: 'Missing Number — An array contains numbers from 1 to N with one number missing. Print the missing number.\n\nInput format: case 1: N, case 2: N−1 numbers. Print the missing value.',
    sampleInput: '5\n1 2 4 5',
    sampleOutput: '3',
    explanation: 'Sum 1..5 = 15; given total 12 → missing 3.',
    answer: { mode: 'contains_all', values: ['3'], judgeNote: 'Manual review recommended.' } },
  { stage: 'bonus', n: 19, diff: 'Moderate', cat: 'Bonus', mountains: null, cat2: null, marks: 10, type: 'code', languages: ['python', 'c', 'java', 'cpp'], bonus: 1,
    statement: 'Merge Two Sorted Arrays — Given two sorted arrays, merge them into one sorted array (elements interleaved, print space-separated).\n\nInput format: case 1: n + n numbers, case 2: m + m numbers. Print the merged array.',
    sampleInput: '3\n1 4 7\n4\n2 3 5 8',
    sampleOutput: '1 2 3 4 5 7 8',
    explanation: 'Standard two-pointer merge.',
    answer: { mode: 'contains_all', values: ['1 2 3 4 5 7 8'], judgeNote: 'Manual review recommended.' } },
  { stage: 'bonus', n: 20, diff: 'Moderate', cat: 'Bonus', marks: 10, type: 'code', languages: ['python', 'c', 'java', 'cpp'], bonus: 1,
    statement: 'Valid Parentheses — Given a string of ( ) { } [ ], print "Valid" if brackets are properly balanced and nested, else "Invalid".\n\nInput format: one bracket string per case.',
    sampleInput: '{[()]}',
    sampleOutput: 'Valid',
    explanation: 'Counter-example from source: {[(])} → Invalid.',
    answer: { mode: 'contains_any', values: ['valid'], caseInsensitive: true, judgeNote: 'Manual review recommended.' } },
];

// ---------------------------------------------------------------------------
// ROUND 3 — DEBUG LAB (5 questions)
// ---------------------------------------------------------------------------
const ROUND3 = [
  // STAGE 1 — BROKEN LOOP
  { stage: 'brokenloop', n: 1, diff: 'Moderate', cat: 'Broken Loop', marks: 20, type: 'code', languages: ['c', 'cpp'],
    statement: 'Infinite Loop — The program should print the first 10 even numbers:\n2 4 6 8 10 12 14 16 18 20\n\nBut the program does not terminate.\n\n#include <stdio.h>\nint main() {\n  int i = 2;\n  while(i <= 20) {\n    printf("%d ", i);\n    i -= 2;\n  }\n  return 0;\n}\n\nTask: Identify the error and modify the code so that the expected output is produced. Submit the corrected line.',
    answer: { mode: 'contains_all', values: ['i += 2;'], caseInsensitive: true } },
  { stage: 'brokenloop', n: 2, diff: 'Moderate', cat: 'Broken Loop', marks: 20, type: 'code', languages: ['c', 'cpp'],
    statement: 'Nested Loop Error — The following program is intended to print:\n1 2 3\n1 2 3\n1 2 3\n\nBut the output is incorrect.\n\n#include <stdio.h>\nint main() {\n  for(int i = 1; i <= 3; i++) {\n    for(int j = 1; j < 3; j++) {\n      printf("%d ", j);\n    }\n    printf("\\n");\n  }\n  return 0;\n}\n\nTask: Find and fix the loop error. Submit the corrected condition.',
    answer: { mode: 'contains_all', values: ['j <= 3'], caseInsensitive: true } },
  // STAGE 2 — HIDDEN BUG
  { stage: 'hiddenbug', n: 3, diff: 'Hard', cat: 'Hidden Bug', marks: 20, type: 'code', languages: ['c', 'cpp'],
    statement: 'Hidden Array Bug — The program is intended to find the second largest distinct element.\n\n#include <stdio.h>\n#include <limits.h>\nint main() {\n  int arr[] = {10, 25, 8, 30, 15};\n  int n = 5;\n  int largest = arr[0];\n  int second = arr[0];\n  for(int i = 1; i < n; i++) {\n    if(arr[i] > largest) {\n      second = largest;\n      largest = arr[i];\n    }\n    else if(arr[i] > second) {\n      second = arr[i];\n    }\n  }\n  printf("%d", second);\n  return 0;\n}\n\nFor 10 25 8 30 15 the program gives 25. But test it with 30 30 20 15 10 — it gives an incorrect result.\n\nTask: Find the hidden bug and modify the program so that it correctly finds the second largest distinct element.',
    answer: { mode: 'contains_all', values: ['arr[i] != largest'], caseInsensitive: true, judgeNote: 'Accept variations; manual review recommended.' } },
  { stage: 'hiddenbug', n: 4, diff: 'Hard', cat: 'Hidden Bug', marks: 20, type: 'code', languages: ['c', 'cpp'],
    statement: 'Hidden String Bug — The following program checks whether two strings are equal.\n\n#include <stdio.h>\nint main() {\n  char str1[] = "Code";\n  char str2[] = "code";\n  int same = 1;\n  for(int i = 0; str1[i] != \'\\0\'; i++) {\n    if(str1[i] != str2[i]) {\n      same = 0;\n      break;\n    }\n  }\n  if(same)\n    printf("Same");\n  else\n    printf("Different");\n  return 0;\n}\n\nThe programmer wants the comparison to be case-insensitive: "Code", "code", "CODE", "cOdE" should all be considered equal.\n\nTask: Find the hidden logical issue and modify the program so that the comparison is case-insensitive.',
    answer: { mode: 'contains_any', values: ['tolower', 'toupper'], caseInsensitive: false, judgeNote: 'Accept tolower/toupper approach.' } },
  // STAGE 3 — FINAL BOSS
  { stage: 'finalboss', n: 5, diff: 'Hard', cat: 'Final Boss', marks: 20, type: 'code', languages: ['c', 'cpp'],
    statement: 'Final Boss — Debug the Array Rotation.\n\nThe following program is intended to rotate an array to the right by k positions.\n\nArray: 1 2 3 4 5\nk = 2\nExpected: 4 5 1 2 3\n\nBut the program contains a logical error.\n\n#include <stdio.h>\nint main() {\n  int arr[] = {1, 2, 3, 4, 5};\n  int n = 5;\n  int k = 2;\n  for(int r = 0; r < k; r++) {\n    int last = arr[n - 1];\n    for(int i = n - 1; i > 0; i--) {\n      arr[i] = arr[i - 1];\n    }\n    arr[0] = arr[n - 1];\n  }\n  for(int i = 0; i < n; i++)\n    printf("%d ", arr[i]);\n  return 0;\n}\n\nTask: Identify the bug and correct the program so that it produces: 4 5 1 2 3',
    answer: { mode: 'contains_all', values: ['arr[0] = last'], caseInsensitive: true } },
];

const ROUNDS = [
  { key: 'round1', title: 'Round 1 — Logic Quest', stages: ['gate', 'maze', 'cipher'] },
  { key: 'round2', title: 'Round 2 — Code Arena', stages: ['predict', 'fixit', 'complete', 'solve', 'challenge', 'bonus'] },
  { key: 'round3', title: 'Round 3 — Debug Lab', stages: ['brokenloop', 'hiddenbug', 'finalboss'] },
];

const STAGE_LABELS = {
  gate: 'The Gate', maze: 'The Maze', cipher: 'The Cipher',
  predict: 'Predict', fixit: 'Fix It', complete: 'Complete It', solve: 'Solve', challenge: 'Challenge', bonus: 'Bonus Round',
  brokenloop: 'Broken Loop', hiddenbug: 'Hidden Bug', finalboss: 'Final Boss',
};

function editsTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS question_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_key TEXT NOT NULL UNIQUE,
    edited_by INTEGER NOT NULL,
    edited_at TEXT NOT NULL DEFAULT (datetime('now')),
    summary TEXT
  );`);
}

function seed({ teams = 36, adminPass, judgeUser = 'judge', judgePass } = {}) {
  const db = getDb();

  // Rounds
  const insRound = db.prepare('INSERT INTO rounds (key, title, stage_keys) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET title=excluded.title, stage_keys=excluded.stage_keys');
  for (const r of ROUNDS) insRound.run(r.key, r.title, JSON.stringify(r.stages));

  // Questions — idempotent via external_key.
  // Safe-update mechanism (master prompt §6): re-import NEVER overwrites a
  // question that a judge has edited (question_edits rows exist) — those are
  // skipped with a notice, protecting judge-corrected answer keys.
  const insQ = db.prepare(`
    INSERT INTO questions (external_key, round_key, stage_key, order_num, title, category, difficulty, topic, marks, type, statement, options, answer, hint, hint_penalty, languages, starter_code,
                           code_snippet, sample_input, sample_output, constraints, explanation, source_ref, review_status, review_note, publication_status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(external_key) DO UPDATE SET
      title=excluded.title, category=excluded.category, difficulty=excluded.difficulty, topic=excluded.topic,
      marks=excluded.marks, type=excluded.type, statement=excluded.statement, options=excluded.options,
      answer=excluded.answer, hint=excluded.hint, hint_penalty=excluded.hint_penalty,
      languages=excluded.languages, starter_code=excluded.starter_code,
      code_snippet=excluded.code_snippet, sample_input=excluded.sample_input, sample_output=excluded.sample_output,
      constraints=excluded.constraints, explanation=excluded.explanation,
      source_ref=excluded.source_ref, review_status=excluded.review_status, review_note=excluded.review_note,
      publication_status=excluded.publication_status, updated_at=excluded.updated_at,
      revision = revision + 1
  `);

  let count = 0, skippedEdits = 0;
  const reviewFlagged = [];
  editsTable(); // question_edits (created earlier below)
  const hints = {
    'round1-q1': 'Percentage = (marks obtained / total marks) × 100.',
    'round1-q5': 'Total age before minus total age after.',
    'round1-q7': 'Each term is the previous term × 2 + 1.',
    'round1-q12': 'Add up the letter positions of each letter in GRAPE.',
    'round2-q1': 'Trace the swaps line by line — this is the classic xor-less swap.',
    'round2-q3': 'Multiply each element by its index, then sum.',
    'round3-q5': 'The variable `last` is saved for a reason — check where it is used.',
  };
  const hintPenalty = { 'round1-q1': 2, 'round1-q5': 4, 'round1-q7': 4, 'round1-q12': 4, 'round2-q1': 10, 'round2-q3': 10, 'round3-q5': 10 };

  function addQuestions(roundKey, defs, defaultType) {
    for (const q of defs) {
      const key = `${roundKey}-q${q.n}`;
      const type = q.type || defaultType;
      const title = `Q${q.n} — ${q.cat} (${q.diff})`;
      // Round 2 & 3 code questions all support the same four languages.
      const langs = (roundKey !== 'round1' && type === 'code')
        ? ['python', 'c', 'cpp', 'java']
        : (q.languages || null);
      const review = q.review || 'verified';
      const note = q.note || null;
      // Publication rule (master prompt §7): only verified/approved questions
      // go live; needs_review imports WITHOUT correcting the source.
      const pub = review === 'needs_review' ? 'needs_review' : 'approved';
      // Preserve judge edits: re-import skips questions a judge has modified.
      const edited = db.prepare("SELECT 1 FROM question_edits WHERE question_key = ?").get(key);
      if (edited) { console.log(`  skip ${key} (judge-edited; re-import preserved)`); skippedEdits++; continue; }
      insQ.run(
        key, roundKey, q.stage, q.n, title, q.cat, q.diff, q.topic || q.cat, q.marks, type,
        q.statement,
        q.options ? JSON.stringify(q.options) : null,
        typeof q.answer === 'string' ? q.answer : JSON.stringify(q.answer),
        hints[key] || null,
        hintPenalty[key] || 0,
        langs ? JSON.stringify(langs) : null,
        q.starterCode || null,
        q.codeSnippet || null, q.sampleInput || null, q.sampleOutput || null,
        q.constraints || null, q.explanation || null,
        `${roundKey}/Q${q.n}${q.stage ? ' [' + q.stage + ']' : ''} ("questions for all years.docx")`,
        review, note, pub,
      );
      if (review === 'needs_review') reviewFlagged.push(`${key}: ${note || ''}`);
      count++;
    }
  }
  addQuestions('round1', ROUND1, 'mcq');
  addQuestions('round2', ROUND2, 'code');
  addQuestions('round3', ROUND3, 'code');

  // Accounts
  const adminUser = 'admin';
  const hasAdmin = db.prepare('SELECT id FROM accounts WHERE username = ?').get(adminUser);
  const finalAdminPass = adminPass || getSetting('bootstrap.admin_password') || 'admin123';
  if (!hasAdmin) {
    db.prepare('INSERT INTO accounts (username, password_hash, role) VALUES (?, ?, ?)')
      .run(adminUser, hashPassword(finalAdminPass), 'admin');
    setSetting('bootstrap.admin_password', finalAdminPass);
  } else if (adminPass) {
    db.prepare('UPDATE accounts SET password_hash = ? WHERE username = ?')
      .run(hashPassword(adminPass), adminUser);
  }

  const hasJudge = db.prepare('SELECT id FROM accounts WHERE username = ?').get(judgeUser);
  const finalJudgePass = judgePass || getSetting('bootstrap.judge_password') || 'judge123';
  if (!hasJudge) {
    db.prepare('INSERT INTO accounts (username, password_hash, role) VALUES (?, ?, ?)')
      .run(judgeUser, hashPassword(finalJudgePass), 'judge');
    setSetting('bootstrap.judge_password', finalJudgePass);
  }

  // Teams: team01..teamNN, password = team password (default: sprint + number)
  const teamIns = db.prepare('INSERT INTO accounts (username, password_hash, role, team_name) VALUES (?, ?, ?, ?)');
  const existingTeams = db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE role = 'team'").get().c;
  if (existingTeams === 0) {
    for (let i = 1; i <= teams; i++) {
      const id = `team${String(i).padStart(2, '0')}`;
      const pw = `sprint${String(i).padStart(2, '0')}`;
      teamIns.run(id, hashPassword(pw), 'team', `Team ${String(i).padStart(2, '0')}`);
    }
    console.log(`Seeded ${teams} team accounts (team01..team${String(teams).padStart(2, '0')}).`);
  } else {
    console.log(`Team accounts already exist (${existingTeams}); skipping team seed.`);
  }

  // Default settings if absent
  if (getSetting('competition.date') === undefined) setSetting('competition.date', new Date().toISOString().slice(0, 10));
  for (const [k, v] of Object.entries({ 'schedule.r1_start': '10:00', 'schedule.r2_start': '13:00', 'schedule.r3_start': '15:00', 'schedule.r1_minutes': '120', 'schedule.r2_minutes': '120', 'schedule.r3_minutes': '60', 'monitor.tab_threshold': '3', 'hints.enabled': '1' })) {
    if (getSetting(k) === undefined) setSetting(k, v);
  }

  console.log(`Seeded/updated ${count} questions across ${ROUNDS.length} rounds.`);
  if (skippedEdits) console.log(`  ${skippedEdits} judge-edited question(s) kept (not overwritten).`);
  if (reviewFlagged.length) {
    console.log('NEEDS REVIEW (source-content flags — organizer decision required):');
    for (const f of reviewFlagged) console.log('  • ' + f);
  }
  console.log('Admin: admin / (bootstrap.admin_password setting or --admin-pass; default admin123 — CHANGE IT).');
  console.log(`Judge: ${judgeUser} / (bootstrap.judge_password setting or --judge-pass; default judge123 — CHANGE IT).`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  seed({
    teams: Number(getArg('--teams') || 36),
    adminPass: getArg('--admin-pass'),
    judgeUser: getArg('--judge-user') || 'judge',
    judgePass: getArg('--judge-pass'),
  });
}

module.exports = { seed, hashPassword, verifyPassword, ROUNDS, STAGE_LABELS };
