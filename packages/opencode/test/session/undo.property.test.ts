// Property tests for the /undo requirements in traceability/yuxizhen.md.

import { describe, expect } from "bun:test"
import fc from "fast-check"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Layer, Option, Schema, Scope } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { MCP } from "../../src/mcp"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import {
  conflictingEdits,
  consecutiveUndo,
  createdTurn,
  editedTurn,
  prunedTurn,
  reportedTurn,
  separatedEdits,
  undoneTurn,
} from "./undo.generator"

// Seed property tests. Under Stryker, skip shrinking: a mutant only needs to
// fail, and shrinking a counterexample can take longer than the mutant's timeout.
fc.configureGlobal({ seed: 42, endOnFailure: process.env.STRYKER === "1" })

// Snapshots skip new untracked files larger than this (src/snapshot/index.ts).
const SNAPSHOT_LIMIT = 2 * 1024 * 1024
const PRUNED_SNAPSHOT = "0".repeat(40)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const TEST_TIMEOUT = 180_000

const revertIt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionRevert.node,
      Snapshot.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      Storage.node,
      EventV2Bridge.node,
    ]),
  ),
)

// Checks a property against the services already built for the test, so each
// generated case gets a fresh repo without rebuilding every layer.
const undoProperty = <T, E, R>(
  arbitrary: fc.Arbitrary<T>,
  numRuns: number,
  testCase: (input: T) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Exclude<R, Scope.Scope>>()
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(arbitrary, (input) => Effect.runPromiseWith(context)(Effect.scoped(testCase(input)))),
        {
          numRuns,
          // Shrinking a failure can take thousands of git processes. Stop in time for
          // fast-check to report the smallest counterexample found so far, and count
          // running out of time as a failure so a slow run can't pass by doing less.
          interruptAfterTimeLimit: 150_000,
          markInterruptAsFailure: true,
        },
      ),
    )
  })

