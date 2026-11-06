// Property-based tests for the codebase walkthrough gate (P4, bnajibmo).
// Each test checks one requirement from traceability/bnajibmo.md against
// many generated inputs, not only the single example from P3.

import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fc from "fast-check"
import path from "path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Walkthrough } from "@opencode-ai/core/session/runner/walkthrough"
import type { ToolRegistry } from "@opencode-ai/core/tool/registry"

const dir = "/project"
const edits = ["edit", "write", "apply_patch"] as const
const held = new Set<string>([...edits, "bash"])
type ReadKind = "file" | "missing" | "dir"
type Read = { path: string; kind: ReadKind }

let calls = 0
const call = (name: string, input: unknown): ToolRegistry.ExecuteInput => ({
  sessionID: SessionSchema.ID.make("ses_property"),
  agent: AgentV2.defaultID,
  assistantMessageID: SessionMessage.ID.make("msg_property"),
  call: { type: "tool-call", id: `call-${calls++}`, name, input },
})

// A scripted user: each prompt consumes the next answer. "dismiss" closes the
// prompt without choosing, which is what Esc does in the TUI.
function harness(answers: string[]) {
  const prompts: string[] = []
  const order: string[] = []
  const gate = Walkthrough.make(dir, {
    ask: (input) =>
      Effect.suspend(() => {
        prompts.push(input.questions[0].question)
        const answer = answers.shift() ?? "dismiss"
        order.push(`prompt:${answer}`)
        if (answer === "dismiss") return Effect.fail(new QuestionV2.RejectedError())
        return Effect.succeed([[answer]])
      }),
  })
  const run = async (name: string, input: unknown, kind: ReadKind = "file") => {
    const execute: ToolRegistry.Materialization["settle"] = () =>
      Effect.sync(() => {
        order.push(name)
        if (kind === "missing") return { result: { type: "error", value: "not found" } }
        const structured = kind === "dir" ? { entries: [] } : { content: "text" }
        return { result: { type: "json", value: {} }, output: { structured, content: [] } }
      })
    const exit = await Effect.runPromise(gate.settle(call(name, input), execute).pipe(Effect.exit))
    if (Exit.isFailure(exit)) return "blocked"
    return exit.value.result.type === "error" ? "refused" : "ran"
  }
  const read = async (reads: Read[]) => {
    for (const r of reads) await run("read", { path: r.path }, r.kind)
  }
  const ranHeld = () => order.filter((name) => held.has(name))
  return { gate, prompts, order, run, read, ranHeld }
}

// What the gate must list: every distinct file read successfully, resolved
// against the project, in the order first read. Missing files and directory
// listings don't count.
const expected = (reads: Read[]) => [
  ...new Set(reads.filter((r) => r.kind === "file").map((r) => path.resolve(dir, r.path))),
]
const entries = (paths: string[], relative = false) =>
  paths.map((p) => ({ path: relative ? path.relative(dir, p) : p, explanation: `${path.basename(p)} matters here.` }))

// Generators. A small pool of names so reads repeat, and each path comes in the
// three spellings the model actually uses (bare, ./, absolute), so the same
// file can be read twice under different names. Some reads fail or hit a
// directory, which the gate must leave out of the list.
const names = ["a.ts", "b.ts", "src/c.ts", "test/d.test.ts", "e.md"]
const arbPath = fc
  .tuple(fc.constantFrom(...names), fc.constantFrom("", "./", `${dir}/`))
  .map(([name, prefix]) => prefix + name)
const arbRead = fc.record({ path: arbPath, kind: fc.constantFrom<ReadKind>("file", "file", "missing", "dir") })
const arbReads = fc.array(arbRead, { maxLength: 6 })
const arbEdit = fc.constantFrom(...edits)
const arbEdits = fc.array(arbEdit, { minLength: 1, maxLength: 4 })
const arbText = fc.stringMatching(/^[a-z][a-z ?]{0,20}$/)

