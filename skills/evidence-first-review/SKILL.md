---
name: evidence-first-review
description: Use when reviewing code, investigating a bug, or validating a claim. Requires file:line evidence, a reproduction, and explicit uncertainty instead of confident guesses.
---

# Evidence-first review

Apply this when the task is to explain, review, or debug rather than to implement.

## Rules

1. Read the code before judging it. No claims from filenames or prior context alone.
2. Every factual claim names `file:line` or a command and its output.
3. Separate:
   - **Observed**: reproduced or read directly.
   - **Inferred**: consistent with the code but not executed.
   - **Unknown**: requires a runtime, credential, or environment you do not have.
4. A bug report needs: trigger, observed behavior, expected behavior, and the smallest relevant code path.
5. Do not propose a fix until the failure mode is stated. If you cannot reproduce it, say what you tried.

## Review checklist

- Inputs: empty, null, huge, duplicate, malformed, unicode.
- State: retries, concurrency, cancellation, partial failure.
- Boundaries: file paths, shell arguments, URLs, permissions.
- Tests: does an existing test exercise this path? If not, what would catch a regression?

## Output

```
## Verdict
One sentence: correct / incorrect / unknown.

## Evidence
- file:line — quoted line and why it matters.
- command — output summary.

## Risks
- severity, trigger, impact.

## Next check
The single cheapest test or command that would confirm or falsify the verdict.
```
