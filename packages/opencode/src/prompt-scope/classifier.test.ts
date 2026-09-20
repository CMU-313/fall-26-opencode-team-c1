import { describe, expect, test } from "bun:test"
import { buildPromptScopeClassifierPrompt, parsePromptScopeClassification } from "./classifier"

describe("parsePromptScopeClassification", () => {
  test.each([
    [
      '{"classification":"broad","confidence":0.93,"suggestion":"Help me identify the first requirement."}',
      {
        classification: "broad",
        confidence: 0.93,
        suggestion: "Help me identify the first requirement.",
      },
    ],
    [
      '{"classification":"not_broad","confidence":0.55}',
      {
        classification: "not_broad",
        confidence: 0.55,
      },
    ],
  ] as const)("parses a valid result: %s", (input, expected) => {
    expect(parsePromptScopeClassification(input)).toEqual(expected)
  })

  test.each([
    "",
    "not json",
    "Here is the result: {\"classification\":\"not_broad\",\"confidence\":0.8}",
    "[]",
    '{"classification":"unknown","confidence":0.8}',
    '{"classification":"broad","confidence":0.8}',
    '{"classification":"broad","confidence":0.8,"suggestion":"   "}',
    '{"classification":"not_broad","confidence":"high"}',
    '{"classification":"not_broad","confidence":-0.01}',
    '{"classification":"not_broad","confidence":1.01}',
    '{"classification":"not_broad","confidence":null}',
    '{"classification":"not_broad","confidence":0.8,"suggestion":"not allowed"}',
    '{"classification":"broad","confidence":0.8,"suggestion":"Help me start.","extra":true}',
  ])("rejects an invalid result: %s", (input) => {
    expect(parsePromptScopeClassification(input)).toBeUndefined()
  })
})

describe("buildPromptScopeClassifierPrompt", () => {
  test("requests exact JSON with broad, bounded, and ambiguous examples", () => {
    const prompt = buildPromptScopeClassifierPrompt("Can you build my capstone?")

    expect(prompt).toContain("Return only one JSON object")
    expect(prompt).toContain('"classification":"broad"')
    expect(prompt).toContain('"classification":"not_broad"')
    expect(prompt).toContain("do my whole assignment")
    expect(prompt).toContain("add validation to the login form")
    expect(prompt).toContain("help with my project")
    expect(prompt).toContain(
      'Input: "Can you implement the feature defined in the README?"\nOutput: {"classification":"broad","confidence":0.85',
    )
    expect(prompt).toContain(
      'Input: "Build the entire app described in the README."\nOutput: {"classification":"broad","confidence":0.98',
    )
    expect(prompt).toContain(
      'Input: "Help me implement the first acceptance criterion in the README."\nOutput: {"classification":"not_broad","confidence":0.90}',
    )
    expect(prompt).toContain(
      'Input: "Add the input validation described in the README."\nOutput: {"classification":"not_broad","confidence":0.92}',
    )
    expect(prompt).toContain('Input: "Can you build my capstone?"')
  })

  test("serializes input as JSON", () => {
    const prompt = buildPromptScopeClassifierPrompt('Explain "generics"\nwithout writing code')

    expect(prompt).toContain('Input: "Explain \\"generics\\"\\nwithout writing code"')
  })
})
