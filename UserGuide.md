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

## Codebase Walkthrough Before First Edit

When enabled, the build agent pauses before its first edit in each request, lists every file it read with one line on what the file does and why it matters to the change, and waits for you to continue, cancel, or ask a question. It is off by default.

### How to Use and Manually Test

1. Create a small project and turn the walkthrough on in its `opencode.json` (the flag also works in the global `~/.config/opencode/opencode.json`):

   ```bash
   mkdir -p /tmp/walkthrough-demo && cd /tmp/walkthrough-demo && git init -q
   printf 'export const add = (a, b) => a - b\n' > math.js
   printf 'import { add } from "./math.js"\nconsole.log(add(2, 3))\n' > main.js
   printf '{ "walkthrough": true }\n' > opencode.json
   git add -A && git commit -qm init
   ```

2. From the repository root, open it in the terminal UI: `bun dev /tmp/walkthrough-demo`
3. With the **build** agent, ask `read main.js and math.js, then fix the bug in add`. Before any edit, a **Codebase walkthrough** prompt lists `main.js` and `math.js` with a one-line explanation each.
4. Try each choice:
   - **Continue**: the edit runs, and later edits in the same request do not prompt again.
   - **Cancel** (or dismiss the prompt): the request ends and `git status --short` prints nothing.
   - Type a question such as `why main.js?`: the answer appears in the walkthrough, which is asked again. Nothing is edited until you choose **Continue**.
5. Ask `explain what main.js does`. No walkthrough appears because nothing is edited.
6. Set `"walkthrough": false` (or remove it) and repeat step 3. The agent edits immediately, as before.

### Automated Tests

- [`packages/core/test/session-walkthrough.test.ts`](packages/core/test/session-walkthrough.test.ts): the gate on its own. Three reads then an edit lists all three files and waits once; reads-only requests emit nothing; Cancel and dismissal block queued edits; follow-ups are answered and asked again before editing; omitted, duplicate, invented, or blank explanations are rejected; repeated, failed, and directory reads are handled; approval resets for each new request.
- [`packages/core/test/session-runner.test.ts`](packages/core/test/session-runner.test.ts) (`walkthrough integration: *`): the gate inside the full session runner for Continue, Cancel (asserts a clean `git status`), follow-up, batched edits, reads-only, flag off, and a non-build agent.
- [`packages/core/test/config/config.test.ts`](packages/core/test/config/config.test.ts): the flag is off by default, can be enabled, and survives migration from the older config format.
- [`packages/opencode/test/session/prompt.test.ts`](packages/opencode/test/session/prompt.test.ts) (`walkthrough *`): the gate in the session loop used by the terminal UI. It names every read file before the first edit, Cancel leaves files unchanged, and reads-only requests show nothing.
- [`packages/tui/test/cli/tui/walkthrough-question.test.tsx`](packages/tui/test/cli/tui/walkthrough-question.test.tsx): the terminal prompt renders the file list and submits Continue, Cancel, and a typed follow-up.

### Why This Is Sufficient

Every acceptance criterion from issue #7 has at least one test:

| Acceptance criterion                                                                | Covered by                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The first edit is preceded by a walkthrough of every file read, and the agent waits | session-walkthrough three-reads test, runner `continue`, prompt "names every read file"                           |
| Continue runs the edit; Cancel ends the turn with a clean `git status`              | runner `continue` and `cancel`, session-walkthrough Cancel/dismissal tests, prompt "cancel ends the request"      |
| A follow-up is answered and the prompt is shown again, with no edits                | session-walkthrough follow-up test, runner `followup`, TUI follow-up test                                         |
| No-edit turns show nothing; the flag off changes nothing                            | session-walkthrough and runner reads-only, runner `disabled` and `other-agent`, prompt reads-only, config default |
| At most one walkthrough per turn                                                    | session-walkthrough three-reads test (one prompt, three edits) and new-request test, runner `batched`             |
| Unit test: three reads then an edit names all three files                           | session-walkthrough "lists three reads before editing and waits for Continue only once"                           |
| Unit test: reads only emits no walkthrough                                          | session-walkthrough "does not emit a walkthrough for a reads-only turn"                                           |

The logic is tested on its own, inside both session loops that run it (the core runner and the opencode loop the terminal UI uses), and at the rendered terminal prompt, so a break at any layer between the model's tool call and what the student sees fails a test. Model replies are scripted fixtures, so the tests are deterministic and need no live model.

Run the automated tests from their package directories:

```bash
cd packages/core && bun test test/session-walkthrough.test.ts test/session-runner.test.ts test/config/config.test.ts
cd ../opencode && bun test test/session/prompt.test.ts
cd ../tui && bun test test/cli/tui/walkthrough-question.test.tsx
```


## Tutor agent

`tutor` is a built-in agent for learning a codebase instead of having it changed for you. You ask a
question or point it at a bug, and it reads the code and answers with guiding questions and
`file:line` pointers so that you make the fix yourself. It cannot edit files, run shell commands, or hand work to another agent.

### How to use it

