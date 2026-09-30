import { describe, expect, test } from "bun:test"
import { isUnmistakablyBroadPrompt, learningPromptSuggestion, learningScopeNudge } from "./scope"

describe("isUnmistakablyBroadPrompt", () => {
  test.each([
    "do my whole assignment",
    "Do My Entire Project",
    "do   my\nwhole\thomework",
    "complete this entire assignment",
    "finish the whole project",
    "build the full app",
    "make my entire website",
    "create a full application",
    "implement this entire assignment",
    "implement my whole project",
  ])("matches unmistakably broad prompts: %s", (text) => {
    expect(isUnmistakablyBroadPrompt({ text })).toBe(true)
  })

  test.each([
    "help me understand the assignment guidelines",
    "explain this function",
    "help me debug this test",
    "add validation to the login form",
    "build a login page",
    "help me plan my project",
    "complete the first TODO in this file",
    "finish this function",
    "implement the project parser",
    "create a website header",
    "",
    "   \n\t  ",
  ])("does not match bounded or empty prompts: %s", (text) => {
    expect(isUnmistakablyBroadPrompt({ text })).toBe(false)
  })

  test.each([
    "do my whole assignment",
    "complete this entire project",
    "build the full app",
    "implement the entire assignment",
  ])("does not match shell prompts: %s", (text) => {
    expect(isUnmistakablyBroadPrompt({ text, mode: "shell" })).toBe(false)
  })

  test.each([
    "/do my whole assignment",
    "  /complete this entire project",
    "/build the full app",
    "\n\t/implement the entire assignment",
  ])("does not match slash commands: %s", (text) => {
    expect(isUnmistakablyBroadPrompt({ text })).toBe(false)
  })

  test("suggests an assignment-focused learning prompt", () => {
    expect(learningPromptSuggestion("do my whole assignment")).toContain("assignment requirements")
  })

  test("suggests a project-focused learning prompt", () => {
    expect(learningPromptSuggestion("build the full app")).toContain("break this project")
  })

  test.each([
    [{ classification: "broad", confidence: 0.8, suggestion: "Start by reading the requirements." }, "Start by reading the requirements."],
    [{ classification: "broad", confidence: 0.99, suggestion: "  Plan the first step.  " }, "Plan the first step."],
    [{ classification: "broad", confidence: 0.79, suggestion: "Plan the first step." }, undefined],
    [{ classification: "not_broad", confidence: 1 }, undefined],
    [{ classification: "broad", confidence: Number.NaN, suggestion: "Plan the first step." }, undefined],
    [{ classification: "broad", confidence: 1, suggestion: "   " }, undefined],
  ] as const)("uses only high-confidence broad classifier results: %o", (result, expected) => {
    expect(learningScopeNudge(result)).toBe(expected)
  })
})
