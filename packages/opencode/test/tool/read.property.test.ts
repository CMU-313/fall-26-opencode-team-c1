// property-based tests for the read tool (p4, wliu4)
// each test checks one requirement from traceability/wliu4.md on lots of
// generated inputs, not just the one example from p3

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import fc from "fast-check"

// fixed seed so stryker gets the same inputs every run (p5)
fc.configureGlobal({ seed: 42 })
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

// fake version of the session's permission check. it works like Permission.ask
// in src/permission/index.ts: deny fails, allow keeps going, ask asks the user.
// like the real one in src/session/tools.ts, a deny or a "no" from the user ends
// the tool call (Effect.orDie). userAllows is what the fake user clicks
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

// fast-check calls its callback as a normal promise, so grab the test's effect
// context once and run each generated case inside it
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

// only keep the file content part of the output (numbered lines + footer)
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

// generators

// one line of a file. interviewees cared about exact spacing (S-4 "the exact
// lines") so lines can be empty or have spaces and tabs, not just letters.
// no \n or \r since those end a line
const lineChar = fc.constantFrom(..."abcxyz019 _-.:{}\t")
const line = fc.string({ unit: lineChar, maxLength: 30 })

// a file is a list of lines plus whether it ends with a newline. real files do
// both so the tool should count lines the same either way
const fileLines = fc.array(line, { minLength: 1, maxLength: 30 })
const render = (lines: string[], trailingNewline: boolean) => lines.join("\n") + (trailingNewline ? "\n" : "")

// the lines a file actually has, counted from its text. an empty file has 0
// lines and a final \n just ends the last line
// (step 3 fix: first version counted the generated list instead, so a file made
// from [""] was expected to have 1 blank line but it's actually empty)
const linesOf = (text: string) => {
  if (text === "") return []
  const parts = text.split("\n")
  return text.endsWith("\n") ? parts.slice(0, -1) : parts
}

// append lines like an editor would: add a newline first only if the file has
// text that doesn't already end in one, and end every new line with \n so even
// a blank new line actually counts
const appendLines = (text: string, added: string[]) =>
  (text === "" || text.endsWith("\n") ? text : text + "\n") + added.map((l) => l + "\n").join("")

// file names someone would want protected (C-2 privacy, O-2 SSN/ID files), in
// a few different folders so rules get tested on real paths, not just the root
const folder = fc.constantFrom("", "config/", "secrets/", "src/app/")
const secretName = fc.constantFrom("secrets.txt", "id_card.pdf.txt", "ssn.txt", "private.key", "photo-notes.md")

// .env style names. *.env and *.env.* should ask, .env.example shouldn't.
// these match the default rules in src/agent/agent.ts
const envName = fc.constantFrom(".env", "prod.env", ".env.local", ".env.production", "app.env.test")
const envExampleName = fc.constantFrom(".env.example", "app.env.example")

// a marker that can't show up by accident, so searching for it tells us if
// any of the file leaked
const marker = fc.stringMatching(/^[A-Z]{6}[0-9]{4}$/).map((s) => `TOKEN_${s}`)

// properties

describe("read tool properties (traceability/wliu4.md)", () => {
  // R1: if the user's read rules deny a file, the read tool refuses it and
  // returns none of its contents. the decision only depends on the rules and the
  // file path, so a new session with the same rules denies it too.
  // kind: invariant
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
            // the user's rule is either the exact path or a glob like *.txt
            const pattern = useGlob ? `*${path.extname(name)}` : rel
            const ruleset = Permission.merge(agent.permission, Permission.fromConfig({ read: { [pattern]: "deny" } }))

            // two separate sessions with the same rules, both have to refuse
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

  // R2: by default, reading a .env file asks the user first, and the contents
  // are only returned if the user approves.
  // kind: invariant
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

            // user gets asked exactly once for this file
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

      // the .env.example exception: no prompt and the contents come back
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

  // R3: if a file is changed and then restored, reading it again shows the same
  // file content as the first read (same numbered lines and footer).
  // kind: round-trip
  it.live("R3: change a file, restore it, and the read content is identical", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      // a nested AGENTS.md gets attached on the first read only, which is why R3
      // compares just the content part and not the whole output
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

  // R4: adding lines to the end of a file doesn't change the lines already
  // shown. only the new lines and the total change.
  // kind: metamorphic
  it.live("R4: appending lines keeps earlier numbered lines and grows the total", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // small files so every case stays under the 2000 line default and the only
      // thing that changes between reads is the append
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
            // lines already shown stay the same...
            expect(after.slice(0, before.length)).toEqual(before)
            // ...and the only new lines are the added ones, numbered right after
            expect(after.slice(before.length)).toEqual(added.map((text, i) => `${before.length + i + 1}: ${text}`))
            expect(footerOf(a.output)).toBe(`(End of file - total ${before.length} lines)`)
            expect(footerOf(b.output)).toBe(`(End of file - total ${before.length + added.length} lines)`)
          }),
      )
    }),
  )

  // R5: when a file is too long to show at once, the output says which lines
  // were shown and how to get the rest.
  // kind: invariant
  it.live("R5: a cut-off read always says which lines it showed and where to continue", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // small limits stand in for the 2000 line default so it runs fast. offset
      // can land anywhere including the last line
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

      // files big enough to hit the 50 KB cap before the line limit
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

  // R6 (changed in p4): every line shown starts with its line number in the
  // file. a line over 2000 characters shows its first 2000 characters plus
  // "... (line truncated to 2000 chars)".
  // kind: model / oracle
  it.live("R6: every shown line matches the file at the line number it claims", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // the oracle is the simplest reader possible: split the file into its real
      // lines (linesOf) and number them. offset and limit stay inside the file so
      // every slice gets checked, even one line at the end. about 1 in 10 lines
      // is near the 2000 character limit (1990 to 2100) since that's where the
      // output and the file could disagree
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
          // step 3: first version expected long lines in full, but the tool cuts
          // them on purpose so R6 was changed and the oracle cuts them too
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