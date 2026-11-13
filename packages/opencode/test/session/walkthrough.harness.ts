// Harness and generators shared by walkthrough.property.test.ts and
// walkthrough.agent.property.test.ts (bnajibmo).

import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import fc from "fast-check"
import path from "path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Walkthrough } from "@opencode-ai/core/session/runner/walkthrough"
import type { ToolRegistry } from "@opencode-ai/core/tool/registry"

export const dir = "/project"
export const edits = ["edit", "write", "apply_patch"] as const
export const held = new Set<string>([...edits, "bash"])
export type ReadKind = "file" | "missing" | "dir" | "search"
export type Read = { path: string; kind: ReadKind }

let calls = 0
const call = (name: string, input: unknown): ToolRegistry.ExecuteInput => ({
  sessionID: SessionSchema.ID.make("ses_property"),
  agent: AgentV2.defaultID,
  assistantMessageID: SessionMessage.ID.make("msg_property"),
  call: { type: "tool-call", id: `call-${calls++}`, name, input },
})

// A scripted user: each prompt consumes the next answer. "dismiss" closes the
// prompt without choosing, which is what Esc does in the TUI.
export function harness(answers: string[]) {
  const prompts: string[] = []
  const options: string[][] = []
  const customs: boolean[] = []
  const order: string[] = []
  const gate = Walkthrough.make(dir, {
    ask: (input) =>
      Effect.suspend(() => {
        prompts.push(input.questions[0].question)
        options.push(input.questions[0].options.map((o) => o.label))
        customs.push(input.questions[0].custom === true)
        const answer = answers.shift() ?? "dismiss"
        order.push(`prompt:${answer}`)
        if (answer === "dismiss") return Effect.fail(new QuestionV2.RejectedError())
        return Effect.succeed([[answer]])
      }),
  })
  const run = async (name: string, input: unknown, kind: ReadKind = "file") => {
    // The tool must receive the call's own arguments, without the gate's
    // walkthrough fields (P5 strengthening).
    const own = Object.fromEntries(
      Object.entries(input as object).filter(([key]) => key !== "walkthrough" && key !== "walkthrough_answer"),
    )
    const execute: ToolRegistry.Materialization["settle"] = (received) =>
      Effect.sync(() => {
        order.push(name)
        expect(received.call.input).toEqual(own)
        if (kind === "missing") return { result: { type: "error", value: "not found" } }
        const structured = kind === "dir" ? { entries: [] } : { content: "text" }
        return { result: { type: "json", value: {} }, output: { structured, content: [] } }
      })
    const exit = await Effect.runPromise(gate.settle(call(name, input), execute).pipe(Effect.exit))
    if (Exit.isFailure(exit)) return "blocked"
    return exit.value.result.type === "error" ? "refused" : "ran"
  }
  // A read may fail, but the gate itself must never crash on one.
  const read = async (reads: Read[]) => {
    for (const r of reads) {
      const tool = r.kind === "search" ? "grep" : "read"
      expect(await run(tool, { path: r.path }, r.kind)).not.toBe("blocked")
    }
  }
  const ranHeld = () => order.filter((name) => held.has(name))
  return { gate, prompts, options, customs, order, run, read, ranHeld }
}

// What the gate must list: every distinct file read successfully, resolved
// against the project, in the order first read. Missing files and directory
// listings don't count.
export const expected = (reads: Read[]) => [
  ...new Set(reads.filter((r) => r.kind === "file").map((r) => path.resolve(dir, r.path))),
]
export const entries = (paths: string[], relative = false) =>
  paths.map((p) => ({ path: relative ? path.relative(dir, p) : p, explanation: `${path.basename(p)} matters here.` }))

// Generators. A small pool of names so reads repeat, and each path comes in the
// three spellings the model actually uses (bare, ./, absolute), so the same
// file can be read twice under different names. Some reads fail or hit a
// directory, and some are searches (grep) over a path, none of which count as
// reading a file, so the gate must leave them out of the list.
export const names = ["a.ts", "b.ts", "src/c.ts", "test/d.test.ts", "e.md"]
export const arbPath = fc
  .tuple(fc.constantFrom(...names), fc.constantFrom("", "./", `${dir}/`))
  .map(([name, prefix]) => prefix + name)
export const arbRead = fc.record({
  path: arbPath,
  kind: fc.constantFrom<ReadKind>("file", "file", "missing", "dir", "search"),
})
export const arbReads = fc.array(arbRead, { maxLength: 6 })
export const arbEdit = fc.constantFrom(...edits)
export const arbEdits = fc.array(arbEdit, { minLength: 1, maxLength: 4 })
export const arbText = fc.stringMatching(/^[a-z][a-z ?]{0,20}$/)
