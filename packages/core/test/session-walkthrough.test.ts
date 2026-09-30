import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber } from "effect"
import { ToolDefinition } from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Walkthrough } from "@opencode-ai/core/session/runner/walkthrough"
import type { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { it } from "./lib/effect"

const files = ["src/main.ts", "src/config.ts", "test/main.test.ts"]
const walkthrough = files.map((path) => ({ path, explanation: `${path} defines behavior needed for this change.` }))
const call = (name: string, input: unknown = {}): ToolRegistry.ExecuteInput => ({
  sessionID: SessionSchema.ID.make("ses_walkthrough"),
  agent: AgentV2.defaultID,
  assistantMessageID: SessionMessage.ID.make("msg_walkthrough"),
  call: { type: "tool-call", id: `call-${name}`, name, input },
})

const fixture = Effect.gen(function* () {
  const asked = yield* Deferred.make<QuestionV2.AskInput>()
  const answer = yield* Deferred.make<ReadonlyArray<QuestionV2.Answer>, QuestionV2.RejectedError>()
  const order: string[] = []
  const gate = Walkthrough.make("/project", {
    ask: (input) =>
      Effect.gen(function* () {
        order.push("walkthrough")
        yield* Deferred.succeed(asked, input)
        return yield* Deferred.await(answer)
      }),
  })
  const execute: ToolRegistry.Materialization["settle"] = (input) =>
    Effect.sync(() => {
      order.push(input.call.name)
      expect(input.call.input).not.toHaveProperty("walkthrough")
      return { result: { type: "json", value: {} }, output: { structured: { content: "fixture" }, content: [] } }
    })
  return { gate, asked, answer, order, execute }
})

describe("Walkthrough", () => {
  it.effect("lists three reads before editing and waits for Continue only once", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.forEach(files, (path) => f.gate.settle(call("read", { path }), f.execute))
      const edit = yield* f.gate.settle(call("edit", { walkthrough }), f.execute).pipe(Effect.forkChild)
      const prompt = yield* Deferred.await(f.asked)
      expect(f.order).toEqual(["read", "read", "read", "walkthrough"])
      for (const file of walkthrough) {
        expect(prompt.questions[0].question).toContain(`${file.path} — ${file.explanation}`)
      }
      yield* Deferred.succeed(f.answer, [["Continue"]])
      yield* Fiber.join(edit)
      yield* f.gate.settle(call("write"), f.execute)
      yield* f.gate.settle(call("apply_patch"), f.execute)
      expect(f.order).toEqual(["read", "read", "read", "walkthrough", "edit", "write", "apply_patch"])
    }),
  )

  it.effect("does not emit a walkthrough for a reads-only turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.forEach(files, (path) => f.gate.settle(call("read", { path }), f.execute))
      expect(f.order).toEqual(["read", "read", "read"])
    }),
  )

  for (const dismiss of [false, true])
    it.effect(`blocks queued edits after ${dismiss ? "dismissal" : "Cancel"}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const run = yield* Effect.all(
          ["edit", "write", "apply_patch"].map((name) =>
            f.gate.settle(call(name, { walkthrough: [] }), f.execute).pipe(Effect.exit),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(f.asked)
        if (dismiss) yield* Deferred.fail(f.answer, new QuestionV2.RejectedError())
        if (!dismiss) yield* Deferred.succeed(f.answer, [["Cancel"]])
        const results = yield* Fiber.join(run)
        expect(results.every((result) => result._tag === "Failure" && Cause.hasDies(result.cause))).toBe(true)
        expect(f.order).toEqual(["walkthrough"])
      }),
    )

  it.effect("answers a follow-up and prompts again before allowing an edit", () =>
    Effect.gen(function* () {
      const prompts: QuestionV2.AskInput[] = []
      const f = yield* fixture
      const gate = Walkthrough.make("/project", {
        ask: (input) => {
          prompts.push(input)
          expect(f.order).toEqual(["read"])
          return Effect.succeed([[prompts.length === 1 ? "Why change main.ts?" : "Continue"]])
        },
      })
      yield* gate.settle(call("read", { path: files[0] }), f.execute)
      const input = { walkthrough: walkthrough.slice(0, 1) }
      expect((yield* gate.settle(call("edit", input), f.execute)).result.type).toBe("error")
      expect((yield* gate.settle(call("edit", input), f.execute)).result.type).toBe("error")
      expect(prompts).toHaveLength(1)
      yield* gate.settle(
        call("edit", { ...input, walkthrough_answer: "It contains the startup code we are fixing." }),
        f.execute,
      )
      expect(prompts[1].questions[0].question).toContain("Answer: It contains the startup code we are fixing.")
      expect(prompts[1].questions[0].question).toContain(files[0])
      expect(f.order).toEqual(["read", "edit"])
    }),
  )

  it.effect("rejects omitted, duplicate, invented, and blank file explanations", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.forEach(files, (path) => f.gate.settle(call("read", { path }), f.execute))
      for (const entries of [
        [],
        walkthrough.slice(0, 2),
        [walkthrough[0], walkthrough[0], walkthrough[2]],
        [...walkthrough.slice(0, 2), { path: "unread.ts", explanation: "Not read" }],
        walkthrough.map((file) => ({ ...file, explanation: " " })),
      ]) {
        expect((yield* f.gate.settle(call("edit", { walkthrough: entries }), f.execute)).result.type).toBe("error")
      }
      expect(f.order).toEqual(["read", "read", "read"])
    }),
  )

  it.effect("deduplicates paths and excludes failed reads and directory listings", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.gate.settle(call("read", { path: files[0] }), f.execute)
      yield* f.gate.settle(call("read", { path: `/project/${files[0]}` }), f.execute)
      yield* f.gate.settle(call("read", { path: "missing.ts" }), () =>
        Effect.succeed({ result: { type: "error", value: "Missing" } }),
      )
      yield* f.gate.settle(call("read", { path: "src" }), () =>
        Effect.succeed({ result: { type: "json", value: {} }, output: { structured: { entries: [] }, content: [] } }),
      )
      yield* Deferred.succeed(f.answer, [["Continue"]])
      yield* f.gate.settle(call("edit", { walkthrough: walkthrough.slice(0, 1) }), f.execute)
      expect(f.order).toEqual(["read", "read", "walkthrough", "edit"])
    }),
  )

  it.effect("clears approval and read files for the next request", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Deferred.succeed(f.answer, [["Continue"]])
      yield* f.gate.settle(call("read", { path: files[0] }), f.execute)
      yield* f.gate.settle(call("edit", { walkthrough: walkthrough.slice(0, 1) }), f.execute)
      f.gate.reset()
      yield* f.gate.settle(call("write", { walkthrough: [] }), f.execute)
      expect(f.order).toEqual(["read", "walkthrough", "edit", "walkthrough", "write"])
    }),
  )

  it.effect("only decorates edit schemas until approval", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const tools = ["read", "edit", "write", "apply_patch"].map(
        (name) => new ToolDefinition({ name, description: name, inputSchema: { type: "object", properties: {} } }),
      )
      const definitions = f.gate.definitions(tools)
      expect(definitions[0]).toBe(tools[0])
      for (const tool of definitions.slice(1)) expect(tool.inputSchema.properties).toHaveProperty("walkthrough")
      yield* Deferred.succeed(f.answer, [["Continue"]])
      yield* f.gate.settle(call("write", { walkthrough: [] }), f.execute)
      expect(f.gate.definitions(tools)).toEqual(tools)
    }),
  )
})