const git = (cwd: string, ...args: string[]) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`)
    return out
  })

const commitAll = (dir: string) =>
  git(dir, "add", "-A").pipe(Effect.andThen(git(dir, "commit", "--allow-empty", "-m", "base")))

// -z keeps paths raw, so a filename with a quote or tab compares as itself.
const gitStatus = (dir: string) =>
  git(dir, "status", "--porcelain", "-z", "--untracked-files=all").pipe(
    Effect.map((out) => out.split("\0").filter(Boolean).toSorted()),
  )

const put = (file: string, content: Uint8Array | string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  })
const del = (file: string) => Effect.promise(() => fs.rm(file, { force: true }))
const readBytes = (file: string) => Effect.promise(() => fs.readFile(file).then((data) => new Uint8Array(data)))
const rename = (from: string, to: string) =>
  Effect.gen(function* () {
    if (!(yield* exists(from))) return
    const data = yield* readBytes(from)
    yield* del(from)
    yield* put(to, data)
  })
const exists = (file: string) =>
  Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  )

const addAssistant = Effect.fn("test.addAssistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const sessions = yield* Session.Service
  return yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens,
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "stop",
  })
})

const addUser = Effect.fn("test.addUser")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* addText(sessionID, message.id, text)
  return message
})

const addText = Effect.fn("test.addText")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  text: string,
  synthetic?: boolean,
) {
  const sessions = yield* Session.Service
  return yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text" as const,
    text,
    synthetic,
  })
})

// Records one agent turn the way the session processor does: a snapshot before
// each step, a step-finish with a snapshot after it, and a patch only if the step
// changed files. An aborted step, which can only be the last, has no step-finish.
// `pruned` stores a hash git can't read in place of the snapshots a prune removes.
const agentTurn = Effect.fn("test.agentTurn")(function* (
  sessionID: SessionID,
  dir: string,
  steps: ReadonlyArray<Effect.Effect<void>>,
  options: { abortLast?: boolean; pruned?: "end" | "both" } = {},
) {
  const sessions = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const user = yield* addUser(sessionID, "do the work")
  const assistant = yield* addAssistant(sessionID, user.id, dir)
  const part = { messageID: assistant.id, sessionID }
  yield* Effect.forEach(
    steps,
    Effect.fnUntraced(function* (step, index) {
      const before = yield* snapshot.track()
      if (!before) throw new Error("expected a snapshot before the step")
      yield* sessions.updatePart({ ...part, id: PartID.ascending(), type: "step-start", snapshot: before })
      yield* step
      if (!options.abortLast || index < steps.length - 1) {
        const after = yield* snapshot.track()
        if (!after) throw new Error("expected a snapshot after the step")
        yield* sessions.updatePart({
          ...part,
          id: PartID.ascending(),
          type: "step-finish",
          reason: "stop",
          snapshot: options.pruned ? PRUNED_SNAPSHOT : after,
          cost: 0,
          tokens,
        })
      }
      const patch = yield* snapshot.patch(before)
      if (!patch.files.length) return
      yield* sessions.updatePart({
        ...part,
        id: PartID.ascending(),
        type: "patch",
        hash: options.pruned === "both" ? PRUNED_SNAPSHOT : patch.hash,
        files: patch.files,
      })
    }),
  )
  return user.id
})

const USER_EDIT = new TextEncoder().encode("edited by the user after the turn\n")

// The oracle for R3, as a plain list of lines: a user segment ends up with the
// user's lines, and every other line ends up as it was before the turn.
const modelSeparatedEdits = (input: typeof separatedEdits extends fc.Arbitrary<infer T> ? T : never) => {
  const blocks = input.segments.flatMap((segment, index) => {
    const owner = (index % 2 === 0) === input.agentFirst ? ("agent" as const) : ("user" as const)
    const gap = index === 0 ? input.leading : segment.gap
    const original = (kind: string, count: number) =>
      Array.from({ length: count }, (_, line) => `${kind}-${index}-${line}-é`)
    return [
      { owner: "none" as const, base: original("gap", gap), replaced: [] as string[] },
      { owner, base: original("base", segment.run), replaced: original(owner, segment.replacement) },
    ]
  })
  const tail = {
    owner: "none" as const,
    base: Array.from({ length: input.trailing }, (_, i) => `tail-${i}-é`),
    replaced: [],
  }
  const all = [...blocks, tail]
  // Dropping the final newline changes the last line, so it's only generated
  // when that line is untouched. Otherwise it would adjoin a segment's edit.
  const ending = input.finalNewline || input.trailing === 0 ? input.eol : ""
  const render = (pick: (block: (typeof all)[number]) => string[]) => {
    const lines = all.flatMap(pick)
    return new Uint8Array(Buffer.from(lines.length === 0 ? "" : lines.join(input.eol) + ending, input.encoding))
  }
  return {
    base: render((block) => block.base),
    afterAgent: render((block) => (block.owner === "agent" ? block.replaced : block.base)),
    afterUser: render((block) => (block.owner === "none" ? block.base : block.replaced)),
    expected: render((block) => (block.owner === "user" ? block.replaced : block.base)),
  }
}

// The three versions of R4's conflicting file that aren't a symlink. Undefined
// means the file doesn't exist. Each binary version starts with a NUL byte and
// ends in a byte the others don't, so all three differ.
const conflictVersions = (input: typeof conflictingEdits extends fc.Arbitrary<infer T> ? T : never) => {
  const text = (lines: string[]) => new TextEncoder().encode(lines.map((line) => line + input.eol).join(""))
  const base = Array.from({ length: input.lines }, (_, line) => `line-${line}`)
  const agentLine = input.agentLine % input.lines
  const userLine = Math.min(Math.max(agentLine + input.userOffset, 0), input.lines - 1)
  const agent = base.with(agentLine, `agent-${agentLine}`)
  if (input.kind === "binary") {
    return {
      before: new Uint8Array([0, ...input.bytes.before, 3]),
      agent: new Uint8Array([0, ...input.bytes.agent, 1]),
      user: new Uint8Array([0, ...input.bytes.user, 2]),
    }
  }
  if (input.kind === "recreated") return { before: text(base), agent: undefined, user: text(["recreated by the user"]) }
  return { before: text(base), agent: text(agent), user: text(agent.with(userLine, `user-${userLine}`)) }
}

// Listeners receive event data untyped, so R6 decodes the fields it checks.
const decodeDiffEvent = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionID: Schema.String,
    diff: Schema.Array(Schema.Struct({ file: Schema.optional(Schema.String) })),
  }),
)

const symlink = (target: string, link: string) =>
  Effect.promise(async () => {
    await fs.rm(link, { force: true })
    await fs.symlink(target, link)
  })
const readLink = (link: string) => Effect.promise(() => fs.readlink(link))

const snapshotTests = process.platform === "win32" ? describe.skip : describe

snapshotTests("/undo properties", () => {
  // R1: When /undo reverts a turn, it deletes each file the agent created that
  // snapshots cover (git project with snapshots on, inside the worktree, not
  // gitignored, at most 2 MiB) and that hasn't changed since the turn ended,
  // sending changed files to R4 and reporting uncovered files under R6.
  // Kind: invariant
  // Acceptance criteria: start with a clean git tree, the agent creates files,
  // and after /undo `git status` shows a clean tree. A file over the limit and a
  // file the user edited after the turn stay on disk, so they're the only entries
  // `git status` may still show.
  revertIt.live(
    "R1: every snapshot-covered file the agent created is gone after /undo unless the user edited it",
    undoProperty(createdTurn, 25, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const at = (file: string) => path.join(dir, file)

          yield* put(at(".gitignore"), "build/\n")
          yield* put(at("kept-tracked.txt"), "tracked before the turn\n")
          yield* commitAll(dir)
          // Exists before the turn but isn't committed, so a careless
          // "delete everything untracked" would remove it.
          yield* put(at("kept-untracked.local"), "the user's own file\n")
          const clean = yield* gitStatus(dir)

          const session = yield* sessions.create({})
          const firstStep = Effect.forEach(
            input.created.filter((file) => file.step === 0),
            (file) => put(at(file.path), file.content),
          )
          const secondStep = Effect.forEach(input.created, (file) => {
            if (file.step === 1) return put(at(file.path), file.content)
            if (file.rewritten) return put(at(file.path), "rewritten in a later step\n")
            return Effect.void
          })
          const boundaryFiles = Effect.all([
            input.atLimit ? put(at("exact-limit.bin"), new Uint8Array(SNAPSHOT_LIMIT)) : Effect.void,
            input.overLimit ? put(at("over-limit.bin"), new Uint8Array(SNAPSHOT_LIMIT + 1)) : Effect.void,
            input.ignored ? put(at("build/out.log"), "generated\n") : Effect.void,
          ])
          const messageID = yield* agentTurn(session.id, dir, [
            firstStep.pipe(Effect.asVoid),
            secondStep.pipe(Effect.andThen(boundaryFiles), Effect.asVoid),
          ])

          yield* Effect.forEach(
            input.created.filter((file) => file.userEdited),
            (file) => put(at(file.path), USER_EDIT),
          )

          yield* revert.revert({ sessionID: session.id, messageID })

          for (const file of input.created) {
            if (file.userEdited) expect(yield* readBytes(at(file.path))).toEqual(USER_EDIT)
            if (!file.userEdited) expect(yield* exists(at(file.path))).toBe(false)
          }
          if (input.atLimit) expect(yield* exists(at("exact-limit.bin"))).toBe(false)
          // Snapshots never recorded these, so they must stay on disk.
          if (input.overLimit) expect(yield* exists(at("over-limit.bin"))).toBe(true)
          if (input.ignored) expect(yield* exists(at("build/out.log"))).toBe(true)
          expect(yield* exists(at("kept-tracked.txt"))).toBe(true)
          expect(yield* exists(at("kept-untracked.local"))).toBe(true)
          expect(yield* gitStatus(dir)).toEqual(
            [
              ...clean,
              ...input.created.filter((file) => file.userEdited).map((file) => `?? ${file.path}`),
              ...(input.overLimit ? ["?? over-limit.bin"] : []),
            ].toSorted(),
          )
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )

  // R2: When /undo reverts a turn, each snapshot-covered file (see R1) that the
  // agent edited or deleted and that hasn't changed since the turn ended returns
  // to its exact pre-turn content, unless its snapshot was pruned after about 7
  // days (then it's left untouched and reported under R6), and only the working
  // tree changes, not the git index, HEAD, or commits.
  // Kind: round-trip
  // Acceptance criteria: start with a clean git tree, the agent edits files, and
  // after /undo `git status` reports a clean tree and `git diff` is empty. The next
  // property covers the pruned-snapshot case.
  revertIt.live(
    "R2: edit then /undo restores the exact bytes of every file",
    undoProperty(editedTurn, 60, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const at = (file: string) => path.join(dir, file)

          yield* Effect.forEach(input.base, (file) => put(at(file.path), file.content))
          yield* commitAll(dir)
          const head = yield* git(dir, "rev-parse", "HEAD")

          const session = yield* sessions.create({})
          const messageID = yield* agentTurn(
            session.id,
            dir,
            input.steps.map((step) =>
              Effect.forEach(step, (op) => {
                const file = at(input.base[op.file % input.base.length]!.path)
                if (op.action.kind === "write") return put(file, op.action.content)
                if (op.action.kind === "delete") return del(file)
                // A base file can't be a rename target, because R2 compares its bytes.
                const to = op.action.to
                return input.base.some((item) => item.path === to) ? Effect.void : rename(file, at(to))
              }).pipe(Effect.asVoid),
            ),
            { abortLast: input.abortLast },
          )

          yield* revert.revert({ sessionID: session.id, messageID })

          for (const file of input.base) {
            expect(yield* exists(at(file.path))).toBe(true)
            expect(yield* readBytes(at(file.path))).toEqual(file.content)
          }
          expect(yield* gitStatus(dir)).toEqual([])
          expect(yield* git(dir, "diff")).toBe("")
          expect(yield* git(dir, "rev-parse", "HEAD")).toBe(head)
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )

  // R2: When /undo reverts a turn, each snapshot-covered file (see R1) that the
  // agent edited or deleted and that hasn't changed since the turn ended returns
  // to its exact pre-turn content, unless its snapshot was pruned after about 7
  // days (then it's left untouched and reported under R6), and only the working
  // tree changes, not the git index, HEAD, or commits.
  // Kind: invariant
  // Acceptance criteria: this covers the "unless its snapshot was pruned" clause.
  // After /undo, every file is exactly as the turn left it. Waiting 7 days isn't
  // practical in a test, so an unreadable hash stands in for a pruned snapshot.
  revertIt.live(
    "R2: /undo leaves files untouched when their snapshots were pruned",
    undoProperty(prunedTurn, 25, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const at = (file: string) => path.join(dir, file)

          yield* Effect.forEach(input.files, (file) => put(at(file.path), file.before))
          yield* commitAll(dir)

          const session = yield* sessions.create({})
          const messageID = yield* agentTurn(
            session.id,
            dir,
            [
              Effect.forEach(input.files, (file) =>
                file.agent === undefined ? del(at(file.path)) : put(at(file.path), file.agent),
              ).pipe(Effect.asVoid),
            ],
            { pruned: input.gone },
          )

          yield* revert.revert({ sessionID: session.id, messageID })

          for (const file of input.files) {
            if (file.agent === undefined) expect(yield* exists(at(file.path))).toBe(false)
            if (file.agent !== undefined) expect(yield* readBytes(at(file.path))).toEqual(file.agent)
          }
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )

  // R2: When /undo reverts a turn, each snapshot-covered file (see R1) that the
  // agent edited or deleted and that hasn't changed since the turn ended returns
  // to its exact pre-turn content, unless its snapshot was pruned after about 7
  // days (then it's left untouched and reported under R6), and only the working
  // tree changes, not the git index, HEAD, or commits.
  // Kind: round-trip
  // Acceptance criteria: this covers /undo run twice in a row, which undoes the
  // last two turns. After the second /undo, every file turn 1 touched has its
  // pre-turn-1 bytes, a file the user edited between the turns keeps that edit
  // (turn 1 never changed it, and turn 2 is already undone), every other file is
  // unchanged, a gitignored tracked file keeps the agent's edit because snapshots
  // don't cover it, and HEAD doesn't move.
  revertIt.live(
    "R2: two /undo in a row restore every file to its state before both turns",
    undoProperty(consecutiveUndo, 20, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const at = (file: string) => path.join(dir, file)
          const pathOf = (index: number) => input.base[index % input.base.length]!.path
          const ignored = at("ignored-tracked.log")
          const agentIgnoredEdit = new TextEncoder().encode("edited by the agent while gitignored\n")
          const apply = (ops: ReadonlyArray<{ file: number; content: Uint8Array | undefined }>) =>
            Effect.forEach(ops, (op) =>
              op.content === undefined ? del(at(pathOf(op.file))) : put(at(pathOf(op.file)), op.content),
            ).pipe(Effect.asVoid)

          yield* Effect.forEach(input.base, (file) => put(at(file.path), file.content))
          if (input.ignoredTracked) yield* put(ignored, "tracked before .gitignore matched it\n")
          yield* commitAll(dir)
          // Committed first, so the file stays tracked once .gitignore matches it.
          yield* put(at(".gitignore"), "*.log\n")
          yield* commitAll(dir)
          const head = yield* git(dir, "rev-parse", "HEAD")

          const touched = new Set(input.turn1.map((op) => pathOf(op.file)))
          const between = input.between.filter((edit) => !touched.has(pathOf(edit.file)))
          const session = yield* sessions.create({})
          const first = yield* agentTurn(session.id, dir, [
            apply(input.turn1).pipe(
              Effect.andThen(input.ignoredTracked ? put(ignored, agentIgnoredEdit) : Effect.void),
            ),
          ])
          yield* Effect.forEach(between, (edit) => put(at(pathOf(edit.file)), edit.content))
          const second = yield* agentTurn(session.id, dir, [
            apply([
              ...input.turn2,
              ...between.flatMap((edit) =>
                edit.agentAfter === undefined ? [] : [{ file: edit.file, content: edit.agentAfter }],
              ),
            ]),
          ])

          yield* revert.revert({ sessionID: session.id, messageID: second })
          yield* revert.revert({ sessionID: session.id, messageID: first })

          const userEdits = new Map(between.map((edit) => [pathOf(edit.file), edit.content]))
          for (const file of input.base) {
            const expected = touched.has(file.path) ? file.content : (userEdits.get(file.path) ?? file.content)
            expect(yield* readBytes(at(file.path))).toEqual(expected)
          }
          if (input.ignoredTracked) expect(yield* readBytes(ignored)).toEqual(agentIgnoredEdit)
          expect(yield* git(dir, "rev-parse", "HEAD")).toBe(head)
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )

  // R3: If, after the turn ended, the user edits a text file the agent modified
  // and those edits neither touch nor directly adjoin any line the agent changed,
  // /undo reverts only the agent's changes and keeps the user's edits exactly,
  // while changes made during the turn count as the agent's.
  // Kind: model / oracle
  // Acceptance criteria: the agent changes some lines and the user edits others
  // by hand. After /undo the agent's lines match the pre-turn content and the
  // user's edits remain, byte for byte. The oracle is modelSeparatedEdits, a plain
  // list of lines.
  revertIt.live(
    "R3: /undo agrees with a line-by-line model when edits don't overlap",
    undoProperty(separatedEdits, 25, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const file = path.join(dir, "Foo.java")
          const model = modelSeparatedEdits(input)

          yield* put(file, model.base)
          yield* commitAll(dir)

          const session = yield* sessions.create({})
          const messageID = yield* agentTurn(session.id, dir, [put(file, model.afterAgent)])
          // The turn is over, so this edit is the user's.
          yield* put(file, model.afterUser)

          yield* revert.revert({ sessionID: session.id, messageID })

          expect(yield* readBytes(file)).toEqual(model.expected)
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )

  // R4: If the user's post-turn edits touch or directly adjoin lines the agent
  // changed, or the file can't be merged by line (binary, created by the agent
  // then edited, or deleted by the agent then recreated), /undo names the file and
  // any conflicting on-disk lines in the TUI and asks to overwrite (return it to
  // its pre-turn state, discarding the user's edits) or skip (leave it
  // byte-identical, which is also the result of dismissing the prompt or using a
  // client that can't prompt), while other files are still reverted.
  // Kind: invariant
  // Acceptance criteria: SessionRevert is a client that can't prompt, so it must
  // skip. The conflicting file is byte-identical to its state just before /undo
  // (a symlink keeps its target, and nothing is written through it), and every
  // other file the agent edited is back to its pre-turn bytes. Created-then-edited
  // files are covered by the R1 property. The TUI's naming of files and lines and
  // the overwrite choice aren't implemented, so they aren't checked.
  revertIt.live(
    "R4: /undo leaves a file it can't merge byte-identical and still reverts the rest",
    undoProperty(conflictingEdits, 25, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const at = (file: string) => path.join(dir, file)
          const file = at("Conflict.java")
          const link = at("conflict-link")
          // Dangling targets, so a write through the link would create one.
          const targets = { before: "target-before.txt", agent: "target-agent.txt", new: "target-user.txt" }
          const versions = conflictVersions(input)
          const write = (content: Uint8Array | undefined) => (content === undefined ? del(file) : put(file, content))

          yield* Effect.forEach(input.others, (other) => put(at(other.path), other.before))
          yield* input.kind === "symlink" ? symlink(targets.before, link) : write(versions.before)
          yield* commitAll(dir)

          const session = yield* sessions.create({})
          const messageID = yield* agentTurn(session.id, dir, [
            Effect.forEach(input.others, (other) => put(at(other.path), other.agent)).pipe(
              Effect.andThen(input.kind === "symlink" ? symlink(targets.agent, link) : write(versions.agent)),
            ),
          ])
          // The turn is over, so this edit is the user's.
          yield* input.kind === "symlink" ? symlink(targets[input.userTarget], link) : write(versions.user)
          const linkBeforeUndo = input.kind === "symlink" ? yield* readLink(link) : undefined
          const bytesBeforeUndo = input.kind === "symlink" ? undefined : yield* readBytes(file)

          yield* revert.revert({ sessionID: session.id, messageID })

          if (input.kind === "symlink") {
            expect(yield* readLink(link)).toBe(linkBeforeUndo!)
            for (const target of Object.values(targets)) expect(yield* exists(at(target))).toBe(false)
          }
          if (input.kind !== "symlink") expect(yield* readBytes(file)).toEqual(bytesBeforeUndo!)
          for (const other of input.others) expect(yield* readBytes(at(other.path))).toEqual(other.before)
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )

  // R6: After every /undo, the TUI shows `Reverted (N files changed)` with each
  // affected path marked deleted, restored, kept your edits, skipped, or not
  // reverted (uncovered files only if changed by the edit, write, or apply_patch
  // tools), or it says that files weren't reverted because the project has no
  // snapshots, or that there was nothing to undo.
  // Kind: model / oracle
  // Acceptance criteria: the TUI's wording isn't implemented, so this checks the
  // data the TUI's file list reads after /undo: the stored session diff, the diff
  // event, the session summary, and the revert's own diff. Each must name exactly
  // the files the undone turn changed (not earlier turns, and not a file rewritten
  // with its own bytes), and the totals must be the lines the generator added and
  // removed. /undo given a message the session doesn't have is the nothing-to-undo
  // case: it records no revert and changes no files.
  revertIt.live(
    "R6: /undo reports exactly the files and lines the undone turn changed",
    undoProperty(reportedTurn, 20, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const storage = yield* Storage.Service
          const events = yield* EventV2Bridge.Service
          const at = (file: string) => path.join(dir, file)
          const lines = (prefix: string, count: number) =>
            Array.from({ length: count }, (_, line) => `${prefix}-${line}\n`).join("")
          const files = input.files.map((file) => ({ ...file, path: `${file.name}.txt` }))

          yield* Effect.forEach(
            files.filter((file) => file.change.kind !== "create"),
            (file) => put(at(file.path), lines("base", file.change.base)),
          )
          yield* commitAll(dir)

          const session = yield* sessions.create({})
          yield* Effect.forEach(
            Array.from({ length: input.earlierTurns }, (_, index) => index),
            (index) => agentTurn(session.id, dir, [put(at(`earlier-${index}.txt`), "from an earlier turn\n")]),
          )
          const messageID = yield* agentTurn(session.id, dir, [
            Effect.forEach(files, (file) => {
              const change = file.change
              if (change.kind === "delete") return del(at(file.path))
              if (change.kind === "truncate") return put(at(file.path), lines("base", change.base - change.lines))
              return put(at(file.path), lines("base", change.base) + lines("added", change.lines))
            }).pipe(Effect.asVoid),
          ])

          const status = yield* gitStatus(dir)
          const nothing = yield* revert.revert({ sessionID: session.id, messageID: MessageID.ascending() })
          expect(nothing.revert).toBeUndefined()
          expect(yield* gitStatus(dir)).toEqual(status)

          const published = yield* Deferred.make<ReadonlyArray<{ readonly file?: string }>>()
          const unsubscribe = yield* events.listen((event) => {
            if (event.type !== Session.Event.Diff.type) return Effect.void
            const data = decodeDiffEvent(event.data)
            if (Option.isSome(data) && data.value.sessionID === session.id) {
              Deferred.doneUnsafe(published, Effect.succeed(data.value.diff))
            }
            return Effect.void
          })
          yield* Effect.addFinalizer(() => unsubscribe)

          const undone = yield* revert.revert({ sessionID: session.id, messageID })

          const changed = files.filter((file) => file.change.kind !== "same")
          const expected = changed.map((file) => file.path).toSorted()
          const paths = (diffs: ReadonlyArray<{ readonly file?: string }>) => diffs.map((diff) => diff.file).toSorted()
          const stored = yield* storage.read<Snapshot.FileDiff[]>(["session_diff", session.id]).pipe(Effect.orDie)
          expect(paths(stored)).toEqual(expected)
          expect(paths(yield* awaitWithTimeout(Deferred.await(published), "no diff event after /undo"))).toEqual(
            expected,
          )
          expect(undone.summary?.files).toBe(expected.length)
          expect(undone.summary?.additions).toBe(
            changed.reduce(
              (sum, file) => sum + (["create", "append"].includes(file.change.kind) ? file.change.lines : 0),
              0,
            ),
          )
          expect(undone.summary?.deletions).toBe(
            changed.reduce((sum, file) => {
              if (file.change.kind === "truncate") return sum + file.change.lines
              if (file.change.kind === "delete") return sum + file.change.base
              return sum
            }, 0),
          )
          for (const file of expected) expect(undone.revert?.diff).toContain(file)
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )
})

// R5 needs the real request the model would receive, so unlike the file
// properties it runs through SessionPrompt against the fake LLM server. MCP and
// LSP are stubbed because they start external processes and don't affect history.
const promptIt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      SessionRevert.node,
      Database.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [
        MCP.node,
        Layer.mock(MCP.Service, {
          clients: () => Effect.succeed({}),
          tools: () => Effect.succeed({}),
          instructions: () => Effect.succeed([]),
        }),
      ],
      [LSP.node, Layer.mock(LSP.Service, {})],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

// JSON escapes characters such as quotes, so a search of the serialized request
// has to look for the escaped form or it would miss the secret and pass wrongly.
const inRequest = (text: string) => JSON.stringify(text).slice(1, -1)

const addEarlierTurns = Effect.fn("test.addEarlierTurns")(function* (sessionID: SessionID, dir: string, count: number) {
  yield* Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    Effect.fnUntraced(function* (index) {
      const user = yield* addUser(sessionID, `EARLIER-QUESTION-${index}`)
      const assistant = yield* addAssistant(sessionID, user.id, dir)
      yield* addText(sessionID, assistant.id, `EARLIER-ANSWER-${index}`)
    }),
  )
})

describe("/undo context properties", () => {
  // R5: `/undo` removes the undone prompt, the agent's response, and any file
  // contents the agent read during that turn from the conversation context sent
  // to the model in later turns.
  // Kind: metamorphic
  // Acceptance criteria: prompt 1 reads a file holding a secret, /undo runs, and
  // prompt 2 is sent. The request for prompt 2 holds neither the secret nor the
  // text of prompt 1. The metamorphic relation is stronger: adding a turn and then
  // undoing it must leave the next request's messages identical to a session
  // where that turn never happened.
  promptIt.live(
    "R5: adding then undoing a turn leaves the next request unchanged",
    undoProperty(undoneTurn, 20, (input) =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const prompt = yield* SessionPrompt.Service

          const sendSecondPrompt = Effect.fnUntraced(function* (sessionID: SessionID) {
            yield* llm.text("ok")
            const earlier = (yield* llm.inputs).length
            yield* prompt.prompt({
              sessionID,
              agent: "build",
              model: ref,
              parts: [{ type: "text", text: input.secondPrompt }],
            })
            return (yield* llm.inputs).slice(earlier)
          })

          // A fixed title stops a title-generation request from taking
          // the queued reply. It isn't part of the conversation context.
          const undone = yield* sessions.create({ title: "undone" })
          yield* addEarlierTurns(undone.id, dir, input.earlierTurns)
          const user = yield* addUser(undone.id, input.firstPrompt)
          if (input.carriers.includes("attachment")) {
            yield* addText(undone.id, user.id, `Attached notes.txt: ${input.secret}`, true)
          }
          const assistants = yield* Effect.forEach(
            Array.from({ length: input.assistantMessages }, (_, index) => index),
            Effect.fnUntraced(function* (index) {
              const assistant = yield* addAssistant(undone.id, user.id, dir)
              // A real assistant message always has parts, whatever it read.
              yield* addText(undone.id, assistant.id, `ASSISTANT-STEP-${index}`)
              if (input.carriers.includes("assistant-text")) {
                yield* addText(undone.id, assistant.id, `notes.txt says ${input.secret}`)
              }
              if (!input.carriers.includes("tool-output")) return assistant.id
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: assistant.id,
                sessionID: undone.id,
                type: "tool" as const,
                tool: "read",
                callID: `call-${index}`,
                state: {
                  status: "completed" as const,
                  input: { filePath: "notes.txt" },
                  output: input.secret,
                  title: "notes.txt",
                  metadata: {},
                  time: { start: 0, end: 1 },
                },
              })
              return assistant.id
            }),
          )

          const targets = [user.id, ...assistants]
          yield* revert.revert({ sessionID: undone.id, messageID: targets[input.target % targets.length]! })
          const afterUndo = yield* sendSecondPrompt(undone.id)

          const control = yield* sessions.create({ title: "control" })
          yield* addEarlierTurns(control.id, dir, input.earlierTurns)
          const withoutTurn = yield* sendSecondPrompt(control.id)

          expect(afterUndo.length).toBeGreaterThan(0)
          const sent = JSON.stringify(afterUndo)
          expect(sent).not.toContain(inRequest(input.secret))
          expect(sent).not.toContain(inRequest(input.firstPrompt))
          expect(sent).not.toContain("ASSISTANT-STEP-")
          expect(afterUndo.at(-1)?.messages).toEqual(withoutTurn.at(-1)?.messages)
        }),
        { git: true, config: testProviderConfig },
      ),
    ),
    TEST_TIMEOUT,
  )
})
