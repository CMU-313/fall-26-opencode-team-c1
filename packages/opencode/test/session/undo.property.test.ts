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
import { Global } from "@opencode-ai/core/global"
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
  failedCheckout,
  prunedTurn,
  reportedTurn,
  separatedEdits,
  undoneTurn,
} from "./undo.generator"

// Under Stryker each mutant reruns every property, so counts are lower but still above each kill's
// first failing case.
const STRYKER = process.env.STRYKER === "1"

// Fixed seed. Under Stryker, skip shrinking, which can outlast the mutant timeout.
fc.configureGlobal({ seed: 42, endOnFailure: STRYKER })

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

// Runs a property with the test's services, giving each case a fresh repo.
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
          // Shrinking can spawn thousands of git processes, so stop in time and count a timeout as
          // a failure.
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

// Records an agent turn like the session processor: snapshots around each step and a patch if files
// changed. An aborted last step has no step-finish, and `pruned` swaps in an unreadable hash.
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

// R3 oracle: user segments get the user's lines, and every other line keeps its pre-turn text.
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
  // A missing final newline changes the last line, so it's only dropped when that line is
  // untouched.
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

// R4's non-symlink file versions, where undefined means no file. Binary versions start with NUL
// and end in distinct bytes.
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
  // R1: /undo deletes each snapshot-covered file the agent created, unless it changed after the
  // turn.
  // Kind: invariant
  // Acceptance criteria: after /undo, `git status` is clean except for the oversized and
  // user-edited files.
  revertIt.live(
    "R1: every snapshot-covered file the agent created is gone after /undo unless the user edited it",
    undoProperty(createdTurn, STRYKER ? 15 : 25, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const at = (file: string) => path.join(dir, file)

          yield* put(at(".gitignore"), "build/\n")
          yield* put(at("kept-tracked.txt"), "tracked before the turn\n")
          yield* commitAll(dir)
          // Untracked before the turn, so "delete everything untracked" would remove it.
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

  // R2, failed checkout: a file in the pre-turn snapshot whose checkout fails keeps the agent's bytes
  // instead of being deleted, and the other files are still restored.
  // Kind: invariant
  // Acceptance criteria: after /undo, each broken file keeps the agent's bytes and every other file
  // has its pre-turn bytes.
  revertIt.live(
    "R2: a snapshot-covered file whose checkout fails is kept, not deleted",
    undoProperty(failedCheckout, STRYKER ? 10 : 20, (input) =>
      provideTmpdirInstance(
        Effect.fnUntraced(function* (dir) {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const at = (file: string) => path.join(dir, file)
          // The prefix makes each blob unique, so deleting one breaks only that file.
          const version = (label: string, index: number, content: Uint8Array) =>
            new Uint8Array([...new TextEncoder().encode(`${label} ${index}\n`), ...content])

          // Left uncommitted so the pre-turn blobs live only in the snapshot repo, not in the project
          // repo it borrows objects from.
          yield* Effect.forEach(input, (file, index) => put(at(file.path), version("before", index, file.content)))
          const session = yield* sessions.create({})
          const messageID = yield* agentTurn(session.id, dir, [
            Effect.forEach(input, (file, index) => put(at(file.path), version("agent", index, file.content))).pipe(
              Effect.asVoid,
            ),
          ])

          // Deleting a pre-turn blob makes `git checkout` fail while `ls-tree` still lists the file.
          yield* Effect.forEach(
            input.flatMap((file, index) => (file.broken ? [version("before", index, file.content)] : [])),
            (bytes) =>
              Effect.promise(async () => {
                const oid = new Bun.CryptoHasher("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
                const objects = await Array.fromAsync(
                  new Bun.Glob(`snapshot/*/*/objects/${oid.slice(0, 2)}/${oid.slice(2)}`).scan({
                    cwd: Global.Path.data,
                    absolute: true,
                  }),
                )
                expect(objects.length).toBeGreaterThan(0)
                await Promise.all(objects.map((object) => fs.rm(object)))
              }),
          )

          yield* revert.revert({ sessionID: session.id, messageID })

          for (const [index, file] of input.entries()) {
            expect(yield* exists(at(file.path))).toBe(true)
            expect(yield* readBytes(at(file.path))).toEqual(
              version(file.broken ? "agent" : "before", index, file.content),
            )
          }
        }),
        { git: true },
      ),
    ),
    TEST_TIMEOUT,
  )

  // R2: /undo restores each snapshot-covered file the agent edited or deleted to its pre-turn
  // bytes, changing only the working tree.
  // Kind: round-trip
  // Acceptance criteria: after /undo, `git status` is clean and `git diff` is empty.
  revertIt.live(
    "R2: edit then /undo restores the exact bytes of every file",
    undoProperty(editedTurn, STRYKER ? 15 : 60, (input) =>
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

  // R2, pruned clause: a file whose snapshot was pruned stays as the turn left it.
  // Kind: invariant
  // Acceptance criteria: with an unreadable hash standing in for a pruned snapshot, /undo leaves
  // every file as the turn left it.
  revertIt.live(
    "R2: /undo leaves files untouched when their snapshots were pruned",
    undoProperty(prunedTurn, STRYKER ? 10 : 25, (input) =>
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

  // R2, two /undo in a row: both turns are undone.
  // Kind: round-trip
  // Acceptance criteria: files turn 1 touched get their pre-turn-1 bytes, user edits between the
  // turns stay, a gitignored tracked file keeps the agent's edit, and HEAD doesn't move.
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

  // R3: when the user's post-turn edits don't touch or adjoin the agent's lines, /undo reverts only
  // the agent's.
  // Kind: model / oracle
  // Acceptance criteria: after /undo the file matches modelSeparatedEdits byte for byte.
  revertIt.live(
    "R3: /undo agrees with a line-by-line model when edits don't overlap",
    undoProperty(separatedEdits, STRYKER ? 10 : 25, (input) =>
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

  // R4: when the user's post-turn edits touch or adjoin the agent's lines, or the file can't be
  // merged by line, /undo skips that file unless the user overwrites it, and reverts the rest.
  // Kind: invariant
  // Acceptance criteria: SessionRevert can't prompt, so it skips: the conflicting file or symlink is
  // unchanged, and other agent-edited files get their pre-turn bytes. The TUI prompt isn't checked.
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

  // R6: after /undo, the TUI lists each affected file and its outcome, or says nothing changed.
  // Kind: model / oracle
  // Acceptance criteria: the stored diff, diff event, summary and revert diff name exactly the files
  // the undone turn changed with the generated line totals, and /undo of an unknown message changes
  // nothing.
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

// R5 checks the real model request, so it runs through SessionPrompt and the fake LLM server, with
// MCP and LSP stubbed.
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

// JSON escapes quotes and similar characters, so search the request for the escaped secret.
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
  // R5: /undo removes the undone turn's prompt, response and read file contents from later
  // requests.
  // Kind: metamorphic
  // Acceptance criteria: adding and undoing a turn leaves the next request identical to never
  // having it, so it holds neither the secret nor prompt 1.
  promptIt.live(
    "R5: adding then undoing a turn leaves the next request unchanged",
    undoProperty(undoneTurn, STRYKER ? 10 : 20, (input) =>
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

          // A fixed title keeps a title request from taking the queued reply.
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
