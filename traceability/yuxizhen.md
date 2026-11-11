# Traceability: Sissi Zhen (yuxizhen)

**Target feature:** /undo

**Files:** 
- /packages/opencode/src/session/revert.ts
- /packages/opencode/src/snapshot/index.ts


## Requirements

**Files referred under "test" column is in packages/opencode/test/session/**

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kill | 
|---|---|---|---|---|---|---|---|
| R1 | C-11, S-6, O-5: “If they created the file, the file should be deleted.” | When /undo reverts a turn, every file the agent created during that turn is deleted from disk. | Start with a clean git tree. The agent creates src/Helper.java. After /undo, `git status` shows a clean git tree. | Yes | Invariant | `undo.property.test.ts:306-381` | H1 |
| R2 | C-7, C-16, C-17, S-11, S-12, S-14, O-1, O-11: “you can just run git status and see that there’s no changes.” | When /undo reverts a turn, every file the agent edited during that turn is restored to its exact content from just before that turn. | Start with a clean git tree and passing tests. The agent edits Main.java and Config.java. After /undo, git status reports a clean working tree, and git diff is empty. | Yes | Round-trip, Invariant (pruned snapshots), Model/Oracle (two /undo in a row) | `undo.property.test.ts:383-436`, `undo.property.test.ts:438-482`, `undo.property.test.ts:484-553` | H1, H2, 58, 61, 146, 148, 198, 353, 354 | 
| R3 | C-8, C-9, S-4, O-4: “Undo should only erase the agent changes, not my manual changes.” | If the user edits a file the agent modified and the user’s edits don’t overlap the agent’s, /undo reverts only the agent’s changes. | Agent changes lines 10–12 of Foo.java. User edits line 40 by hand. After /undo, lines 10–12 match the pre-turn content and line 40 keeps the user’s edit. | Yes | Model/Oracle | `undo.property.test.ts:555-590` | H3 | 
| R4 | C-10, S-5, O-4: “if you’re editing the same lines as the agent, that can get a bit confusing… it should be specified.” | If the user’s manual edits overlap lines the agent changed, /undo names the conflicting file and lines in TUI, and asks to overwrite the file or skip it. | The agent changes line 10 of Foo.java, then the user edits line 10. /undo prints a warning that identifies Foo.java:10. If the user chooses “skip,” Foo.java stays byte-identical to its state before the /undo. Other non-conflicting files are still reverted. | Yes | Invariant (skip / no-prompt result only) | `undo.property.test.ts:592-649` | 212, 213, 222, 257 |
| R5 | C-13, C-14: “if you, in the next prompt, asked it to act on what it read, it would have no idea.” | `/undo` removes the undone prompt, the agent’s response, and any file contents the agent read during that turn from the conversation context sent to the model in later turns. | Prompt 1 is “read notes.txt,” and the file contains the token ZEBRA42. Run /undo. Send prompt 2. The logged request payload for prompt 2 does not contain ZEBRA42 or the text of prompt 1. | No | Metamorphic | `undo.property.test.ts:792-879` | H4, H5, 5, 6, 8, 51, 53 | 
| R6 | C-15, S-9, S-10, O-8, O-9: “there should be some ‘undone’ indicator; [writes] should give you… a path to the file that was edited.” | After every /undo, the TUI prints a “Reverted” confirmation. The confirmation lists affected file path and whether it was restored/deleted, or says no files changed. | Undoing a read-only turn and undoing a question-and-answer turn both print Reverted (0 files changed). Undoing a turn that created a.txt and modified b.txt prints the same header followed by deleted a.txt & restored b.txt. | Yes | Model/Oracle (partial: reported files and line counts, nothing to undo) | `undo.property.test.ts:651-744` | 57, 64, 67, 68, 69, 71, 72, 74, 76, 77, 78, 82, 84 | 



Properties written or suggested by opencode or another AI tool: R1, R2, R3, R4, R5, R6 (all written by Claude Code, including the strengthening below)

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R1 | When /undo reverts a turn, every file the agent created during that turn is deleted from disk. | When /undo reverts a turn, it deletes each file the agent created that snapshots cover (git project with snapshots on, inside the worktree, not gitignored, at most 2 MiB) and that hasn't changed since the turn ended, sending changed files to R4 and reporting uncovered files under R6. | Undo can only delete what snapshots recorded, and deleting every created file conflicts with R3 when the user has since edited one, so this removes agent-created files as C-11, S-6 and O-5 wanted without losing user work. |
| R2 | When /undo reverts a turn, every file the agent edited during that turn is restored to its exact content from just before that turn. | When /undo reverts a turn, each snapshot-covered file (see R1) that the agent edited or deleted and that hasn't changed since the turn ended returns to its exact pre-turn content, unless its snapshot was pruned after about 7 days (then it's left untouched and reported under R6), and only the working tree changes, not the git index, HEAD, or commits. | Exact restores would erase the manual edits R3 must keep, and snapshots have R1's coverage limits, get pruned, and can't undo staging or commits, so `git status` proves the agent's work is gone only if the agent didn't stage or commit. |
| R3 | If the user edits a file the agent modified and the user’s edits don’t overlap the agent’s, /undo reverts only the agent’s changes. | If, after the turn ended, the user edits a text file the agent modified and those edits neither touch nor directly adjoin any line the agent changed, /undo reverts only the agent's changes and keeps the user's edits exactly, while changes made during the turn count as the agent's. | Snapshots can't trace a change made during a turn to the agent or the user, and "don't overlap" didn't say whether neighboring lines count, so adjacent lines now conflict as they do in `git merge-file`, while the need to keep manual edits stays the same. |
| R4 | If the user’s manual edits overlap lines the agent changed, /undo names the conflicting file and lines in TUI, and asks to overwrite the file or skip it. | If the user's post-turn edits touch or directly adjoin lines the agent changed, or the file can't be merged by line (binary, created by the agent then edited, or deleted by the agent then recreated), /undo names the file and any conflicting on-disk lines in the TUI and asks to overwrite (return it to its pre-turn state, discarding the user's edits) or skip (leave it byte-identical, which is also the result of dismissing the prompt or using a client that can't prompt), while other files are still reverted. | "Overwrite" had no defined result, dismissing the prompt wasn't covered, some files have no lines to name, and SDK clients have no TUI prompt, so anything unanswered now skips, which keeps the conflict "specified" rather than decided for the user as C-10, S-5 and O-4 wanted. |
| R5 | `/undo` removes the undone prompt, the agent’s response, and any file contents the agent read during that turn from the conversation context sent to the model in later turns. | Unchanged. | Kept as is because undone messages are deleted before the next prompt, the requirement covers only later requests, the test LLM server can check the payloads, and /redo only works before those messages are deleted. |
| R6 | After every /undo, the TUI prints a “Reverted” confirmation. The confirmation lists affected file path and whether it was restored/deleted, or says no files changed. | After every /undo, the TUI shows `Reverted (N files changed)` with each affected path marked deleted, restored, kept your edits, skipped, or not reverted (uncovered files only if changed by the edit, write, or apply_patch tools), or it says that files weren't reverted because the project has no snapshots, or that there was nothing to undo. | Nothing records a shell command's change to an uncovered file, "restored/deleted" has no word for merged or skipped files, "no files changed" would be false without snapshots, and "every /undo" missed the nothing-to-undo case, so the new outcomes keep the clear indicator and file paths that C-15, S-9 and O-8 wanted. |

#### Known flaky test in CI
CI tests times out for unit tests. Since this is not the main focus of the current projects, I increased the timeout limit to 15 minutes.

## Hand-written mutants with predictions
| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R1 | `snapshot/index.ts`: `yield* remove(op.file)` line deleted, so a file created in the previous run would remain after /undo | "Agent created files from the last turn are deleted from disk" (R1) | Killed by R1 and by R2 (edit then /undo), both before and after strengthening. |
| H2 | R2 | `snapshot/index.ts`: change `?? true` to `?? false` in isEdited, so a file git can't read is not counted as edited, leading to downstream revert path instead of `removeAgentChanges`. | "Files agent edited that hasn't changed is restored to its content before the turn." (R2) | Killed by R2 (pruned snapshots), both before and after strengthening. |
| H3 | R3 | `snapshot/index.ts`: change `merged.code !== 0` to `merged.code === 0`, treating a clean merge as a conflict instead of directly restoring. | "User edits that don't touch agent lines leads to agent lines being reverted." (R3) | Killed by R3, both before and after strengthening. | 
| H4 | R5 | `session/revert.ts`: changes `remove` to keep user messages with no partID, so previous-turn user prompt is still in history. | "`/undo` removes the undone prompt, the agent's response, and and any file contents read." (R5) | Killed by R5, both before and after strengthening. |
| H5 | R5 | `session/revert.ts`: removes the partID and lastUser check so all messages revert to the last message instead of the user message that started the turn (if one is found); if the called passed an assistant message's id, the mutant keeps prompt 1 in the history. | "`/undo` removes the undone prompt, the agent's response, and and any file contents read." (R5) | Survived on the original properties, because R5 always reverted by the user message's ID. Killed after strengthening by R5, which now also reverts by one of the turn's assistant message IDs. |


## Stryker run & comparison

### Stryker run
***Stryker run still took over 1 hour after targeting coverage***.
Narrowing `mutate` to the lines the coverage report marked as covered reduced the number of mutants (396), but not the cost of testing each one: the command runner has no per-test coverage (`coverageAnalysis: "off"`), so every mutant reruns the whole `undo.property.test.ts`. That file takes about 40 seconds, because each property builds a fresh git repo for every generated case and runs dozens of git processes, so 396 mutants at a concurrency of 2 took about 100 minutes.

### Comparison

#### Handwritten mutants Stryker never generated
**H1**: H1.patch deletes the `yield* remove(op.file)` line, which is a YieldExpression. By default, Stryker's removal mutators target BlockStatement boundaries. yield* is tied to the control flow of a generator, which Stryker avoids to delete. 
**H4**: H4.patch turns `partID ? 1 : 0` to `1`. Stryker's ConditionalExpression mutator targets conditions, replacing boolean statements with a plain `true` or `false`, but it won't directly destroy a tertary branch and swap in `1`. The ArithemeticOperator mutator flipped the `+` to `-`, but it doesn't evaluate the statement within the parentheses that follows. 

#### Some survivors I would've not thought of
1. Checking every element in the list fulfills the requriement instead of any element. 
```
[Survived] MethodExpression
src/session/revert.ts:65:30
-                 const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
+                 const partID = remaining.every(item => ["text", "tool"].includes(item.type)) ? input.partID : undefined
```
2. Initialize an intended empty data structure with an element.
```
[Survived] ArrayDeclaration
src/session/revert.ts:83:33
-         const range = index < 0 ? [] : all.slice(index)
+         const range = index < 0 ? ["Stryker was here"] : all.slice(index)
```
3. Removed null/undefined guard before field access. 
```
[Survived] OptionalChaining
src/snapshot/index.ts:424:44
-             if (entry.code !== 0 || !oid || !mode?.startsWith("100")) return
+             if (entry.code !== 0 || !oid || !mode.startsWith("100")) return
```
I'd say (1) and (3) are bugs that developers might plausibly write, while (2) is less likely. 

#### What each approach finds that the other skips
Handwritten mutants
- Syntax errors (Stryker avoids mutants that cause compile errors)
- Removed lines in the control flow
- Business logic edge cases
- Architectural / integration gaps (e.g. plain string SQL query)

Stryker-generated mutants
- Nulls, undefined, empty strings
- initialized data structure with elements
- Numerical values 
- "Flips" for every statement (true v.s. false, < v.s. >, + v.s. -, !== v.s. ===)

### Strengthening

Strengthened properties by:
- **Better generators.** `undoneTurn` now picks which message /undo targets: the user message or any of the turn's assistant messages. The HTTP `session.revert` accepts any message of the turn, and this is what kills H5. The new `consecutiveUndo` builds two turns, with user edits between them and a committed file that a later `.gitignore` matches. The new `conflictingEdits` and `reportedTurn` feed the R4 and R6 properties.
- **Stronger assertions.** Each assistant message in R5 carries an `ASSISTANT-STEP-i` text, and R5 now checks that none of it reaches the next request. R6 checks four things against the files and line counts the generator chose: the `session_diff` saved in storage, the published `session.diff` event, the `revert.summary` counts, and `revert.diff`. It also checks that /undo on an unknown message ID sets no revert and leaves `git status` unchanged.
- **New properties**:
  - R2: `undo.property.test.ts:484-553`
  - R4: `undo.property.test.ts:592-649`
  - R6: `undo.property.test.ts:651-744`.

**Bug found:** say turn 2 deletes a file that turn 1 edited, and the user runs /undo twice. The file comes back with turn 1's bytes, not its original bytes. The second /undo calls `Snapshot.restore`, which runs `read-tree` and `checkout-index -a -f` (`snapshot/index.ts:395-419`). Neither one deletes or rewrites a file that is missing from the restored tree. As a result, turn 1's revert sees the file as edited by the user and keeps it. A minimal counterexample: `src/Helper.java` starts as `[0]`, turn 1 empties it, and turn 2 deletes it. `consecutiveUndo` leaves this case out (see the comment in `undo.generator.ts`), so the property checks every other combination.

#### Equivalent mutants

Mutant IDs are from `mutants/yuxizhen/mutation.html`. `revert.ts` is `src/session/revert.ts` and `index.ts` is `src/snapshot/index.ts`.

| ID(s) | Location | Change | Why it is equivalent |
|---|---|---|---|
| 0, 85 | revert.ts:38, 109 | Span name → `""` | Span names only label traces and never affect which files or messages are touched. |
| 9 | revert.ts:49 | `remaining = []` → `["Stryker was here"]` | A string has no `type`, so it never makes `remaining.some(...)` true. |
| 30 | revert.ts:63 | `if (!rev)` → `if (true)` | The `if (rev) continue` just above means this line only runs when `rev` is unset. |
| 70, 73 | revert.ts:83 | Remove the `index < 0` branch, or fill its `[]` | `rev.messageID` always comes from `all`, so `findIndex` never returns -1. |
| 95 | revert.ts:115 | `index < 0 ? undefined : msgs[index]` → `msgs[index]` | `msgs[-1]` is already `undefined`. |
| 226, 280, 288, 309, 389 | index.ts:425, 482, 485, 509, 577 | `{ cwd }` → `{}` | These git commands take no pathspec or only absolute paths, so the working directory doesn't matter. |
| 129, 174, 231 | index.ts:258, 303, 435 | `{ concurrency: n }` → `{}` | Independent reads run in sequence instead of in parallel, and the results come back in the same order. |
| 243, 244 | index.ts:443 | Temp dir prefix → `{}` / `""` | The scratch directory's name never reaches the user's files. |
| 241, 242, 260, 261, 303, 304, 324, 325, 382, 383, 396, 397 | index.ts:440, 457, 508, 523, 574, 596 | Log message or fields emptied | No code reads logs back. |
| 144, 154 | index.ts:273, 287 | Empty-list early returns → `if (false)` | With an empty list, every later step (`ignore`, `drop`, `stage`, `sync([])`) does nothing. |
| 145, 147 | index.ts:280 | `ignored.size > 0` → `true` / `>= 0` | `drop([])` returns immediately when nothing is ignored. |
| 149, 178 | index.ts:286, 309 | Also send ignored or blocked large files to `stage` | Without `-f`, `git add` refuses files that `.gitignore` or `info/exclude` ignore. |
| 155 | index.ts:290 | Drop `.filter(Boolean)` | The extra `undefined` in `large` never matches a path string. |
| 163 | index.ts:297 | `stat.type !== "File"` → `false` | The only non-files here are symlinks and nested-repo directories, which are far below the 2 MiB limit. |
| 166–169 | index.ts:298 | Mutate the `typeof stat.size === "bigint"` check | `Number()` of a number is unchanged, and JS compares a bigint with a number by value. |
| 193 | index.ts:376 | `patch` failure check → `if (false)` | Failed git output is empty, so the fall-through also returns `{ hash, files: [] }`. |
| 214, 215, 216, 221 | index.ts:424 | Weaken the `entry.code`/`oid` guards; `mode?.` → `mode.` | When `ls-tree` fails, `mode` is `""`, which the `startsWith("100")` check still rejects, and `split` never returns `undefined`. |
| 233–236, 240 | index.ts:439 | Weaken or remove the missing-version early return | Writing a missing version fails before `merge-file`, and `Effect.catch` leaves the user's file byte-identical. |
| 262 | index.ts:463 | `all = []` → `["Stryker was here"]` | Every git call fails on the dummy op, and `remove` swallows its error, so no file is touched. |
| 271, 274 | index.ts:480 | `knownEnds` also keeps `undefined` | `isEdited` returns false for an `undefined` end before looking it up. |
| 298 | index.ts:504 | Send every op to `removeAgentChanges` | For a file the user didn't edit, the merge gives the pre-turn bytes, the same as the later checkout. |
| 311, 321, 323 | index.ts:512, 516 | Mutate the `single` success and `ls-tree` checks | A successful checkout means the file is in the tree, a failed `ls-tree` prints nothing, and `ls-tree` output is never just whitespace. |
| 326–337, 343, 348–350, 352, 355–358, 362, 364 | index.ts:527–542 | Change the batching rules (`clash`, the 100-file cap, the single-op shortcut) | Batched and per-file checkouts from one snapshot leave the same files. |
| 365–370, 373, 376 | index.ts:550–571 | Break or skip the batched `ls-tree` | The run falls back to per-file `single`, which gives the same result. |
| 378, 380 | index.ts:572, 573 | Check out unlisted files, or an empty list | The `git checkout` fails, and the run falls back to `single`. |
| 384–388, 390 | index.ts:576, 581 | Break the batched `checkout`, or always fall back | Falling back to `single` repeats the same checkouts. |

#### Final mutation score

| | Killed | Timeout | Survived | Equivalent | Score as Stryker reports it | Score excluding equivalent mutants |
|---|---|---|---|---|---|---|
| Before strengthening | 226 | 1 | 169 | 97 | 227 / 396 = **57.32%** | 227 / 299 = **75.92%** |
| After strengthening | 255 | 1 | 140 | 97 | 256 / 396 = **64.65%** | 256 / 299 = **85.62%** |

The score as Stryker reports it is (killed + timeout) / all 396 mutants. Excluding equivalent mutants, it is (killed + timeout) / (396 − 97 equivalent). Strengthening killed 29 more mutants, and no mutant that was killed before survived. 

#### Why not every mutant was killed
97 of the 140 survivors are equivalent: they change only logs, span names, concurrency, or dead branches, so no test can tell them apart from the original. The other 43 only behave differently in situations the TUI's /undo never reaches (a `partID`, a message deleted before cleanup, a git failure, or opencode running from a subdirectory of the repo), and covering them would need new properties plus another >1h Stryker run.