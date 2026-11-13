import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { LSP } from "../../src/lsp/lsp"
import { Instruction } from "../../src/session/instruction"
import { MessageID, SessionID } from "../../src/session/schema"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool/truncate"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
        Truncate.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

it.instance("R5: truncated reads report the shown lines and how to continue", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const fs = yield* FSUtil.Service
    const info = yield* ReadTool
    const tool = yield* info.init()
    const services = yield* Effect.context<FSUtil.Service | Instruction.Service | LSP.Service>()
    const ctx = {
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }

    // Fixed-width ASCII lines avoid per-line truncation; every case exercises both line and byte caps.
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(
          fc.record({
            width: fc.integer({ min: 64, max: 2000 }),
            offset: fc.integer({ min: 1, max: 10 }),
            limit: fc.integer({ min: 1, max: 20 }),
            extra: fc.integer({ min: 1, max: 30 }),
          }),
          async ({ width, offset, limit, extra }) => {
            await Effect.gen(function* () {
              const filePath = path.join(instance.directory, "r5.txt")
              const cappedLines = Math.floor((50 * 1024 + 1) / (width + 1))
              const lines = Array.from({ length: cappedLines + extra }, (_, i) =>
                `${i + 1}:`.padEnd(width, "x"),
              )
              yield* fs.writeWithDirs(filePath, lines.join("\n"))

              for (const page of [
                { offset, limit, shown: limit, capped: false },
                { offset: 1, limit: lines.length, shown: cappedLines, capped: true },
              ]) {
                const result = yield* tool.execute({ filePath, offset: page.offset, limit: page.limit }, ctx)
                const last = page.offset + page.shown - 1
                const notice = page.capped
                  ? `(Output capped at 50 KB. Showing lines 1-${last}. Use offset=${last + 1} to continue.)`
                  : `(Showing lines ${page.offset}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`

                expect(result.metadata.truncated).toBe(true)
                expect(result.output.endsWith(`${notice}\n</content>`)).toBe(true)
                expect(result.output.split("\n").filter((line) => /^\d+: /.test(line))).toEqual(
                  lines.slice(page.offset - 1, last).map((line, i) => `${page.offset + i}: ${line}`),
                )

                const next = yield* tool.execute({ filePath, offset: last + 1, limit: 1 }, ctx)
                expect(next.output.split("\n").filter((line) => /^\d+: /.test(line))).toEqual([
                  `${last + 1}: ${lines[last]}`,
                ])
              }
            }).pipe(Effect.provide(services), Effect.runPromise)
          },
        ),
        { numRuns: 100 },
      ),
    )
  }),
)
