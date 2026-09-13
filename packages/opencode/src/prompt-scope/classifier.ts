export type PromptScopeClassification =
  | {
      classification: "broad"
      confidence: number
      suggestion: string
    }
  | {
      classification: "not_broad"
      confidence: number
    }

export function buildPromptScopeClassifierPrompt(text: string) {
  return [
    "Classify whether a student's software-engineering request is too broad for a learning-oriented AI assistant.",
    "Return only one JSON object. Do not use Markdown or add explanation.",
    'Use {"classification":"broad","confidence":number,"suggestion":string} for broad requests.',
    'Use {"classification":"not_broad","confidence":number} for bounded or ambiguous requests.',
    "Confidence must be a number from 0 to 1. A broad suggestion must help the student take one small step and must not implement the work.",
    "",
    "Examples:",
    'Input: "do my whole assignment"',
    'Output: {"classification":"broad","confidence":0.98,"suggestion":"Help me identify the first requirement and explain one small step I can take without implementing it."}',
    'Input: "add validation to the login form"',
    'Output: {"classification":"not_broad","confidence":0.96}',
    'Input: "help with my project"',
    'Output: {"classification":"not_broad","confidence":0.55}',
    "",
    `Input: ${JSON.stringify(text)}`,
    "Output:",
  ].join("\n")
}

export function parsePromptScopeClassification(input: string): PromptScopeClassification | undefined {
  try {
    const value: unknown = JSON.parse(input)
    if (!isRecord(value)) return
    if (!isConfidence(value.confidence)) return

    if (value.classification === "broad") {
      if (!hasExactKeys(value, ["classification", "confidence", "suggestion"])) return
      if (typeof value.suggestion !== "string" || !value.suggestion.trim()) return
      return {
        classification: "broad",
        confidence: value.confidence,
        suggestion: value.suggestion,
      }
    }

    if (value.classification !== "not_broad") return
    if (!hasExactKeys(value, ["classification", "confidence"])) return
    return {
      classification: "not_broad",
      confidence: value.confidence,
    }
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => key in value)
}
