// Generators for the /undo property tests in undo.property.test.ts. The comment
// above each one explains why it produces the cases it does.
import fc from "fast-check"

// Seed property tests. Under Stryker, skip shrinking: a mutant only needs to
// fail, and shrinking a counterexample can take longer than the mutant's timeout.
fc.configureGlobal({ seed: 42, endOnFailure: process.env.STRYKER === "1" })

// Generator choice: paths are drawn from a pool of names known to be hard for
// git, because a random string almost never contains them: spaces, non-ASCII
// (which git quotes in plain output), leading dashes, glob characters and
// pathspec magic (which git may expand), and quotes, backslashes and tabs (which
// git escapes). Random ASCII names and deep folders cover the ordinary case.
const trickyPath = fc.constantFrom(
  "src/Helper.java",
  "with space.txt",
  "dir with space/x y.txt",
  "café.txt",
  "日本語/ファイル.md",
  "-leading-dash.txt",
  "[brackets].txt",
  "star*.txt",
  "quest?.txt",
  'quote"d.txt',
  "back\\slash.txt",
  "tab\tname.txt",
  ":(top)magic.txt",
  "#hash.txt",
  ".hidden",
  "deep/a/b/c/d/e/f.txt",
)
const anyPath = fc.oneof(
  { weight: 3, arbitrary: trickyPath },
  { weight: 1, arbitrary: fc.stringMatching(/^[a-z0-9]{1,8}\.txt$/) },
)

// Generator choice: restoring "exact content" is most likely to go wrong on
// bytes a text pipeline would normalize, so these cases are listed explicitly:
// empty files, no final newline, CRLF, a BOM, NUL bytes and invalid UTF-8.
const encode = (text: string) => new TextEncoder().encode(text)
const anyContent = fc.oneof(
  fc.constant(new Uint8Array()),
  fc.constantFrom(
    encode("\n"),
    encode("no final newline"),
    encode("one\r\ntwo\r\n"),
    encode("mixed\nendings\r\n"),
    encode("﻿with bom\n"),
    new Uint8Array([0, 1, 2, 0, 255, 254]),
  ),
  fc.uint8Array({ maxLength: 256 }),
  fc.string({ maxLength: 64 }).map(encode),
)

const samePathList = <T extends { path: string }>(item: fc.Arbitrary<T>, minLength: number, maxLength: number) =>
  fc.uniqueArray(item, { selector: (entry) => entry.path, minLength, maxLength })

// Generator choice for R1: `step` spreads creations over one or two agent steps,
// and `rewritten` edits a file again in a later step, because each step records
// its own patch and revert must combine them. The three booleans switch on files
// at the coverage limits: exactly 2 MiB (covered), one byte over (not covered),
// and gitignored (not covered). They're booleans so that a counterexample shrinks
// to a readable case and doesn't print megabytes of data. `userEdited` changes a
// file after the turn ends, so a single turn mixes files /undo must delete with
// files it must keep.
export const createdTurn = fc.record({
  created: samePathList(
    fc.record({
      path: anyPath,
      content: anyContent,
      step: fc.integer({ min: 0, max: 1 }),
      rewritten: fc.boolean(),
      userEdited: fc.boolean(),
    }),
    1,
    6,
  ),
  atLimit: fc.boolean(),
  overLimit: fc.boolean(),
  ignored: fc.boolean(),
})

// Generator choice for R2: files are chosen by index so that several operations
// can hit the same file in a turn. That reaches edit-then-edit, delete-then-
// recreate, and rewriting a file with the bytes it already had, and several files
// in one step reach the batched code path in Snapshot.revert. A step can have no
// operations, and `abortLast` ends the turn the way an interrupted step does.
const randomEditedTurn = fc.record({
  base: samePathList(fc.record({ path: anyPath, content: anyContent }), 1, 6),
  steps: fc.array(
    fc.array(
      fc.record({
        file: fc.nat({ max: 5 }),
        action: fc.oneof(
          { weight: 3, arbitrary: anyContent.map((content) => ({ kind: "write" as const, content })) },
          { weight: 1, arbitrary: fc.constant({ kind: "delete" as const }) },
          { weight: 1, arbitrary: anyPath.map((to) => ({ kind: "rename" as const, to })) },
        ),
      }),
      { maxLength: 5 },
    ),
    { minLength: 1, maxLength: 3 },
  ),
  abortLast: fc.boolean(),
})
type EditedTurn = typeof randomEditedTurn extends fc.Arbitrary<infer T> ? T : never

// Steering for R2: these shapes break revert in ways that random turns rarely or
// never reach, so each one gets a share of the runs. File contents stay generated.
//
// A step with no changes records a step-finish but no patch. If an aborted step
// follows, its patch must not be paired with that earlier step's end snapshot.
const abortedAfterNoChanges = fc
  .record({ base: samePathList(fc.record({ path: anyPath, content: anyContent }), 1, 6), content: anyContent })
  .map(
    (input): EditedTurn => ({
      base: input.base,
      steps: [[], [{ file: 0, action: { kind: "write", content: input.content } }]],
      abortLast: true,
    }),
  )

