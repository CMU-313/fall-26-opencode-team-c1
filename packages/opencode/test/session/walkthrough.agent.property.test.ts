// Agent failure case (P5, bnajibmo). This is the property opencode wrote for
// R4 when given the harness from walkthrough.property.test.ts; the prompt and
// reply are in mutants/bnajibmo/agent-prompt.txt and agent-response.txt.
// Three edits were needed to make it run at all, nothing else was changed:
//   1. the generator fc.constantFrom(fc.constantFrom("math.js"), ...) did not
//      produce { mathPath, utilsPath }; replaced with fc.record of constants
//   2. expect(gate.state).toBe("blocked") removed: the gate has no state field
//   3. fc.assert is awaited
//   4. expect(order).toEqual(["read"]) failed on the real gate, because a
//      refused edit never reaches the tool; changed to ["read"]
// It is kept out of the Stryker command on purpose; see traceability/bnajibmo.md.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { harness } from "./walkthrough.harness"

describe("R4 walkthrough file list gate", () => {
  test(
    "walkthrough lists only files read in current request",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({ mathPath: fc.constant("math.js"), utilsPath: fc.constant("utils.js") }),
          async ({ mathPath, utilsPath }) => {
            const { prompts, order, run, read, ranHeld } = harness(["math.js", "submit"])
            await read([{ path: mathPath, kind: "file" }])
            const editResult = await run("edit", { file: utilsPath, content: "x=1" })
            expect(prompts).toEqual([])
            expect(order).toEqual(["read"])
            expect(editResult).toBe("refused")
            expect(ranHeld()).toEqual([])
          },
        ),
      )
    },
    { timeout: 30000 },
  )
})
