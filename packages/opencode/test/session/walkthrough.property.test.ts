// Property-based tests for the codebase walkthrough gate (P4, bnajibmo).
// Each test checks one requirement from traceability/bnajibmo.md against
// many generated inputs, not only the single example from P3.
// The harness and generators live in walkthrough.harness.ts.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import path from "path"
import {
  arbEdit,
  arbEdits,
  arbPath,
  arbReads,
  arbText,
  dir,
  entries,
  expected,
  harness,
  held,
  names,
} from "./walkthrough.harness"

fc.configureGlobal({ seed: 42 })

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
          // One prompt per request: after Cancel or dismiss the remaining
          // edits are blocked without asking again (P5 strengthening, H3).
          expect(h.prompts).toHaveLength(1)
          expect(h.options[0]).toEqual(["Continue", "Cancel"])
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
    // P5 strengthening: "swap" and "repeat" keep the list the same length as
    // the set of files read (H1, H2), and "missing" sends no list at all.
    const arbMutation = fc.constantFrom(
      "exact",
      "shuffled",
      "relative",
      "drop",
      "duplicate",
      "swap",
      "repeat",
      "missing",
    )
    await fc.assert(
      fc.asyncProperty(arbReads, arbEdit, arbMutation, fc.nat(), async (reads, tool, mutation, seed) => {
        const files = expected(reads)
        const pick = files.length ? seed % files.length : 0
        const unread = names.map((n) => path.resolve(dir, n)).filter((p) => !files.includes(p))
        const candidate = {
          exact: files,
          shuffled: [...files.slice(pick), ...files.slice(0, pick)],
          relative: files,
          drop: files.filter((_, i) => i !== pick),
          duplicate: files.length ? [...files, files[pick]] : files,
          swap:
            files.length && unread.length
              ? files.map((p, i) => (i === pick ? unread[seed % unread.length] : p))
              : files,
          repeat: files.length > 1 ? files.map((p, i) => (i === pick ? files[(pick + 1) % files.length] : p)) : files,
          missing: files,
        }[mutation]
        const resolved = candidate.map((p) => path.resolve(dir, p))
        const accepts =
          mutation !== "missing" &&
          resolved.length === files.length &&
          new Set(resolved).size === resolved.length &&
          resolved.every((p) => files.includes(p))

        const h = harness(["Continue"])
        await h.read(reads)
        const list = entries(candidate, mutation === "relative")
        const result = await h.run(tool, mutation === "missing" ? {} : { walkthrough: list })
        expect(result).toBe(accepts ? "ran" : "refused")
        expect(h.prompts).toHaveLength(accepts ? 1 : 0)
        if (accepts) {
          const lines = h.prompts[0].split("\n")
          for (const e of list) expect(lines).toContain(`${e.path} — ${e.explanation}`)
        }
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
        // Typing a question is only possible if the prompt allows a custom answer.
        expect(h.customs).toEqual([true, true])
        expect(h.prompts[1]).toContain(`Your question: ${question}`)
        expect(h.prompts[1]).toContain(`Answer: ${answer}`)
        expect(h.order.indexOf(tool)).toBeGreaterThan(h.order.indexOf("prompt:Continue"))
      }),
    )
  })
})
