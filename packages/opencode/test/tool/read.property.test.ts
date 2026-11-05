// Property-based tests for the read tool (Project 4, wliu4).
// Each test checks one requirement from traceability/wliu4.md for every input
// fast-check generates, not just the single example from Project 3.

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const readLayer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    LSP.node,
    Ripgrep.node,
    Truncate.node,
  ]),
)
const it = testEffect(Layer.mergeAll(readLayer, testInstanceStoreLayer))

type Args = Tool.InferParameters<typeof ReadTool>
type AskRequest = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

const baseCtx = (session = "ses_prop"): Tool.Context => ({
  sessionID: SessionID.make(session),
  messageID: MessageID.make("msg_prop"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

// Stand-in for the session's permission check. It applies the same rule as
// Permission.ask in src/permission/index.ts: evaluate each pattern against the
// ruleset, fail on "deny", continue on "allow", and ask the user on "ask".
// Like the real wiring in src/session/tools.ts, a denial or rejection ends the
// tool call (Effect.orDie). `userAllows` decides what the simulated user clicks.
const permissionCtx = (ruleset: PermissionV1.Ruleset, userAllows: boolean, session?: string) => {
  const prompts: AskRequest[] = []
  const ctx: Tool.Context = {
    ...baseCtx(session),
    ask: (req: AskRequest) =>
      Effect.gen(function* () {
        let needsAsk = false
        for (const pattern of req.patterns) {
          const rule = Permission.evaluate(req.permission, pattern, ruleset)
          if (rule.action === "deny") return yield* new PermissionV1.DeniedError({ ruleset: [] })
          if (rule.action === "ask") needsAsk = true
        }
        if (!needsAsk) return
        prompts.push(req)
        if (!userAllows) return yield* new PermissionV1.RejectedError()
      }).pipe(Effect.orDie),
  }
  return { ctx, prompts }
}

const read = Effect.fn("ReadProperty.read")(function* (dir: string, args: Args, ctx: Tool.Context = baseCtx()) {
  return yield* provideInstance(dir)(
    Effect.gen(function* () {
      const tool = yield* (yield* ReadTool).init()
      return yield* tool.execute(args, ctx)
    }),
  )
})

const readExit = (dir: string, args: Args, ctx?: Tool.Context) => read(dir, args, ctx).pipe(Effect.exit)

const put = Effect.fn("ReadProperty.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

// fast-check runs its async callback as a plain Promise, so capture the test's
// Effect context once and run each generated case inside it.
const forAll = <Ts extends [unknown, ...unknown[]], R>(
  arbs: { [K in keyof Ts]: fc.Arbitrary<Ts[K]> },
  check: (...values: Ts) => Effect.Effect<void, unknown, R>,
  params: { numRuns?: number } = {},
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const run = Effect.runPromiseWith(context)
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(...(arbs as unknown as [fc.Arbitrary<Ts[0]>]), (...values: unknown[]) =>
          run(check(...(values as Ts))),
        ),
        params,
      ),
    )
  })

// Pull out just the file-content section: the numbered lines and the footer.
const contentOf = (output: string) => {
  const start = output.indexOf("<content>\n")
  const end = output.lastIndexOf("\n</content>")
  return output.slice(start + "<content>\n".length, end)
}
const numberedLines = (output: string) =>
  contentOf(output)
    .split("\n")
    .filter((l) => /^\d+: /.test(l))
const footerOf = (output: string) => contentOf(output).split("\n").at(-1) ?? ""

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// One line of a file. Interviewees cared about exact spacing (S-4: "the exact
// lines"), so lines include empty strings, leading/trailing spaces, and tabs,
// not just letters. "\n" and "\r" are excluded because they end a line.
const lineChar = fc.constantFrom(..."abcxyz019 _-.:{}\t")
const line = fc.string({ unit: lineChar, maxLength: 30 })

// A whole file as a list of lines, plus whether the last line ends with "\n".
// Both endings are common in real code, and the tool must count lines the same
// way for either.
const fileLines = fc.array(line, { minLength: 1, maxLength: 30 })
const render = (lines: string[], trailingNewline: boolean) => lines.join("\n") + (trailingNewline ? "\n" : "")

// The lines a file really has, counted from its text. A zero-byte file has no
// lines, and a final "\n" ends the last line instead of starting a new one.
// (Step 3 fix: the first version counted the generated list instead, so a file
// written from [""] was expected to have one blank line, but it is empty.)
const linesOf = (text: string) => {
  if (text === "") return []
  const parts = text.split("\n")
  return text.endsWith("\n") ? parts.slice(0, -1) : parts
}

// Add lines to the end of a file the way an editor would: start a new line
// only if the file has content that does not already end in "\n", and end
// every added line with "\n" so even a blank added line really exists.
const appendLines = (text: string, added: string[]) =>
  (text === "" || text.endsWith("\n") ? text : text + "\n") + added.map((l) => l + "\n").join("")

// File names a user would actually want protected (C-2: privacy, O-2: SSN and
// ID files), nested at various depths, so rules are tested against real paths
// and not only a single file at the project root.
const folder = fc.constantFrom("", "config/", "secrets/", "src/app/")
const secretName = fc.constantFrom("secrets.txt", "id_card.pdf.txt", "ssn.txt", "private.key", "photo-notes.md")

// .env-style names. "*.env" and "*.env.*" must ask, ".env.example" must not.
// These are exactly the boundaries of the default rules in src/agent/agent.ts.
const envName = fc.constantFrom(".env", "prod.env", ".env.local", ".env.production", "app.env.test")
const envExampleName = fc.constantFrom(".env.example", "app.env.example")

// A marker that cannot appear by accident, so "returns none of its contents"
// can be checked by searching for it.
const marker = fc.stringMatching(/^[A-Z]{6}[0-9]{4}$/).map((s) => `TOKEN_${s}`)

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("read tool properties (traceability/wliu4.md)", () => {
  // R1: If the user's read permission rules deny a file, the read tool refuses
  // to read it and returns none of its contents, even when the user asks for
  // that file by name. The decision depends only on the rules and the file's
  // path, so checking the same rules again, as a new session does, always
  // gives the same denial.
  // Kind: invariant
  it.live("R1: a denied file is always refused and none of its contents leak", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const agent = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Agent.Service
          return yield* svc.get("build")
        }),
      )
      yield* forAll(
        [folder, secretName, marker, fc.boolean()],
        (dirPart, name, secret, useGlob) =>
          Effect.gen(function* () {
            const rel = dirPart + name
            yield* put(path.join(dir, rel), `first line\n${secret}\nlast line`)
            // The user's rule is either the exact path or a glob over the extension.
            const pattern = useGlob ? `*${path.extname(name)}` : rel
            const ruleset = Permission.merge(agent.permission, Permission.fromConfig({ read: { [pattern]: "deny" } }))

            // Two separate sessions with the same rules: both must refuse.
            for (const session of ["ses_first", "ses_reopened"]) {
              const { ctx } = permissionCtx(ruleset, true, session)
              const exit = yield* readExit(dir, { filePath: path.join(dir, rel) }, ctx)
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) {
                expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
                expect(String(Cause.squash(exit.cause))).not.toContain(secret)
              }
              expect(Permission.evaluate("read", rel, ruleset).action).toBe("deny")
            }
          }),
        { numRuns: 40 },
      )
    }),
  )

  // R2: By default, reading a .env file stops and asks the user first, and the
  // file's contents are returned only if the user approves.
  // Kind: invariant
  it.live("R2: with default rules, .env files ask first and only return contents if approved", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const agent = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Agent.Service
          return yield* svc.get("build")
        }),
      )
      yield* forAll(
        [folder, envName, marker, fc.boolean()],
        (dirPart, name, secret, userAllows) =>
          Effect.gen(function* () {
            const rel = dirPart + name
            yield* put(path.join(dir, rel), `API_KEY=${secret}`)
            const { ctx, prompts } = permissionCtx(agent.permission, userAllows)
            const exit = yield* readExit(dir, { filePath: path.join(dir, rel) }, ctx)

            // The user is always asked, exactly once, for this file.
            expect(prompts).toHaveLength(1)
            expect(prompts[0].permission).toBe("read")
            expect(prompts[0].patterns).toEqual([rel])

            if (userAllows) {
              expect(Exit.isSuccess(exit)).toBe(true)
              if (Exit.isSuccess(exit)) expect(exit.value.output).toContain(secret)
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).not.toContain(secret)
            }
          }),
        { numRuns: 40 },
      )

      // The .env.example exception: no prompt, contents returned.
      yield* forAll(
        [folder, envExampleName, marker],
        (dirPart, name, secret) =>
          Effect.gen(function* () {
            const rel = dirPart + name
            yield* put(path.join(dir, rel), `API_KEY=${secret}`)
            const { ctx, prompts } = permissionCtx(agent.permission, false)
            const result = yield* read(dir, { filePath: path.join(dir, rel) }, ctx)
            expect(prompts).toHaveLength(0)
            expect(result.output).toContain(secret)
          }),
        { numRuns: 20 },
      )
    }),
  )

  // R3: If a file is changed and then restored to its exact original contents,
  // reading it again shows file content identical to the first read: the same
  // numbered lines and the same end-of-file footer.
  // Kind: round-trip
  it.live("R3: change a file, restore it, and the read content is identical", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      // A nested AGENTS.md makes the tool attach instructions on the first read
      // only. That is why R3 compares the content section, not the full output.
      yield* put(path.join(dir, "notes", "AGENTS.md"), "Project notes instructions.")
      yield* forAll([fileLines, fc.boolean(), fc.nat(), line], (lines, trailing, editAt, replacement) =>
        Effect.gen(function* () {
          const file = path.join(dir, "notes", "notes.txt")
          const original = render(lines, trailing)
          const edited = [...lines]
          edited[editAt % lines.length] = replacement + "!"
          yield* put(file, original)
          const a = yield* read(dir, { filePath: file })
          yield* put(file, render(edited, trailing))
          yield* put(file, original)
          const b = yield* read(dir, { filePath: file })
          expect(contentOf(b.output)).toBe(contentOf(a.output))
        }),
      )
    }),
  )

  // R4: Adding lines to the end of a file does not change the numbered lines
  // that were already shown. The only differences are the new lines and the
  // line total.
  // Kind: metamorphic
  it.live("R4: appending lines keeps earlier numbered lines and grows the total", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // Small files keep every case under the 2000-line default, so the only
      // thing that changes between reads is the append itself.
      yield* forAll(
        [fileLines, fc.array(line, { minLength: 1, maxLength: 10 }), fc.boolean()],
        (lines, added, trailing) =>
          Effect.gen(function* () {
            const file = path.join(dir, "grow.txt")
            const original = render(lines, trailing)
            yield* put(file, original)
            const a = yield* read(dir, { filePath: file })
            yield* put(file, appendLines(original, added))
            const b = yield* read(dir, { filePath: file })

            const before = numberedLines(a.output)
            const after = numberedLines(b.output)
            expect(before).toHaveLength(linesOf(original).length)
            // The lines already shown are unchanged...
            expect(after.slice(0, before.length)).toEqual(before)
            // ...and the only new lines are the added ones, numbered after them.
            expect(after.slice(before.length)).toEqual(added.map((text, i) => `${before.length + i + 1}: ${text}`))
            expect(footerOf(a.output)).toBe(`(End of file - total ${before.length} lines)`)
            expect(footerOf(b.output)).toBe(`(End of file - total ${before.length + added.length} lines)`)
          }),
      )
    }),
  )

  // R5: When a file is too long to show in one read, the output says which
  // lines were shown and how to get the rest. It never stops without saying so.
  // Kind: invariant
  it.live("R5: a cut-off read always says which lines it showed and where to continue", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // Small limits stand in for the 2000-line default so each case stays fast.
      // The offset can land anywhere, including the last line.
      const caseArb = fc
        .record({ total: fc.integer({ min: 1, max: 60 }), limit: fc.integer({ min: 1, max: 60 }) })
        .chain(({ total, limit }) =>
          fc.record({
            total: fc.constant(total),
            limit: fc.constant(limit),
            offset: fc.integer({ min: 1, max: total }),
          }),
        )
      yield* forAll([caseArb], ({ total, limit, offset }) =>
        Effect.gen(function* () {
          const file = path.join(dir, "long.txt")
          yield* put(file, Array.from({ length: total }, (_, i) => `row ${i + 1}`).join("\n"))
          const result = yield* read(dir, { filePath: file, offset, limit })
          const last = Math.min(offset + limit - 1, total)
          expect(numberedLines(result.output)).toHaveLength(last - offset + 1)
          expect(footerOf(result.output)).toBe(
            last < total
              ? `(Showing lines ${offset}-${last} of ${total}. Use offset=${last + 1} to continue.)`
              : `(End of file - total ${total} lines)`,
          )
        }),
      )

      // Files big enough to hit the 50 KB byte cap before the line limit.
      yield* forAll(
        [fc.integer({ min: 40, max: 120 }), fc.integer({ min: 800, max: 1900 })],
        (rows, width) =>
          Effect.gen(function* () {
            const file = path.join(dir, "wide.txt")
            yield* put(file, Array.from({ length: rows }, (_, i) => `${i + 1}`.padEnd(width, "x")).join("\n"))
            const result = yield* read(dir, { filePath: file })
            const shown = numberedLines(result.output).length
            if (shown < rows) {
              expect(footerOf(result.output)).toBe(
                `(Output capped at 50 KB. Showing lines 1-${shown}. Use offset=${shown + 1} to continue.)`,
              )
            } else {
              expect(footerOf(result.output)).toBe(`(End of file - total ${rows} lines)`)
            }
          }),
        { numRuns: 25 },
      )
    }),
  )

  // R6 (revised in P4): Every line the read tool shows starts with its line
  // number in the original file, so the user can check the output against the
  // file. A line longer than 2000 characters is shown as its first 2000
  // characters followed by "... (line truncated to 2000 chars)".
  // Kind: model / oracle
  it.live("R6: every shown line matches the file at the line number it claims", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // The oracle is the simplest possible reader: take the file's real lines
      // (linesOf) and number them. Offsets and limits are generated within the
      // file so every slice, including a single line at the end, gets checked.
      // About 1 in 10 lines sits near the tool's 2000-character line limit
      // (1990 to 2100 chars), since that boundary is where output and file
      // could disagree.
      const mixedLine = fc.oneof(
        { weight: 9, arbitrary: line },
        { weight: 1, arbitrary: fc.integer({ min: 1990, max: 2100 }).map((n) => "w".repeat(n)) },
      )
      const caseArb = fc
        .tuple(fc.array(mixedLine, { minLength: 1, maxLength: 30 }), fc.boolean())
        .chain(([lines, trailing]) => {
          const n = Math.max(1, linesOf(render(lines, trailing)).length)
          return fc.record({
            text: fc.constant(render(lines, trailing)),
            offset: fc.integer({ min: 1, max: n }),
            limit: fc.integer({ min: 1, max: n }),
          })
        })
      yield* forAll([caseArb], ({ text, offset, limit }) =>
        Effect.gen(function* () {
          const file = path.join(dir, "check.txt")
          yield* put(file, text)
          const result = yield* read(dir, { filePath: file, offset, limit })
          // Step 3: the first version expected long lines in full. The tool cuts
          // them on purpose, so R6 was revised and the oracle now does the same.
          const shown = (t: string) => (t.length > 2000 ? t.slice(0, 2000) + "... (line truncated to 2000 chars)" : t)
          const expected = linesOf(text)
            .slice(offset - 1, offset - 1 + limit)
            .map((t, i) => `${offset + i}: ${shown(t)}`)
          expect(numberedLines(result.output)).toEqual(expected)
        }),
      )
    }),
  )
})