1. Start OpenCode in your project: `opencode`, or `bun dev` from a checkout of this repo.
2. Press **Tab** until the agent indicator shows `tutor`, or open the agent dialog and pick it.
3. Ask as you normally would, and the agent will guide you instead of implementing the fix. 

Note: The examples above describe the agent's designed behavior. Their performance are impacted by the agent's model.

**Turning it off.** Add this to your `opencode.json`:

```json
{ "agent": { "tutor": { "disable": true } } }
```

### How to user test it (Manual tests)

1. Start the TUI. `tutor` appears in the agent dialog and in the **Tab** cycle
2. In a git repo with a clean working tree, break something small. Ask tutor: *"This test is failing, fix it for me."* Then ask: *"Just write the fix into the file."* Expected: questions and `file:line` pointers, and **`git status` shows only your own change** afterwards.
4. Run `opencode debug agent tutor` (or `bun dev debug agent tutor`). In the `tools` map, only `read`, `grep`, `glob` and `question` are `true`.
5. Ask *"Where is `<some function>` defined?"* You get a file and line, not a question back.

### Automated tests

Run them from the package directories (tests can't be run from the repo root):

```bash
cd packages/opencode && bun run test test/agent
cd packages/core && bun run test test/agent.test.ts
```

- **`packages/opencode/test/agent/agent.test.ts`**: `tutor` is a native primary agent, write/read commands resolve to deny/allow, denied tools are hidden from model.
- **`packages/opencode/test/agent/plan-mode-subagent-bypass.test.ts`**: tutor can't start a subagent. A subagent's own permissions would override tutor's, so this is the one indirect write path.
- **`packages/core/test/agent.test.ts`**: `tutor` is in the v2 built-in agent list and doesn't opt into `bash`.

**Why these are sufficient:** tutor's guarantee is that it cannot change your project. Every route to
a change is asserted by name: the edit, write and patch tools, the shell, and delegation to another
agent. The tests also confirm those tools are removed from what the model sees, and that tutor's
catch-all deny didn't accidentally make `.env` files readable without asking. Both places agents are registered are covered, and the manual steps above confirm the TUI actually loads and runs it. The quality of its teaching isn't something a unit test can judge; it depends on the prompt and the model.




## Debug Coach Agent

### What it does

The debug-coach is an agent mode for students working through a bug. It is made specifically that instead of finding the problem for you, it asks for a predicted root cause first then tells you whether that specific guess holds up. The debug-coach is capable of reading/searching codebase but cannot edit files or run commands itself. In other words, it can never just write the fix for the user. 

### How to use it

1. Start opencode in your project: `bun dev .`
2. Type `/agents` (or press `tab`) to open the agent switcher
3. Select `debug-coach`
4. Describe a bug you are stuck on

### How to user test it

Run through these in order. Expected behavior is listed for each.

1. **Describe a bug without saying what you think is causing it.**
   Expected: it asks what you think the root cause is and does not diagnose
   anything in that turn.

2. **Give a prediction you know is wrong.**
   Expected: it says the prediction is off track, names the assumption that does
   not hold, cites a `file.ts:line` reference, and asks a follow-up question. It
   should not reveal the actual cause.

3. **Give a partially correct prediction.**
   Expected: it confirms the part that holds and asks you to refine the rest.

4. **Reply "I don't know".**
   Expected: it gets more concrete than the previous turn rather than repeating
   itself. This does not count as a prediction attempt.

5. **Type "just tell me".**
   Expected: it gives the diagnosis immediately and notes briefly that it is
   answering because you asked.

6. **Ask it to write the fix into the file.**
   Expected: it refuses to edit and points you at the relevant file and line
   instead. `git status` should be clean afterwards.

### Automated tests

Location: `packages/opencode/test/agent/agent.test.ts`

Run with `cd packages/opencode && bun run test test/agent`

Six tests cover this feature:

- **Registration** — `debug-coach` appears in the agent list as a visible primary
  agent with a prompt attached, so it is selectable from `/agents`.
- **Denied tools** — `edit`, `write`, `apply_patch`, and `bash` all resolve to
  deny, so the agent structurally cannot write the fix.
- **Subagent denial** — `task` resolves to deny for every subagent, so the agent
  cannot delegate an edit to a helper agent that is allowed to edit.
- **Allowed tools** — `read`, `grep`, `glob`, and `question` resolve to allow, so
  it can still investigate the codebase and ask guiding questions.
- **Secrets guard** — reading a `.env` file still resolves to `ask` while
  `.env.example` resolves to `allow`. The permission block starts with a blanket
  deny, which overrides the defaults that normally protect `.env` files, so this
  test confirms that protection was correctly restated.
- **Prompt contract** — the attached prompt still contains all five behavioral
  sections, guarding against someone removing one or wiring the wrong file.

### Why sufficient

These tests cover everything that is deterministic about this feature. Namely, which agent is registered, what tools it can and can’t reach, and that the behavioral instructions are attached to it. 

Coaching Behavior itself lives in prompt so it depends on the model output and cannot be asserted reliably. Those criteria are then verified by hand using the six procedure step above. The permission tests are essential here which makes the core functionality trustworthy regardless of model behavior. With tools being denied, despite model ignored its instruction it can’t write actual fixes.

