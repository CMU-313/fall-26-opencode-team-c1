// Generators for undo.property.test.ts.
import fc from "fast-check"

// Fixed seed. Under Stryker, skip shrinking, which can outlast the mutant timeout.
fc.configureGlobal({ seed: 42, endOnFailure: process.env.STRYKER === "1" })

// Paths include names git treats specially (spaces, non-ASCII, leading dashes, globs, pathspec
// magic, quotes, tabs), which random strings rarely produce.
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

// Bytes a text pipeline might normalize: empty, no final newline, CRLF, BOM, NUL and invalid UTF-8.
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

// R1: creations span one or two steps, and `rewritten` edits a file again later. The booleans add
// files at the coverage limits (2 MiB, one byte over, gitignored), and `userEdited` adds a file
// /undo must keep.
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

// R2: ops pick files by index, so one file can be edited, deleted and recreated in a turn. Empty
// steps and `abortLast` cover steps with no patch or no step-finish.
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

// R2 shapes random turns rarely reach. An aborted step after an empty one must not use the empty
// step's end snapshot.
const abortedAfterNoChanges = fc
  .record({ base: samePathList(fc.record({ path: anyPath, content: anyContent }), 1, 6), content: anyContent })
  .map(
    (input): EditedTurn => ({
      base: input.base,
      steps: [[], [{ file: 0, action: { kind: "write", content: input.content } }]],
      abortLast: true,
    }),
  )

// Same content under a new name, which git may report as a rename that hides the old path.
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

// A glob-named file and a sibling it matches change in different steps, so a glob pathspec would
// restore the wrong version.
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

// R2, two /undo in a row: turns overlap on some files, and undefined `content` deletes. `between`
// is a user edit after turn 1 that must survive, and `ignoredTracked` is a tracked file .gitignore
// matches, which /undo must leave alone.
const fileOp = fc.record({
  file: fc.nat({ max: 5 }),
  content: fc.option(anyContent, { nil: undefined, freq: 4 }),
})
export const consecutiveUndo = fc.record({
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

// R4: one file /undo can't merge by line: a `text` edit on or next to the agent's line, `binary`
// bytes, a `recreated` file, or a retargeted symlink (`userTarget` "before" merges cleanly).
// `others` are agent-only edits /undo must still revert.
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

// R6: numbered lines give each change a known line count. `same` rewrites identical bytes and must
// not be reported, and `earlierTurns` adds files a report reaching past the undone turn would show.
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

// R2 pruned clause: `gone` picks which snapshots are unreadable. A missing pre-turn snapshot alone
// isn't generated, because /undo then deletes the file, which breaks R2.
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

// R3: alternating agent and user segments that never touch or adjoin, usually one line apart. Edits
// can hit the first or last line, delete lines or grow the file. Every line is unique and ends in
// é, a single invalid-UTF-8 byte in latin1.
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

// R5: `carriers` puts the secret in a read output, an attachment or the reply, over one or more
// messages. `earlierTurns` checks /undo doesn't remove too much, and `target` undoes by the user's
// or an assistant's message ID.
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

// R2, failed checkout: files exist before the turn, so the snapshot covers them. `broken` files
// lose their pre-turn blob, so `git checkout` fails while `ls-tree` still lists them.
export const failedCheckout = samePathList(
  fc.record({ path: anyPath, content: anyContent, broken: fc.boolean() }),
  1,
  4,
).filter((files) => files.some((file) => file.broken))
