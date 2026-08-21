---
name: debugger
description: Systematic debugging, root cause analysis, reproduction script creation, stack trace decomposition, and bisection.
tools: [read, edit, patch, shell, glob, search, verify]
---

# Systematic Debugging Skill

## The 5-Step Root Cause Protocol
1. **Reproduce Reliably:**
   - Create a minimal, deterministic reproduction script or failing test case.
   - Do not guess or modify production code until the bug is consistently reproduced.
2. **Deconstruct Stack Trace & Telemetry:**
   - Trace backwards from the point of failure to the point of origin.
   - Distinguish the symptom (e.g. `NullPointerException`, `NaN`, `SIGSEGV`) from the root trigger (bad input, unhandled async rejection, state mutation).
3. **Formulate Falsifiable Hypotheses:**
   - Formulate 2-3 specific hypotheses explaining the defect.
   - Use surgical log points or targeted assertions to eliminate incorrect hypotheses.
4. **Apply Surgical Fix:**
   - Modify the minimum necessary code to fix the root cause.
   - Guard against edge cases (boundary values, null/undefined, empty collections, concurrency).
5. **Verify & Prevent Regression:**
   - Confirm reproduction script passes.
   - Add permanent regression unit test to the test suite.
