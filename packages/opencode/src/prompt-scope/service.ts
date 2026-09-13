import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { generateText } from "ai"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
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

export type PromptScopeClassificationUnavailableReason =
  | "no_model"
  | "model_resolution_failed"
  | "timeout"
  | "generation_failed"
  | "invalid_response"

export type PromptScopeClassificationAttempt =
  | { type: "classified"; classification: PromptScopeClassification }
  | { type: "unavailable"; reason: PromptScopeClassificationUnavailableReason }

export async function classifyPromptScope<Model>(
  text: string,
  input: PromptScopeClassifierInput<Model>,
): Promise<PromptScopeClassificationAttempt> {
  const resolved = await input.getSmallModel().then(
    (model) => ({ type: "resolved" as const, model }),
    () => ({ type: "unavailable" as const, reason: "model_resolution_failed" as const }),
  )
  if (resolved.type === "unavailable") return resolved
  if (!resolved.model) return { type: "unavailable", reason: "no_model" }

  const signal = AbortSignal.timeout(input.timeoutMs ?? PROMPT_SCOPE_CLASSIFIER_TIMEOUT_MS)
  const generated = await input
    .generate({
      model: resolved.model,
      prompt: buildPromptScopeClassifierPrompt(text),
      signal,
    })
    .then(
      (text) => ({ type: "generated" as const, text }),
      () => ({ type: "unavailable" as const, reason: signal.aborted ? "timeout" : ("generation_failed" as const) }),
    )
  if (generated.type === "unavailable") return generated

  const classification = parsePromptScopeClassification(generated.text)
  if (!classification) return { type: "unavailable", reason: "invalid_response" }
  return { type: "classified", classification }
}

export interface Interface {
  readonly classify: (text: string) => Effect.Effect<PromptScopeClassificationAttempt>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PromptScopeClassifier") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service

    return {
      classify: (text) =>
        Effect.gen(function* () {
          const selected = yield* provider.getSmallModel(ProviderV2.ID.opencode).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.flatMap((small) => {
              if (small) return Effect.succeed(small)
              return provider
                .defaultModel()
                .pipe(Effect.flatMap((model) => provider.getModel(model.providerID, model.modelID)))
            }),
            Effect.map((model) => ({ type: "resolved" as const, model })),
            Effect.catch(() => Effect.succeed({ type: "unavailable" as const })),
          )
          if (selected.type === "unavailable") {
            return { type: "unavailable" as const, reason: "model_resolution_failed" as const }
          }

          const language = yield* provider.getLanguage(selected.model).pipe(
            Effect.map((model) => ({ type: "resolved" as const, model })),
            Effect.catch(() => Effect.succeed({ type: "unavailable" as const })),
          )
          if (language.type === "unavailable") {
            return { type: "unavailable" as const, reason: "model_resolution_failed" as const }
          }

          const instance = yield* InstanceState.context
          const headers = selected.model.providerID.startsWith("opencode")
            ? {
                "x-opencode-project": instance.project.id,
                "x-opencode-session": SessionID.create(),
                "x-opencode-request": MessageID.ascending(),
                "x-opencode-client": "prompt-scope",
                "User-Agent": `opencode/${InstallationVersion}`,
              }
            : undefined
          return yield* Effect.promise(() =>
            classifyPromptScope(text, {
              getSmallModel: async () => language.model,
              generate: async (input) => {
                const result = await generateText({
                  model: input.model,
                  prompt: input.prompt,
                  abortSignal: input.signal,
                  headers,
                })
                return result.text
              },
            }),
          )
        }),
    }
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Provider.node],
})