// Identical content under a new name is what git reports as a rename, which can
// hide the old path. Git only pairs them if the file isn't empty.
const renamedFile = fc
  .record({
    names: fc.uniqueArray(anyPath, { minLength: 2, maxLength: 2 }),
    content: anyContent.filter((content) => content.length > 0),
  })
  .map(
    (input): EditedTurn => ({
      base: [{ path: input.names[0]!, content: input.content }],
      steps: [[{ file: 0, action: { kind: "rename", to: input.names[1]! } }]],
      abortLast: false,
    }),
  )

// Each pair is a name with glob characters and a sibling that the glob matches.
// The sibling changes in one step and the glob-named file in the next, so treating
// the name as a glob restores the sibling from the later, mid-turn snapshot.
const globCollision = fc
  .record({
    names: fc.constantFrom(["[brackets].txt", "a.txt"], ["star*.txt", "starX.txt"], ["quest?.txt", "questX.txt"]),
    globContent: anyContent,
    siblingContent: anyContent,
  })
  .map(
    (input): EditedTurn => ({
      base: [
        { path: input.names[0]!, content: input.globContent },
        { path: input.names[1]!, content: input.siblingContent },
      ],
      steps: [
        [{ file: 1, action: { kind: "write", content: encode("sibling changed mid-turn\n") } }],
        [{ file: 0, action: { kind: "write", content: encode("glob-named file changed\n") } }],
      ],
      abortLast: false,
    }),
  )

export const editedTurn = fc.oneof(
  { weight: 3, arbitrary: randomEditedTurn },
  { weight: 1, arbitrary: abortedAfterNoChanges },
  { weight: 1, arbitrary: renamedFile },
  { weight: 1, arbitrary: globCollision },
)

// Generator choice for consecutive /undo under R2: two turns are undone one after
// the other, so the second /undo starts from files the first one already
// reverted. Ops pick base files by index, and `content` of undefined deletes the
// file, so turns overlap on some files and not others. `between` is a user edit
// made after turn 1 to a file turn 1 doesn't touch (the test skips the others),
// and `agentAfter` makes turn 2 edit that file again. Undoing both turns must
// keep the user's edit, which turn 1's snapshot doesn't hold. `ignoredTracked` is
// a committed file that .gitignore matches, which isn't covered by snapshots, so
// /undo must leave the agent's edit to it in place.
const fileOp = fc.record({
  file: fc.nat({ max: 5 }),
  content: fc.option(anyContent, { nil: undefined, freq: 4 }),
})
export const consecutiveUndo = fc
  .record({
    base: samePathList(fc.record({ path: anyPath, content: anyContent }), 2, 6),
    turn1: fc.array(fileOp, { minLength: 1, maxLength: 4 }),
    between: fc.array(
      fc.record({
        file: fc.nat({ max: 5 }),
        content: anyContent,
        agentAfter: fc.option(anyContent, { nil: undefined }),
      }),
      { maxLength: 3 },
    ),
    turn2: fc.array(fileOp, { maxLength: 4 }),
    ignoredTracked: fc.boolean(),
  })

// Generator choice for R4: each case has one file /undo can't merge by line, in
// each of the ways R4 lists. In `text`, the user's edit lands on the agent's line
// or a line directly next to it (`userOffset`). `binary` holds NUL bytes.
// `recreated` is deleted by the agent and then written again by the user. A
// symlink can't be merged by line either: the agent and then the user point it at
// another target, and `userTarget` of "before" points it back at its pre-turn
// target, which is the only way the two edits merge cleanly. `others` are files
// the agent edited and the user didn't touch, which /undo must still revert.
export const conflictingEdits = fc.record({
  kind: fc.constantFrom("text" as const, "binary" as const, "symlink" as const, "recreated" as const),
  lines: fc.integer({ min: 1, max: 6 }),
  agentLine: fc.nat({ max: 5 }),
  userOffset: fc.constantFrom(-1, 0, 0, 1),
  eol: fc.constantFrom("\n", "\r\n"),
  bytes: fc.record({ before: fc.uint8Array(), agent: fc.uint8Array(), user: fc.uint8Array() }),
  userTarget: fc.constantFrom("before" as const, "new" as const),
  others: samePathList(fc.record({ path: anyPath, before: anyContent, agent: anyContent }), 1, 3),
})

