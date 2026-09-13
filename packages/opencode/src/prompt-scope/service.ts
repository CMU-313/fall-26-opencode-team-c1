import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { generateText } from "ai"
import { Context, Effect, Layer } from "effect"
import { Provider } from "@/provider/provider"
import {
  buildPromptScopeClassifierPrompt,
  parsePromptScopeClassification,
  type PromptScopeClassification,
} from "./classifier"

export const PROMPT_SCOPE_CLASSIFIER_TIMEOUT_MS = 2_000

export type PromptScopeClassifierInput<Model> = {
  getSmallModel: () => Promise<Model | undefined>
  generate: (input: { model: Model; prompt: string; signal: AbortSignal }) => Promise<string>
  timeoutMs?: number
}

export async function classifyPromptScope<Model>(text: string, input: PromptScopeClassifierInput<Model>) {
  const model = await input.getSmallModel().catch(() => undefined)
  if (!model) return

  try {
    const result = await input.generate({
      model,
      prompt: buildPromptScopeClassifierPrompt(text),
      signal: AbortSignal.timeout(input.timeoutMs ?? PROMPT_SCOPE_CLASSIFIER_TIMEOUT_MS),
    })
    return parsePromptScopeClassification(result)
  } catch {
    return
  }
}

export interface Interface {
  readonly classify: (text: string) => Effect.Effect<PromptScopeClassification | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PromptScopeClassifier") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service

    return {
      classify: (text) =>
        Effect.promise(() =>
          classifyPromptScope(text, {
            getSmallModel: () => Effect.runPromise(provider.getSmallModel(ProviderV2.ID.opencode)),
            generate: async (input) => {
              const language = await Effect.runPromise(provider.getLanguage(input.model))
              const result = await generateText({
                model: language,
                prompt: input.prompt,
                abortSignal: input.signal,
              })
              return result.text
            },
          }),
        ),
    }
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Provider.node],
})
