# Traceability: bnajibmo

**Target feature:** Codebase walkthrough before first edit (config flag `walkthrough`)

**Files:**

- packages/core/src/session/runner/walkthrough.ts (the gate)
- packages/core/src/session/runner/llm.ts
- packages/core/src/plugin/agent.ts
- packages/opencode/src/session/walkthrough.ts (the same gate for the terminal UI's session loop)
- packages/opencode/src/session/prompt.ts
- packages/core/src/config.ts

**Property tests:** packages/opencode/test/session/walkthrough.property.test.ts (harness and generators in walkthrough.harness.ts)

**Mutants (P5):** mutants/bnajibmo/ (H1 to H5 hand-written, S1 from Stryker, mutation.html, the opencode prompt and reply)

**Stryker config (P5):** packages/opencode/stryker.bnajibmo.config.json

Interview IDs (C-, S-, O-) are from my Project 3 workbook.

## Requirements

| ID  | Interview evidence                                                                                                     | Requirement                                                                                                                                                                        | Acceptance criteria                                                                                                                                                                                                                        | Changed in P4? | Property (kind)                                                                                                                                                                                        | Test                                                                           | Mutants it kills |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------- |
| R1  | S-1, C-1, O-1: "The agent should never edit a file."                                                                   | Until the user chooses Continue, the edit, write, and apply_patch tools change no file in the project. After Cancel, no file has changed.                                          | With the walkthrough on in a git repo, the agent reads main.js and math.js, then calls edit on math.js. While the prompt is open, and after Cancel, `git status --short` prints nothing. After Continue, math.js is changed.               | No             | Invariant: no held tool runs before Continue, and none runs after Cancel or dismiss; one prompt per request, offering Continue and Cancel                                                              | `R1: no gated edit runs before Continue, and none runs after Cancel`           | H3, H2           |
| R2  | S-1: "I don't want the agent to modify the file in any way before I told it to do so." O-2: "never in the target file" | Until the user chooses Continue, the bash tool is held the same way as the edit tools: its first call shows the walkthrough and waits, Continue lets it run, and Cancel blocks it. | With the walkthrough on and no Continue yet, the agent calls bash with `sed -i 's/a - b/a + b/' math.js`. The walkthrough prompt appears first. After Cancel the command never runs and `git diff` prints nothing. After Continue it runs. | Yes            | Invariant: bash prompts first, runs only after Continue, and never runs after Cancel or dismiss                                                                                                        | `R2: bash is held behind the walkthrough like an edit`                         | H2               |
| R3  | C-2, O-3: "It should always list every file that the agent read."                                                      | The walkthrough lists every file the agent successfully read in the current request, each one once.                                                                                | The agent reads greeting.ts, settings.ts (twice), and greeting.test.ts, then edits greeting.ts. The walkthrough lists exactly those three paths, each once. A walkthrough that leaves one out is refused and no prompt is shown.           | No             | Model/oracle: the gate accepts a list exactly when it equals the set of files read, with no repeats; checked on exact, reordered, respelled, dropped, duplicated, swapped, repeated, and missing lists | `R3: the gate accepts a list exactly when it matches the set of files read`    | H1, H2, S1       |
| R4  | C-3: "and it should only list files that were read." S-3                                                               | The walkthrough's file list contains only files the agent read in the current request.                                                                                             | The agent reads only math.js, then submits a walkthrough listing math.js and utils.js. The edit is refused, no prompt is shown, and no file changes.                                                                                       | No             | Invariant: adding any unread path is refused, with no prompt and no edit                                                                                                                               | `R4: a list naming an unread file is refused and nothing runs`                 | none             |
| R5  | S-4: "I'd expect same output as the first time." C-4                                                                   | If the user cancels and sends the exact same request again, the walkthrough appears again before the first edit, with the same file list.                                          | With scripted model replies (read a.ts, b.ts, c.ts, then edit a.ts), the user chooses Cancel, then resends the same message. The prompt appears again listing a.ts, b.ts, c.ts in the same order, and no file changes until Continue.      | No             | Round-trip: cancel, rerun the same request, and the second prompt equals the first                                                                                                                     | `R5: cancel then resend shows the same walkthrough again`                      | H2               |
| R6  | S-5: "each edit could have separate relevant context", O-6                                                             | A request with several edits shows one walkthrough, before the first edit, listing every file read so far; later edits in the same request run without another prompt.             | The agent reads three files, then makes three edits in one request. The user is asked once, before the first edit. After Continue all three edits run with no further prompt.                                                              | Yes            | Metamorphic: more edits in one request never add prompts; the count stays at 1                                                                                                                         | `R6: one request prompts once however many edits it makes`                     | H2               |
| R7  | C-6: "The walkthrough should appear again if it's using the same files, for every prompt you push."                    | Approval covers one request only: each new message that leads to an edit shows a new walkthrough.                                                                                  | After choosing Continue in one request, the user sends a second message that edits the same file. The walkthrough appears again before that edit.                                                                                          | No             | Metamorphic: each extra request that edits adds exactly one prompt                                                                                                                                     | `R7: every request that edits prompts again`                                   | H4, H2           |
| R8  | C-7: "You could ask clarification to an agent, or do it manually." S-6                                                 | At the walkthrough prompt, the user can type a question about a file. The answer appears in a new walkthrough, and nothing is edited until the user chooses Continue.              | At the prompt, the user types "why settings.ts?". A new prompt appears with the answer and the same file list, and `git status --short` still prints nothing.                                                                              | No             | Invariant: the edit waits until the question is answered and Continue is chosen; the second prompt shows the question and answer; the prompt allows a typed answer                                     | `R8: a typed question is answered in a new prompt and edits wait for Continue` | H5, H2           |

Properties written or suggested by opencode or another AI tool: all eight, written with Claude Code. I checked each one against the requirement and my interview notes. Generator choices are explained in comments in the harness file. H2 appears in most rows because `every` on an empty list is true, so with no reads that mutant refuses everything; the case it was designed for is covered by R3 (see below).

## Requirement changes

| ID  | Original requirement (P3)                                                                                                                | Revised requirement                                                                                                                                                                | Why it changed                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2  | New: until the user chooses Continue, a shell command also cannot change any file in the project. Today only the edit tools are blocked. | Until the user chooses Continue, the bash tool is held the same way as the edit tools: its first call shows the walkthrough and waits, Continue lets it run, and Cancel blocks it. | Feasibility. The gate can't tell what a shell command will do to the disk, so it can't block only the commands that write. Holding every bash call until Continue can be built and gives S-1 and O-2 what they asked for: nothing touches the project before they say yes. The cost is that a request that only runs a command now prompts once too. |
| R6  | New: when one request makes several edits, a walkthrough appears before each edit. Today it appears once per request.                    | A request with several edits shows one walkthrough, before the first edit, listing every file read so far; later edits in the same request run without another prompt.             | Conflict. R7 says one approval covers the whole request, and the classmate wanted one walkthrough per request (C-5). What S-5 and O-6 wanted was the context behind each edit, and the one walkthrough already lists every file read (R3).                                                                                                           |

R1, R3, R4, R5, R7, and R8 are kept as written: the code does them and they can be checked directly.

## Step 3 triage

- R2 failed on the shrunk counterexample `[[], "a", "Continue"]`: with no files read, a bash call ran with no prompt. Code bug: the gate only held edit, write, and apply_patch. Fix: added bash to the held tools in both gates and named bash in the model instructions (`packages/core/src/plugin/agent.ts`).
- The other seven passed on the first run. After the fix, all eight pass and the existing walkthrough tests in `packages/core` and `packages/opencode` still pass.

## Hand-written mutants

All five change `packages/core/src/session/runner/walkthrough.ts`. To run one: `git apply mutants/bnajibmo/H1.patch`, then `cd packages/opencode && bun test test/session/walkthrough.property.test.ts`, then `git checkout -- packages/core/src/session/runner/walkthrough.ts`. Predictions were written before the first run.

| ID  | Requirement targeted | Change                                                                                                                                      | Predicted killer                                                                                                 | Actual result                                                                                                                                                                                                                |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | R3                   | The `new Set(listed).size !== files.size` check is removed, so a list that names one read file twice and leaves another out is accepted.    | Survives: R3's duplicate case appends a copy, so the list is one too long and the length check still refuses it. | Survived, as predicted. Killed by R3 after adding the "repeat" case (same length, one entry repeated).                                                                                                                       |
| H2  | R4                   | `listed.some((file) => !files.has(file))` becomes `every`, so a list with one unread file swapped in for a read one is accepted.            | Survives: R4 always adds a path, so the length check refuses the list before this line matters.                  | Killed by R1, R2, R3, R5, R6, R7, R8, but not for the reason I designed it: `every` on an empty list is true, so with no reads the mutant refuses everything. The swap itself was untested until R3's "swap" case was added. |
| H3  | R1                   | The `if (cancelled) return ...` short-circuit is removed, so after Cancel the next edit prompts again instead of being blocked.             | Survives: R1 checks that nothing ran, not how many prompts appeared.                                             | Survived, as predicted. Killed by R1 after asserting exactly one prompt per request.                                                                                                                                         |
| H4  | R7                   | `reset()` no longer clears `approved`, so the second request runs with no prompt.                                                           | R7                                                                                                               | Killed by R7, as predicted.                                                                                                                                                                                                  |
| H5  | R8                   | The `followup && !details.walkthrough_answer` check is removed, so an edit that ignores the user's question is prompted instead of refused. | R8                                                                                                               | Killed by R8, as predicted.                                                                                                                                                                                                  |

## Stryker comparison

**Setup.** Config: `packages/opencode/stryker.bnajibmo.config.json`. The command runner runs only `test/session/walkthrough.property.test.ts`. It mutates `src/session/runner/walkthrough.ts` lines 17 to 29 and 46 to 138 (the gate's state, `reset`, and `settle`); `definitions` (lines 30 to 44) is left out because no property calls it. The gate lives in `packages/core` while Stryker is installed in `packages/opencode`, so the config uses `inPlace` and is run from core: `cd packages/core && ../opencode/node_modules/.bin/stryker run ../opencode/stryker.bnajibmo.config.json`. The report and scratch folder go to `packages/opencode/reports/` and `.stryker-tmp/` (gitignored); the final report is copied to `mutants/bnajibmo/mutation.html`. Seed: `fc.configureGlobal({ seed: 42 })` at the top of the test file. 151 mutants, about 4 minutes per run.

**Scores.**

- First run, P4 properties as merged: 56.29% (85 killed, 66 survived).
- Final run, after strengthening: 82.12% (124 killed, 27 survived).
- Excluding the 17 equivalent mutants listed below: 124 / 134 = 92.5%.

**Which hand-written mutants did Stryker never generate?** None, in effect. It produced H2 exactly (`some` to `every` on line 61). H1, H3, and H5 appear as the blunter `false` for the whole condition (lines 60, 52, 62). H4 appears as `approved = true` in `reset` (line 26), which has the same effect as never clearing it. What Stryker can't do is delete one statement from a block: it empties the whole `reset` body instead, so H4's exact shape doesn't exist. Stryker's L52 and L60 mutants survived the first run just like H3 and H1, so the predictions carried over.

**Which Stryker survivors would I never have thought of?** Four, all plausible bugs:

- Line 118, `result.output?.structured` to `result.output.structured`: a failed read, which has no output, crashes the gate instead of being skipped.
- Line 56, `details?.walkthrough` to `details.walkthrough`: a model reply with no list at all crashes the gate instead of being refused.
- Line 117, `execute({ ...input, call: ... })` to `execute({})`: the tool runs with no arguments.
- Line 71, `join("\n")` to `join("")`: every file on one line of the prompt.

A developer removing a `?.` they think is unnecessary, or dropping the call's input in a refactor, would write the first three. My first properties only ever sent a correct list and never looked at what the tool received, so all four survived.

**What each approach finds that the other doesn't.** Hand-written mutants test the meaning of a requirement: a same-length swap, a repeated entry, one assignment missing from `reset`. I knew which property should catch each, and the two that survived (H1, H3) pointed straight at a generator gap and a missing assertion. Stryker is blind to meaning but exhaustive: it found the crash paths, the prompt formatting, and the argument passing, which I had not thought to check, and showed where my generators never went (no reads, no list). It also produced a lot of noise in message text and type guards.

**Strengthening.** No example tests were added. Changes to the properties and the harness:

- R1: exactly one prompt per request (kills H3 and the `cancelled` mutants on lines 52, 90, 95); the prompt's options are exactly Continue and Cancel (kills the option-label mutants on lines 81 to 83).
- R3: three new list mutations, "swap" (one read file replaced by an unread one, same length), "repeat" (one entry repeated, same length), and "missing" (no list at all); each file must appear on its own line of the prompt. Kills H1, S1, and lines 56, 60, 61, 71.
- Harness: a read never crashes the gate (line 118); a grep-style search over a path doesn't count as a read (line 120); the tool receives the call's own arguments without the walkthrough fields (lines 112, 114, 117).
- R8: the prompt allows a typed answer, `custom: true` (line 85).

**Equivalent mutants (17).**

- Line 56, `?? []` to `?? ["Stryker was here"]`: the default is only reached when `details` is undefined, and the very next check, `!details`, refuses the call before `listed` is used. No input can observe it.
- Line 93, `answers[0]?.[0]` to `answers[0][0]`: `ask` resolves with one answer array per question, and the gate always asks exactly one question. When the user dismisses, `ask` fails instead of returning an empty list, so `answers[0]` is always defined.
- Line 112, eight mutants on `edits.has(name) && typeof call === "object" && call !== null && !Array.isArray(call)`: a tool call's input is always the JSON object of the model's arguments, never null or an array, so each guard is always true. Stripping the walkthrough fields from a read's input is a no-op because reads never carry them. Replacing a guard with `true` or an `&&` with `||` gives the same result for every real call.
- Line 121, two mutants on `result.result.type !== "error"`: a read that fails returns no `output`, so `"content" in output` already excludes it, and no tool returns a result type of `""`.
- Lines 122, 123, 125, 126, 127, type guards on the read call and its output: the read tool's input is always an object with a string `path`, and its structured output is a non-null object whenever present. Each guard is always true.

**Remaining survivors, not equivalent (10).** Line 67 (four mutants) and line 103: the error message text returned to the model. Line 72: the "No files have been read in this request." sentence. Line 76: the question's message and call reference. Line 79: the prompt header. Lines 82 and 83: the option descriptions. No requirement says what these texts must be, and they are observable, so I don't count them as equivalent. Killing them would mean asserting exact strings, which is an example test, so they stay.

## Agent failure case

**How the property was produced.** None of my eight properties came from opencode, so I asked it for one: `opencode run -m local/qwen3.5-9b "<prompt>"` with a local Qwen3.5 9B model. The prompt gives the harness and generators from the test file and asks for one property for R4. The full prompt and reply are in `mutants/bnajibmo/agent-prompt.txt` and `mutants/bnajibmo/agent-response.txt`. No share link: a local run has nothing to share to.

**Transcript excerpt.** Prompt (shortened; the harness code followed it):

> Below is the test harness and the generators from packages/opencode/test/session/walkthrough.property.test.ts. Using them, write one new fast-check property for this requirement: R4: The walkthrough's file list contains only files the agent read in the current request. Acceptance criteria: the agent reads only math.js, then submits a walkthrough listing math.js and utils.js. The edit is refused, no prompt is shown, and no file changes. Reply with only the TypeScript code of the test ...

Reply, verbatim:

````
> build · qwen3.5-9b
```ts
describe("R4 walkthrough file list gate", () => {
  test("walkthrough lists only files read in current request", async () => {
    fc.assert(
      fc.asyncProperty(fc.constantFrom(fc.constantFrom("math.js"), fc.constantFrom("utils.js"))),
      async ({ mathPath, utilsPath }) => {
        const { gate, prompts, order, run, read, ranHeld } = harness(["math.js", "submit"])
        await read([{ path: mathPath, kind: "file" }])
        const editResult = await run("edit", { file: utilsPath, content: "x=1" })
        expect(prompts).toEqual([])
        expect(order).toEqual(["read", "edit"])
        expect(editResult).toBe("refused")
        expect(ranHeld()).toEqual([])
        expect(gate.state).toBe("blocked")
      },
    )
  }, { timeout: 30000 })
})
```
````

The property is checked in as `packages/opencode/test/session/walkthrough.agent.property.test.ts`. It did not run as written: the generator didn't produce `{ mathPath, utilsPath }`, `gate.state` doesn't exist, `fc.assert` wasn't awaited, and `order` can't contain an edit that was refused. Those four edits are listed at the top of the file; nothing else was changed. It is kept out of the Stryker command so the score only reflects my properties.

**The mutant it let survive.** S1 (`mutants/bnajibmo/S1.patch`), Stryker's line 61 mutant from the first run: `listed.some((file) => !files.has(file))` becomes `listed.some(() => undefined)`, so the unread-file check never fires and a list naming an unread file is accepted whenever its length matches. H2 (`some` to `every`) survives it too.

```
git apply mutants/bnajibmo/S1.patch
cd packages/opencode
bun test test/session/walkthrough.agent.property.test.ts      ->  1 pass, 0 fail   (survived)
bun test test/session/walkthrough.property.test.ts -t R4      ->  1 pass, 0 fail   (my P4 R4 alone: survived)
bun test test/session/walkthrough.property.test.ts            ->  7 pass, 1 fail: R3   (killed)
git checkout -- packages/core/src/session/runner/walkthrough.ts
```

**Why the property was too weak.** It is one fixed example, math.js and utils.js, inside `fc.asyncProperty`, so fast-check adds nothing. More important, it never sends a `walkthrough` field at all (`{ file: utilsPath, content: "x=1" }`), so the gate refuses the edit because the list is missing, not because utils.js is unread. The line that R4 is about is never reached, which is why disabling it changes nothing. The same weakness, in a milder form, was in my own R4: it always adds a path, so the length check does the refusing and the unread-file check is never the deciding line. That is why R4 alone also let S1 survive.

**Strengthened version.** R3's model/oracle property now generates a "swap" list, one read file replaced by an unread one at the same length, and expects it refused with no prompt. In `walkthrough.property.test.ts`:

```ts
const unread = names.map((n) => path.resolve(dir, n)).filter((p) => !files.includes(p))
...
swap: files.length && unread.length ? files.map((p, i) => (i === pick ? unread[seed % unread.length] : p)) : files,
```

With S1 applied, `bun test test/session/walkthrough.property.test.ts` fails on R3 (shown above); on the real gate all eight pass. The same case kills H2 when reads are present, not only through the empty-list accident.
