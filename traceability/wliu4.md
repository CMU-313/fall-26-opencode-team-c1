# Traceability - wliu4

Feature: the read tool (`packages/opencode/src/tool/read.ts`)

Tests: `packages/opencode/test/tool/read.property.test.ts`

Interview IDs (C-, S-, O-) are from my Project 3 workbook.

## Requirements

| ID | Interview evidence | Requirement | Acceptance criteria | Changed in P4? | Property | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-2, S-2, O-2, O-3: "Even if you ask them to open they shouldn't open." | If the user's read rules deny a file, the read tool refuses it and returns none of its contents. The decision only depends on the rules and the file path, so a new session with the same rules denies it too. | For any path matching a deny rule, the rules return deny every time, and the read output contains none of the file. | Yes | Invariant: denied files are refused in two separate sessions and the secret never shows up | R1: a denied file is always refused and none of its contents leak | H1 |
| R2 | O-3, C-3, S-2: "It should have the function to ask for permission." | By default, reading a .env file asks the user first, and the contents are only returned if the user approves. | Default config: reading .env asks first. Deny gives an error with no contents. Allow gives the contents. .env.example does not ask. | No | Invariant: .env files always ask once, contents only on allow, .env.example never asks | R2: with default rules, .env files ask first and only return contents if approved | H1, H2 |
| R3 | C-4, S-3, O-4: "if changed file to whatever it was the output should be the same" | If a file is changed and then restored, reading it again shows the same file content as the first read (same numbered lines and footer). | Read as A, edit one line, restore, read as B. The content part of A and B is identical. | Yes | Round-trip: edit then restore, content matches | R3: change a file, restore it, and the read content is identical | None. R3 reads the same file twice, so any mutant changes both reads the same way and they still match |
| R4 | C-5, S-4, O-5: "The second read should have the exact lines except for the newly edited lines." | Adding lines to the end of a file does not change the lines already shown. Only the new lines and the total change. | Read a 5-line file, add 3 lines, read again. Lines 1-5 are the same, lines 6-8 are new, total goes from 5 to 8. | No | Metamorphic: after appending, old lines stay the same and the total grows by the number added | R4: appending lines keeps earlier numbered lines and grows the total | None. H3 targeted R4 but R4 always reads from line 1, so R5 killed it |
| R5 | O-6, S-5: "Hard to know when the workload is very large" | When a file is too long to show at once, the output says which lines were shown and how to get the rest. | A 2500-line file shows lines 1-2000 and says "Use offset=2001 to continue." Reading from offset 2001 shows the rest. | No | Invariant: any cut-off read says which lines it showed and where to continue (line limit and 50 KB cap) | R5: a cut-off read always says which lines it showed and where to continue | H3, H4 (H4 after strengthening) |
| R6 | C-6, S-1: "ask ai to trace back to specific code lines" | Every line shown starts with its line number in the file. A line over 2000 characters shows its first 2000 characters plus "... (line truncated to 2000 chars)". | Offset 10, limit 3 on a 20-line file shows lines 10, 11, 12 matching the file. A 2050-character line is cut at 2000 with the notice. | Yes | Model/oracle: output matches a simple reader that splits the file into numbered lines | R6: every shown line matches the file at the line number it claims | H5 (after strengthening) |

## Requirement changes

R1
- Original: ...refuses to read it and returns none of its contents, even when the user asks for that file by name. This still holds in a new session.
- Revised: same, but the new session part is now "the decision only depends on the rules and the file path, so a new session with the same rules denies it too."
- Why: checkability. I can't close and reopen opencode inside a test. The read tool doesn't remember anything between sessions anyway, the rules come from the config each time. Users (C-2, O-3) just wanted a deny to always stick.

R3
- Original: reading it again gives output identical to the first read.
- Revised: reading it again shows the same file content (numbered lines and footer).
- Why: feasibility. If there is an AGENTS.md nearby, opencode adds its instructions to the output only on the first read in a message, on purpose. I tested it and the full output really is different the second time even though the file is the same. Users (C-4, S-3, O-4) were talking about the file content, so that is what the revised version checks.

R6
- Original: every line shown starts with its line number and matches the file.
- Revised: added that a line over 2000 characters is cut with a notice.
- Why: feasibility. This came up in Step 3. read.ts cuts long lines on purpose since one huge line could go past the 50 KB output limit. Users (C-6, S-1) still get correct line numbers and can see when a line was cut.

R2, R4, and R5 are kept because the code already does them and they can be tested directly.

## Step 3 triage

