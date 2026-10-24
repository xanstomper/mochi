---
name: verify-visually
description: Close the act-see-correct loop on UI work — after any action that changes what the user sees, screenshot it, read what is actually visible, compare against the expected state, and correct or report the mismatch before claiming success.
tools: [read, search, glob, verify]
---

# Verify Visually: Read Your Own Screenshots

An agent that clicks and assumes the click worked is flying blind. The
action completing is not evidence the interface reached the intended
state — wrong elements, timing races, and stale states all report success
while showing failure. This skill closes the loop: act, see, correct.

## When to use it

After any browser or desktop action whose deliverable is visible state:
navigation, form submission, toggling, creating or deleting visible
content, and any UI task the user will judge by looking.

## Protocol

1. **Act, then capture.** After the UI-affecting action, take a
   screenshot of the resulting state before doing anything else. Do not
   batch three actions and screenshot at the end — a failure in step one
   hides behind steps two and three.
2. **Read what is actually visible.** Describe the screenshot in your
   own terms: which elements are present, what text they show, what
   state they are in. Read the evidence, not the intention — "the dialog
   is open" is a claim about the screenshot, and it must match pixels,
   not the plan.
3. **Compare observed against expected.** State the expected state in
   one line, then the observed state in one line. If they match, the
   step is verified — record that, and move on.
4. **On mismatch, diagnose before retrying.** Name the most likely
   cause from the evidence: wrong element clicked, action raced ahead
   of rendering, stale state, or the expectation itself was wrong.
   Retry once with a corrected action, then capture again.
5. **One retry, then report honestly.** If the second capture still
   mismatches, stop and report the mismatch with both screenshots'
   readings. A second blind retry is guessing; a reported mismatch with
   evidence is a completed diagnosis.
6. **When screenshots are unavailable, say so and downgrade.** On
   engines that cannot screenshot, fall back to the accessibility-tree
   snapshot and record it as weaker evidence — structure is not sight,
   and the report must not pretend otherwise.

## Rules

- Never claim a UI task succeeded from action completion alone. The
  screenshot read is the success criterion, not the click.
- Never skip the capture because the action "obviously worked."
  Obviousness is exactly where timing races hide.
- Never describe a screenshot you did not take. If no capture exists,
  the step is unverified, full stop.