describe("walkthrough properties", () => {
  // R1: Until the user chooses Continue, the edit, write, and apply_patch tools
  // change no file in the project. After Cancel, no file has changed.
  // Kind: invariant
  test("R1: no gated edit runs before Continue, and none runs after Cancel", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbReads,
        arbEdits,
        fc.constantFrom("Continue", "Cancel", "dismiss"),
        async (reads, tools, answer) => {
          const h = harness([answer])
          await h.read(reads)
          const list = entries(expected(reads))
          const results: string[] = []
          for (const tool of tools) results.push(await h.run(tool, { walkthrough: list }))
          const prompt = h.order.indexOf(`prompt:${answer}`)
          expect(prompt).toBeGreaterThanOrEqual(0)
          if (answer === "Continue") {
            expect(results.every((r) => r === "ran")).toBe(true)
            for (const [i, name] of h.order.entries()) if (held.has(name)) expect(i).toBeGreaterThan(prompt)
          } else {
            expect(results.every((r) => r === "blocked")).toBe(true)
            expect(h.ranHeld()).toEqual([])
          }
        },
      ),
    )
  })

  // R2 (revised in P4): Until the user chooses Continue, the bash tool is held
  // the same way as the edit tools: its first call shows the walkthrough and
  // waits, Continue lets it run, and Cancel blocks it.
  // Kind: invariant
  test("R2: bash is held behind the walkthrough like an edit", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbReads,
        arbText,
        fc.constantFrom("Continue", "Cancel", "dismiss"),
        async (reads, command, answer) => {
          const h = harness([answer])
          await h.read(reads)
          const result = await h.run("bash", { command, walkthrough: entries(expected(reads)) })
          expect(h.prompts).toHaveLength(1)
          if (answer === "Continue") {
            expect(result).toBe("ran")
            expect(h.order.indexOf("bash")).toBeGreaterThan(h.order.indexOf("prompt:Continue"))
          } else {
            expect(result).toBe("blocked")
            expect(h.ranHeld()).toEqual([])
          }
        },
      ),
    )
  })

  // R3: The walkthrough lists every file the agent successfully read in the
  // current request, each one once.
  // Kind: model/oracle. The reference model is `expected`: the set of resolved
  // paths of successful file reads. The gate must accept a candidate list
  // exactly when the candidate's resolved paths equal that set with no repeats.
  test("R3: the gate accepts a list exactly when it matches the set of files read", async () => {
    const arbMutation = fc.constantFrom("exact", "shuffled", "relative", "drop", "duplicate")
    await fc.assert(
      fc.asyncProperty(arbReads, arbEdit, arbMutation, fc.nat(), async (reads, tool, mutation, seed) => {
        const files = expected(reads)
        const pick = files.length ? seed % files.length : 0
        const candidate = {
          exact: files,
          shuffled: [...files.slice(pick), ...files.slice(0, pick)],
          relative: files,
          drop: files.filter((_, i) => i !== pick),
          duplicate: files.length ? [...files, files[pick]] : files,
        }[mutation]
        const resolved = candidate.map((p) => path.resolve(dir, p))
        const accepts =
          resolved.length === files.length &&
          new Set(resolved).size === resolved.length &&
          resolved.every((p) => files.includes(p))

        const h = harness(["Continue"])
        await h.read(reads)
        const list = entries(candidate, mutation === "relative")
        const result = await h.run(tool, { walkthrough: list })
        expect(result).toBe(accepts ? "ran" : "refused")
        expect(h.prompts).toHaveLength(accepts ? 1 : 0)
        if (accepts) for (const e of list) expect(h.prompts[0]).toContain(`${e.path} — ${e.explanation}`)
      }),
    )
  })

  // R4: The walkthrough's file list contains only files the agent read in the
  // current request.
  // Kind: invariant
  test("R4: a list naming an unread file is refused and nothing runs", async () => {
    await fc.assert(
      fc.asyncProperty(arbReads, arbEdit, arbPath, async (reads, tool, extra) => {
        const files = expected(reads)
        fc.pre(!files.includes(path.resolve(dir, extra)))
        const h = harness(["Continue"])
        await h.read(reads)
        const result = await h.run(tool, { walkthrough: entries([...files, extra]) })
        expect(result).toBe("refused")
        expect(h.prompts).toHaveLength(0)
        expect(h.ranHeld()).toEqual([])
      }),
    )
  })

  // R5: If the user cancels and sends the exact same request again, the
  // walkthrough appears again before the first edit, with the same file list.
  // Kind: round-trip
  test("R5: cancel then resend shows the same walkthrough again", async () => {
    await fc.assert(
      fc.asyncProperty(arbReads, arbEdit, async (reads, tool) => {
        const h = harness(["Cancel", "Continue"])
        const request = async () => {
          await h.read(reads)
          return h.run(tool, { walkthrough: entries(expected(reads)) })
        }
        expect(await request()).toBe("blocked")
        expect(h.ranHeld()).toEqual([])
        h.gate.reset()
        expect(await request()).toBe("ran")
        expect(h.prompts).toHaveLength(2)
        expect(h.prompts[1]).toBe(h.prompts[0])
      }),
    )
  })

  // R6 (revised in P4): A request with several edits shows one walkthrough,
  // before the first edit; later edits in the same request run without
  // another prompt.
  // Kind: metamorphic. Adding more edits to a request changes how many edits
  // run but never how many prompts appear.
  test("R6: one request prompts once however many edits it makes", async () => {
    await fc.assert(
      fc.asyncProperty(arbReads, arbEdits, async (reads, tools) => {
        const h = harness(["Continue"])
        await h.read(reads)
        const list = entries(expected(reads))
        for (const tool of tools) expect(await h.run(tool, { walkthrough: list })).toBe("ran")
        expect(h.prompts).toHaveLength(1)
        expect(h.ranHeld()).toEqual(tools)
      }),
    )
  })

  // R7: Approval covers one request only: each new message that leads to an
  // edit shows a new walkthrough.
  // Kind: metamorphic. Adding a request that edits adds exactly one prompt.
  test("R7: every request that edits prompts again", async () => {
    const arbRequest = fc.record({ reads: arbReads, tools: arbEdits })
    await fc.assert(
      fc.asyncProperty(fc.array(arbRequest, { minLength: 1, maxLength: 4 }), async (requests) => {
        const h = harness(requests.map(() => "Continue"))
        for (const [i, request] of requests.entries()) {
          h.gate.reset()
          await h.read(request.reads)
          const list = entries(expected(request.reads))
          for (const tool of request.tools) expect(await h.run(tool, { walkthrough: list })).toBe("ran")
          expect(h.prompts).toHaveLength(i + 1)
        }
      }),
    )
  })

  // R8: At the walkthrough prompt, the user can type a question about a file.
  // The answer appears in a new walkthrough, and nothing is edited until the
  // user chooses Continue.
  // Kind: invariant
  test("R8: a typed question is answered in a new prompt and edits wait for Continue", async () => {
    await fc.assert(
      fc.asyncProperty(arbReads, arbEdit, arbText, arbText, async (reads, tool, question, answer) => {
        const h = harness([question, "Continue"])
        await h.read(reads)
        const list = entries(expected(reads))
        expect(await h.run(tool, { walkthrough: list })).toBe("refused")
        expect(await h.run(tool, { walkthrough: list })).toBe("refused")
        expect(h.prompts).toHaveLength(1)
        expect(h.ranHeld()).toEqual([])
        expect(await h.run(tool, { walkthrough: list, walkthrough_answer: answer })).toBe("ran")
        expect(h.prompts).toHaveLength(2)
        expect(h.prompts[1]).toContain(`Your question: ${question}`)
        expect(h.prompts[1]).toContain(`Answer: ${answer}`)
        expect(h.order.indexOf(tool)).toBeGreaterThan(h.order.indexOf("prompt:Continue"))
      }),
    )
  })
})
