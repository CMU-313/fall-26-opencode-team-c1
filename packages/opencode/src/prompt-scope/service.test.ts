import { describe, expect, test } from "bun:test"
import { classifyPromptScope } from "./service"

describe("classifyPromptScope", () => {
  test("uses the resolved small model and returns a valid broad result", async () => {
    const result = await classifyPromptScope("Can you build my whole capstone?", {
      getSmallModel: async () => "opencode-small",
      generate: async (input) => {
        expect(input.model).toBe("opencode-small")
        expect(input.prompt).toContain("Can you build my whole capstone?")
        expect(input.signal.aborted).toBe(false)
        return '{"classification":"broad","confidence":0.91,"suggestion":"Help me identify the first requirement."}'
      },
    })

    expect(result).toEqual({
      classification: "broad",
      confidence: 0.91,
      suggestion: "Help me identify the first requirement.",
    })
  })

  test("returns a valid bounded result", async () => {
    const result = await classifyPromptScope("Explain this function", {
      getSmallModel: async () => "opencode-small",
      generate: async () => '{"classification":"not_broad","confidence":0.88}',
    })

    expect(result).toEqual({ classification: "not_broad", confidence: 0.88 })
  })

  test("returns unavailable when no small model is available", async () => {
    let generated = false
    const result = await classifyPromptScope("Help with my project", {
      getSmallModel: async () => undefined,
      generate: async () => {
        generated = true
        return ""
      },
    })

    expect(result).toBeUndefined()
    expect(generated).toBe(false)
  })

  test("returns unavailable when model resolution or generation fails", async () => {
    const resolutionFailure = await classifyPromptScope("Help with my project", {
      getSmallModel: async () => {
        throw new Error("provider unavailable")
      },
      generate: async () => "",
    })
    const generationFailure = await classifyPromptScope("Help with my project", {
      getSmallModel: async () => "opencode-small",
      generate: async () => {
        throw new Error("provider unavailable")
      },
    })

    expect(resolutionFailure).toBeUndefined()
    expect(generationFailure).toBeUndefined()
  })

  test("returns unavailable when the model output is invalid", async () => {
    const result = await classifyPromptScope("Help with my project", {
      getSmallModel: async () => "opencode-small",
      generate: async () => "This request is broad.",
    })

    expect(result).toBeUndefined()
  })

  test("returns unavailable when generation exceeds the timeout", async () => {
    const result = await classifyPromptScope("Help with my project", {
      timeoutMs: 10,
      getSmallModel: async () => "opencode-small",
      generate: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason))
        }),
    })

    expect(result).toBeUndefined()
  })
})
