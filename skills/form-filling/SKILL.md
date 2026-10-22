---
name: form-filling
description: Complete multi-step web forms reliably with mochi's browser tool — recon the fields first, fill in dependency order, handle iframes and uploads, and verify the confirmation instead of assuming success. Use for signups, checkouts, applications, settings changes, and any hosted form flow.
---

# Form Filling Procedure

Forms fail silently more than any other automation: a field rejects input, a
step never advances, and the summary still says "done". The discipline here
is recon first, one verified step at a time, and proof at the end.

## 1. Recon before touching anything
- `browser navigate` to the form, then `browser inputs` and a snapshot: map every field's selector, name, type, and placeholder before typing a character.
- Note which fields are required, which are selects/checkboxes/file inputs, and whether any live inside an iframe (payment widgets usually do — those need the `frame` parameter).
- Multi-step forms: identify the step indicator and what "next" requires.

## 2. Never invent data
- Fill only from data the user gave you or that is already in the task context. Missing, ambiguous, or sensitive values (payment details, government IDs, passwords, dates of birth) — stop and ask.
- Format-sensitive fields (dates, phone numbers, postal codes) follow the locale the form presents, not your default.

## 3. Fill in dependency order
- `fill` for text inputs (clear + type), `type` when the field needs keystroke events (autocomplete, masked inputs), `select` for dropdowns by option value, `upload` for file inputs.
- Country/state, plan/tier, and account-type fields first — later fields often appear, disappear, or re-validate based on them.
- Iframe fields: pass `frame` (the iframe's selector or name) with click/fill/type — e.g. card number fields in a payment frame.
- After each field that triggers validation, snapshot and read the result — don't batch ten fills and discover at submit that field two was rejected.

## 4. Advance step by step
- After clicking next/continue, wait for the signal the step changed: `waitfor url:<next-step-part>` or `waitfor <selector>` for a field that only exists on the next step.
- Re-run `inputs` on each new step; selectors from the previous step are void.
- Uploads and async checks (address verification, username availability) settle on `waitfor networkidle` — check the field's own status text before moving on.

## 5. Confirmation handling
- Before a final submit that is irreversible or costly (placing an order, paying, deleting, changing account credentials), stop and get the user's go-ahead unless they already authorized that exact submission.
- After submitting, wait for the confirmation signal: a success URL (`waitfor url:success` / `url:confirmation`), a confirmation selector, or a reference number in the page — then `extract` it.
- Report what was submitted and the confirmation evidence (order/reference number, confirmation text, final URL). A clicked button is not a completed form.

## Pitfalls
- Silent validation: the submit "does nothing" because a field above is invalid — snapshot and read the errors, and check the console-errors section of the result.
- Filling a honeypot or hidden field because `inputs` listed it — skip fields that are not visible.
- Assuming the last step submitted: wizards often end on a review page with a separate final confirm button.
- Re-filling from scratch after a mid-form failure — state persists across calls; navigate the existing session back to the failing step instead.
