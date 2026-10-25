---
name: complaint-to-test
description: Turn every user complaint into a regression test — reproduce it minimally, write a test that fails before the fix and passes after, keep that test in the suite permanently, and never fix blind when reproduction fails.
tools: [read, search, glob, verify]
---

# Complaint to Test: Every Report Becomes a Guard

A complaint fixed without a test will be reintroduced. A complaint fixed
without reproduction will be "fixed" twice and solved never. This skill
makes the loop airtight: complaint → reproduction → failing test →
fix → permanent guard.

## When to use it

Whenever a user reports a defect, a regression, or behavior that
contradicts what was promised — before any fix is attempted.

## Protocol

1. **Reproduce it minimally, first.** Build the smallest reproduction
   of the reported behavior before touching the fix. If the
   reproduction fails, say so with what was tried — do not fix blind
   and hope the complaint goes away.
2. **Write the failing test before the fix.** The test captures the
   complaint exactly: the input, the expected behavior, and the
   observed wrong behavior. It must fail on the current code — a test
   that passes before the fix proves nothing.
3. **Fix until the test passes.** Change the code, not the test's
   expectation. If the fix requires changing the expectation, the
   complaint itself needs re-examination — say so, do not quietly
   rewrite the test to match the bug.
4. **Keep the test permanently, named after the complaint.** The
   regression test stays in the suite under a name future sessions can
   trace back to the report. A test deleted after the fix is a guard
   removed after the guard worked.
5. **Map duplicates to the same test.** When the same complaint
   arrives again, point at the existing test instead of adding a
   second one. Two tests for one defect diverge; one test for one
   defect holds.

## Rules

- No fix without a failing test first. The test is the proof the
  complaint was understood, not paperwork after the fact.
- Never weaken a regression test to make a fix pass. If the test and
  the fix disagree, the understanding is wrong — re-examine it.
- Never close a complaint as fixed on the basis of a manual check
  alone. The suite is the record; a manual pass evaporates.
- Never reproduce with production data or user secrets. Minimal
  reproduction means minimal exposure.