// Generator choice for R6: line counts are only meaningful for text, so every
// file holds whole numbered lines and each kind of change has a known count:
// `create` adds lines, `append` adds lines to a file that may be empty,
// `truncate` removes lines from the end (possibly all of them, leaving an empty
// file), `delete` removes the file, and `same` rewrites identical bytes, which
// isn't a change and must not be reported. `earlierTurns` adds turns before the
// undone one that change other files, so a report that reaches past the undone
// turn shows extra paths, and 0 makes the undone turn the first message.
const lineCount = fc.integer({ min: 0, max: 4 })
export const reportedTurn = fc.record({
  earlierTurns: fc.integer({ min: 0, max: 2 }),
  files: fc.uniqueArray(
    fc.record({
      name: fc.stringMatching(/^[a-z0-9]{1,8}$/),
      change: fc.oneof(
        fc.record({ kind: fc.constant("create" as const), base: fc.constant(0), lines: lineCount.map((n) => n + 1) }),
        fc.record({ kind: fc.constant("append" as const), base: lineCount, lines: lineCount.map((n) => n + 1) }),
        fc
          .record({ kind: fc.constant("truncate" as const), base: lineCount.map((n) => n + 1), lines: lineCount })
          .map((change) => ({ ...change, lines: Math.min(change.lines + 1, change.base) })),
        fc.record({ kind: fc.constant("delete" as const), base: lineCount.map((n) => n + 1), lines: fc.constant(0) }),
        fc.record({ kind: fc.constant("same" as const), base: lineCount, lines: fc.constant(0) }),
      ),
    }),
    { selector: (file) => file.name, minLength: 1, maxLength: 4 },
  ),
})

// Generator choice for the pruned clause of R2: `gone` chooses which snapshots are
// unreadable, and the agent both edits and deletes files, so a prune has to leave
// each of them as the turn left it. It doesn't generate a pre-turn snapshot missing
// on its own: /undo currently deletes the file in that case, which breaks R2.
export const prunedTurn = fc.record({
  gone: fc.constantFrom("end" as const, "both" as const),
  files: samePathList(
    fc.record({
      path: anyPath,
      before: anyContent,
      agent: fc.option(anyContent, { nil: undefined, freq: 3 }),
    }),
    1,
    4,
  ),
})

// Generator choice for R3: edits are built as alternating agent and user segments
// so that they never touch or adjoin, which is the precondition of R3. The gap
// between segments is biased to exactly one line, the closest two edits can be
// while still not overlapping. `leading` of 0 and `trailing` of 0 put edits on
// the first and last lines. `replacement` of 0 deletes lines and 2 grows the
// file, so the user's edit moves to a different line number after the undo.
// Every line is unique so that the diff has only one possible alignment, and ends
// in é, which `latin1` writes as a single byte that isn't valid UTF-8.
export const separatedEdits = fc.record({
  encoding: fc.constantFrom("utf8" as const, "latin1" as const),
  agentFirst: fc.boolean(),
  leading: fc.constantFrom(0, 0, 1, 2),
  trailing: fc.constantFrom(0, 1, 1, 3),
  eol: fc.constantFrom("\n", "\r\n"),
  finalNewline: fc.boolean(),
  segments: fc.array(
    fc.record({
      gap: fc.oneof({ weight: 3, arbitrary: fc.constant(1) }, { weight: 1, arbitrary: fc.integer({ min: 2, max: 4 }) }),
      run: fc.integer({ min: 1, max: 2 }),
      replacement: fc.integer({ min: 0, max: 2 }),
    }),
    { minLength: 2, maxLength: 5 },
  ),
})

// Generator choice for R5: `carriers` places the secret everywhere an undone turn
// can hold file contents, in any combination: a read tool's output, an attachment
// expanded into the prompt, and the assistant's reply. A multi-message turn covers
// turns with more than one model step. `earlierTurns` of 0 is the boundary where
// the undone turn is the whole session, and above 0 it checks /undo doesn't remove
// too much. The fixed ZEBRA42 prefix means the secret can't appear in the system
// prompt by chance, and the grapheme suffix reaches text that JSON has to escape.
// `target` picks which message of the turn /undo is given: the user's prompt or
// one of the assistant's messages. The API accepts either, and both must remove
// the whole turn, prompt included.
export const undoneTurn = fc.record({
  target: fc.nat({ max: 3 }),
  earlierTurns: fc.integer({ min: 0, max: 2 }),
  secret: fc.string({ unit: "grapheme", maxLength: 8 }).map((suffix) => `ZEBRA42-${suffix}`),
  firstPrompt: fc.string({ unit: "grapheme", maxLength: 8 }).map((suffix) => `read notes.txt PROMPT-ONE-${suffix}`),
  secondPrompt: fc.stringMatching(/^[a-z ]{0,12}$/).map((suffix) => `PROMPT-TWO ${suffix}`),
  carriers: fc.uniqueArray(fc.constantFrom("tool-output", "attachment", "assistant-text"), {
    minLength: 1,
    maxLength: 3,
  }),
  assistantMessages: fc.integer({ min: 1, max: 3 }),
})