- R4 failed on `[[""], ["a"], false]`. Wrong test. My test thought a file made from one empty line had 1 line, but that file is empty so it has 0 lines, which is correct. Fixed the test to count lines from the actual file text.
- R6 failed on `{"lines": [""], "offset": 1, "limit": 1}`. Wrong test, same reason as R4. Same fix.
- R6 failed on a single line of about 2001 characters. Requirement problem. The tool cuts lines over 2000 characters on purpose. Revised R6 (above) and updated the test to expect the cut.

All 6 properties pass now.

## AI use

I used Claude to write and run all six properties (R1-R6) and to suggest the requirement changes and triage outcomes. The requirements and interview evidence are mine from Project 3. I reviewed the properties, changes, and triage against my notes before committing.

For P5 I used Claude to suggest the five hand-written mutants, sort the Stryker survivors, write the strengthened properties, and draft the Stryker comparison below. I ran every mutant and both Stryker runs on my own machine, and I checked each change and each equivalent mutant argument against the code before committing.

## Hand-written mutants

Patches are in `mutants/wliu4/`. Predictions were written before running any of them.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R1 | read.ts: the permission check uses just the file name (`path.basename(filepath)`) instead of the path from the project root, so a deny rule like `secret/ssn.txt` stops matching | R1, since the secret should leak when the file is in a folder. R2 too, since it checks the pattern is the full path | Killed by R1 and R2, as predicted. R1 counterexample: `config/secrets.txt` was read and the secret leaked. R2 counterexample: `config/.env` was asked about as `.env` instead of the full path |
| H2 | R2 | agent.ts: `"*.env.example": "allow"` moved above `"*.env.*": "ask"`, like someone sorting the rules. Rules use the last match, so .env.example now asks | R2, the .env.example part expects no prompt | Killed by R2, as predicted. Counterexample: `.env.example` in the root folder asked for permission |
| H3 | R4 | read.ts: the end of file footer counts the lines shown (`file.raw.length`) instead of the lines in the file (`file.count`) | Not R4, it always reads from line 1 where both numbers are the same. Maybe R5 if it reads to the end from a later offset | Killed by R5, not R4, as predicted. Counterexample: a 49-line file read from offset 45 with limit 5 said total 5 lines instead of 49 |
| H4 | R5 | read.ts: the 50 KB check changes from `<=` to `<`, so a line that would land exactly on 50 KB gets cut | Survives. The generators almost never hit exactly 51,200 bytes | Survived, as predicted. No generated file landed exactly on 51,200 bytes. After strengthening: killed by R5, which now builds files right on the 51,200 byte edge |
| H5 | R6 | read.ts: lines are cut at `>= 2000` instead of `> 2000`, so a line of exactly 2000 characters gets cut by mistake | Maybe R6. Its long lines are 1990 to 2100 characters, so it only hits exactly 2000 sometimes | Survived. R6 never generated a line of exactly 2000 characters, so the extra cut never showed up. After strengthening: killed by R6, which now generates lines of exactly 1999, 2000 and 2001 characters |

## Stryker comparison

Config: `packages/opencode/stryker.wliu4.config.json`. It runs only `test/tool/read.property.test.ts` and only mutates the code R1-R6 cover:

- `src/tool/read.ts` lines 137-180 (reading lines, the 2000 character cut, the 50 KB cap), 255-260 (permission check), 331-351 (offset check, line numbers, footers)
- `src/agent/agent.ts` lines 132-137 (default .env rules)
- `src/permission/index.ts` lines 28-38 (`evaluate`, which picks the rule)

fast-check seed: **42** (`fc.configureGlobal({ seed: 42 })` at the top of the test file).

Report: `mutants/wliu4/mutation.html` (final run).

| Run | Mutants | Killed | Survived | Score |
|---|---|---|---|---|
| First run, before strengthening | 120 | 78 | 42 | 65.00% |
| Final run, after strengthening | 120 | 107 | 13 | **89.17%** |
| Final run without the 11 equivalent mutants | 109 | 107 | 2 | **98.17%** |

The 2 left after removing equivalent mutants are the `always: ["*"]` mutants (see Survivors outside my requirements).

### Which hand-written mutants did Stryker never generate, and why?

Stryker made H4 (`<=` to `<` on read.ts line 164) and H5 (`>` to `>=` on line 162) on its own, and both survived its first run the same way they survived mine. It never made H1, H2 or H3, even though all three are inside the lines it mutated. Stryker only does small fixed swaps on one piece of code, like flipping an operator, emptying a string, or swapping true and false. H1 swaps one function for a different one (`path.relative` to `path.basename`), H2 reorders two rules in an object, and H3 swaps a variable for another one with a similar meaning (`file.count` to `file.raw.length`). Making those needs knowing what the code is for.

### Which Stryker survivors would I never have thought of? Are any plausible?

