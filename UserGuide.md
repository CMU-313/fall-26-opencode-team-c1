# User Guide

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


