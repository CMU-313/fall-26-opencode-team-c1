# User Guide

## Nudge for Broad Prompts

Relevant automated tests are located in:

- [`packages/tui/src/prompt/scope.test.ts`](packages/tui/src/prompt/scope.test.ts): broad and bounded patterns, shell/slash exclusions, and learning-focused suggestions.
- [`packages/opencode/src/prompt-scope/classifier.test.ts`](packages/opencode/src/prompt-scope/classifier.test.ts): classifier prompt construction and strict response validation.
- [`packages/opencode/src/prompt-scope/service.test.ts`](packages/opencode/src/prompt-scope/service.test.ts): model selection, successful classifications, failures, invalid responses, and timeouts.
- [`packages/opencode/test/cli/run/footer.view.test.tsx`](packages/opencode/test/cli/run/footer.view.test.tsx): rendered nudge behavior, normal submission, command exclusions, user actions, and silent fallback.
- [`packages/opencode/test/server/httpapi-prompt-scope.test.ts`](packages/opencode/test/server/httpapi-prompt-scope.test.ts): request validation and unavailable-service responses.

### Why This Is Sufficient

Together, these tests evaluate that the acceptance criteria are met across every layer changed by the feature:

- Broad prompts show a learning-focused suggestion before submission.
- Bounded prompts submit normally without a nudge.
- Shell and slash commands bypass the nudge.
- Dismiss, **Ask anyway**, and **Use suggestion** preserve the expected prompt behavior.
- Classification failures and timeouts fall back silently to normal submission.

The tests cover prompt detection, classifier validation, service and HTTP failure handling, rendered CLI output, and each user submission path. This provides unit coverage for decision logic and integration coverage for the user-visible behavior.

### How to Use and Manually Test

1. From `packages/opencode`, start the CLI with either:
   - `bun dev`
   - `bun dev --mini`
2. Enter a broad prompt such as `do my whole project` and confirm that a nudge with a learning-focused suggestion appears before submission.
3. Enter a narrow prompt such as `add validation to the login form` and confirm that it submits normally without a nudge.
4. For a broad prompt, select **Use suggestion** to place the suggestion in the composer or **Ask anyway** to submit the original prompt.

Run the automated tests from their package directories:

```bash
cd packages/tui && bun test src/prompt/scope.test.ts
cd ../opencode && bun test src/prompt-scope/classifier.test.ts src/prompt-scope/service.test.ts test/cli/run/footer.view.test.tsx test/server/httpapi-prompt-scope.test.ts
```