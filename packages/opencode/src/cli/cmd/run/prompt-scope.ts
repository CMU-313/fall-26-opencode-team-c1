export type PromptScopeInput = {
  text: string
  mode?: "shell"
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