- **The newline byte in the 50 KB math (line 163).** Changing `+` to `-`, or always or never adding the 1 byte for `\n`. I never thought about the newline costing a byte. Forgetting it, or counting it for the first line too, is a very plausible off by one.
- **`{ stream: true }` removed from the text decoder (line 149).** I didn't know the file is read in 64 KB chunks, or that a letter like é or 中 can get split between two chunks. Leaving out `stream: true` is a real bug people write, and it only shows up with non-English text in big files.
- **The out of range offset check (line 332).** I never wrote anything about asking for lines past the end. Dropping the empty file exception or the whole error are both plausible.
- **`file.more || file.cut` changed to `&&` (line 343).** Plausible, and it only changes the "truncated" tag the UI shows, not the text, which is why nothing caught it.
- **Not plausible:** renaming the tracing name `"ReadTool.lines"` to `""`, or `"utf-8"` to `""`. Nobody writes those by accident.

### What does each approach find that the other doesn't?

Hand-written mutants find bugs that come from misunderstanding the feature, like checking the file name instead of the full path (H1) or putting rules in the wrong order (H2). Stryker can't make those. Stryker is better at being thorough. It tried 120 small changes and showed me three blind spots I would not have found by guessing: my R5 cap check was circular, my fake permission check didn't match the real one, and nothing tested offsets past the end. The cost is noise. 11 of the 120 can't change anything a user could see, and I had to argue each one.

### Strengthening

All fixes are to the properties. No example tests were added.

