export type PromptScopeInput = {
  text: string
  mode?: "shell"
}

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

const broadPatterns = [
  /\bdo\s+(?:my|this|the)\s+(?:whole|entire)\s+(?:assignment|project|homework)\b/,
  /\b(?:complete|finish)\s+(?:my|this|the)\s+(?:whole|entire)\s+(?:assignment|project|homework)\b/,
  /\b(?:build|make|create)\s+(?:(?:my|this|the|a)\s+)?(?:whole|entire|full)\s+(?:app|application|project|website|site)\b/,
  /\bimplement\s+(?:my|this|the)\s+(?:whole|entire)\s+(?:assignment|project)\b/,
]

export function isUnmistakablyBroadPrompt(input: PromptScopeInput) {
  if (input.mode === "shell") return false

  const text = input.text.trim().toLowerCase().replace(/\s+/g, " ")
  if (!text || text.startsWith("/")) return false

  return broadPatterns.some((pattern) => pattern.test(text))
}

export function learningPromptSuggestion(text: string) {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ")
  if (/\b(?:assignment|homework)\b/.test(normalized)) {
    return "Help me understand the assignment requirements and identify the first small step I should take. Give one hint, but do not implement it."
  }

  return "Help me break this project into the first small step. Explain what I should inspect or build first and give one hint, but do not implement it."
}

export function learningScopeNudge(result: PromptScopeClassification | undefined) {
  if (result?.classification !== "broad") return
  if (!Number.isFinite(result.confidence) || result.confidence < 0.8) return

  const suggestion = result.suggestion.trim()
  if (!suggestion) return
  return suggestion
}