| Change | Requirement | Kills |
|---|---|---|
| The fake permission check now works like `Permission.ask`: anything that isn't allow asks. New property: normal files (notes.txt, README.md, ...) never ask under the default rules | R2 | `agent.ts` `"*": ""` and `"*.env.example": ""` |
| 50 KB cap: a small model works out how many lines should fit (each line's bytes plus 1 for each newline, up to 51,200). The generator builds files right on that edge, -2 to +2 bytes. The old check took the number of shown lines from the output itself and only checked the footer matched it, so a tool that never capped still passed | R5 | H4 and 9 Stryker mutants on lines 163-166 |
| Offsets can go up to 5 past the end, and files can be empty. Past the end must fail with "Offset N is out of range for this file (M lines)". An empty file read from line 1 must work | R5 | 10 mutants on lines 332-334 |
| `metadata.truncated` must match the footer | R5 | 3 mutants on line 343 |
| Long lines now include exactly 1999, 2000 and 2001 characters | R6 | H5 and the same Stryker mutant on line 162 |
| The output must start with `<path>`, `<type>file</type>` and `<content>` | R6 | 4 mutants on line 338 |
| Unicode letters (é, 中, emoji) split across the 64 KB read chunks | R6 | 2 mutants on line 149 |

One thing I found along the way: in the first run, `agent.ts` `"*.env": ""` and `"*.env.*": ""` were "killed", but only because my old fake permission check treated `""` like allow. After fixing the fake they survive, which is right, since the real code treats `""` the same as ask. Those two kills came from a bug in my test, not from a property catching a real problem.

### Equivalent mutants (11)

| Mutant | Why no test can kill it |
|---|---|
| `agent.ts:134` `"*.env": "ask"` to `""`, and `agent.ts:135` `"*.env.*": "ask"` to `""` | `Permission.ask` only checks for deny and allow, and everything else asks the user (`src/permission/index.ts` lines 75-81). So `""` does exactly what `"ask"` does. The only other code that compares to "ask" (`session/llm.ts`) looks at the last read rule, which is `*.env.example`, so it never sees these two. |
| `permission/index.ts:32` fallback rule to `{}`, and `:33` `action: "ask"` to `""` | This fallback is only used when no rule matches. Every caller treats an action that isn't allow or deny as ask, so a missing action or `""` acts like "ask". For reads it is never reached anyway, since the default rules start with `"*": "allow"`. |
| `permission/index.ts:35` fallback `pattern: "*"` to `""` | Nothing reads the `pattern` of the rule `evaluate` returns. `Permission.ask` only looks at `action`, and `disabled()` does its own lookup instead of calling `evaluate`. |
| `read.ts:137` `Effect.fn("ReadTool.lines")` to `Effect.fn("")` | The string is only the name of a tracing span for performance logs. It doesn't change what the function returns or what the user sees. |
| `read.ts:153` `if (flags.done)` to `if (false)`, and `read.ts:172` `flags.done = true` to `false` | `flags.done` is set on the same step that throws `ReadStop`, and `ReadStop` ends the stream right away. The check on line 153 never runs with `done` true, so removing it or never setting it changes nothing. |
| `read.ts:163` `Buffer.byteLength(line, "utf-8")` to `Buffer.byteLength(line, "")` | With an empty encoding, `Buffer.byteLength` falls back to UTF-8. I checked in Bun: both give 3 for "abc" and 9 for "é中😀". |
| `read.ts:171` `flags.more = true` to `false` in the cut branch | That branch also sets `flags.cut = true`. The footer checks `cut` first, and `truncated` is `more` or `cut`, which is still true. Once `cut` is set, `more` has no effect. |
| `read.ts:332` `file.count === 0` to `true` | The check is `count < offset && !(count === 0 && offset === 1)`. When offset is 1, `count < 1` already means count is 0, so that part is always true whenever it matters. Replacing it with `true` gives the same answer for every input. |

### Survivors outside my requirements (2)

`read.ts:258` `always: ["*"]` to `[]` and to `[""]`. This is the list of patterns opencode remembers when the user clicks "Always allow". None of R1-R6 say anything about remembering an approval, so no property checks it. These are not equivalent, since a real user would get asked again after clicking "Always allow". I left them as survivors instead of adding a property for behavior no interviewee asked about.

## Agent failure case

opencode (Build agent, GPT-6.1 Sol) wrote an R5 property for me. Its file is saved at `mutants/wliu4/agent/read.agent.property.test.ts`. I moved it out of `test/` so CI doesn't run a weak duplicate. I told it not to open my own property file so it would write its own version.

**My prompt:**

> I'm writing property-based tests (fast-check) for the read tool in packages/opencode/src/tool/read.ts. Look at packages/opencode/test/tool/read.test.ts to see how the read tool is set up in tests. Do not open read.property.test.ts, I want a separate version. Write a fast-check property for this requirement: R5: When a file is too long to show at once, the output says which lines were shown and how to get the rest. This includes the 50 KB output cap, where the output ends with "(Output capped at 50 KB. Showing lines 1-N. Use offset=N+1 to continue.)" Put it in a new file packages/opencode/test/tool/read.agent.property.test.ts with one test, and add a short comment explaining the generator. Then run it with bun test from packages/opencode and make sure it passes.

**opencode's response (shortened):**

> The tool puts the truncation notice just before </content>. I'll test both line-limit and 50 KB truncation in each generated case, checking the exact range, continuation offset, and that reading at that offset returns the next line.
>
> [creates the file, fixes a runtime error and a type error, reruns]
>
> Across 100 generated cases, it checks both line-limit and 50 KB truncation, including the exact notice, displayed line range, and continuation offset. It also verifies that reading at the suggested offset returns the next line. bun test: 1 pass, 800 assertions. bun typecheck: passed.

**The generator it wrote:**

~~~ts
// Fixed-width ASCII lines avoid per-line truncation; every case exercises both line and byte caps.
width: fc.integer({ min: 64, max: 2000 }),
...
const cappedLines = Math.floor((50 * 1024 + 1) / (width + 1))
const lines = Array.from({ length: cappedLines + extra }, (_, i) => `${i + 1}:`.padEnd(width, "x"))
~~~

**The mutant it let survive:** H4, `read.ts` line 164 `flags.bytes + size <= MAX_BYTES` changed to `<`. Stryker's `(raw.length > 0 ? 1 : 0)` to `(true ? 1 : 0)` on line 163 also survived it. Its property did kill H5 and the mutants that never cap or skip the newline byte.

**Why the property was too weak:** the oracle is fine. `cappedLines` is the right formula. The generator is the problem. Every line has the same width w, so n lines always take n×(w+1) - 1 bytes. H4 only changes the answer when a file lands exactly on 51,200 bytes, which needs w+1 to divide 51,201. 51,201 = 9 × 5,689, so the only widths that work are 8 and 5,688, and opencode only picks widths from 64 to 2000. No number of runs can reach the bug. The comment says "every case exercises both line and byte caps" and the summary says it checks "the exact notice", which sounds thorough, but it never tests the one byte where the cap decision flips. This is the "generator that never reaches the bug" case.

**Strengthened version:** my R5 cap property in `read.property.test.ts` (`capCase`). It builds lines of one width, then sizes one last line so the total is 51,200 bytes plus a nudge of -2 to +2, then adds 0 to 3 more lines. The expected number of lines comes from the same kind of model (`linesUnderCap`).

**Evidence:** with H4 applied, opencode's property still passes (0 fail). My R5 fails with the counterexample 63 lines of 800 characters plus one line of 737 characters. That is 63 × 800 + 737 + 63 newlines = exactly 51,200 bytes. The model says all 64 lines fit, but the H4 tool cuts the last one. Without H4, all 6 of my properties pass.
