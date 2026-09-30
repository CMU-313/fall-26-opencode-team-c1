import { Service as PromptScopeClassifier } from "@/prompt-scope/service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ServiceUnavailableError } from "../errors"
import { PromptScopeClassifyPayload } from "../groups/prompt-scope"

export const promptScopeHandlers = HttpApiBuilder.group(InstanceHttpApi, "promptScope", (handlers) =>
  Effect.gen(function* () {
    const classifier = yield* PromptScopeClassifier

    const classify = Effect.fn("PromptScopeHttpApi.classify")(function* (ctx: {
      payload: typeof PromptScopeClassifyPayload.Type
    }) {
      const result = yield* classifier.classify(ctx.payload.text)
      if (result.type === "classified") {
        yield* Effect.logDebug("prompt scope classified", {
          classification: result.classification.classification,
          confidence: result.classification.confidence,
        })
        return result.classification
      }
      yield* Effect.logDebug("prompt scope classification unavailable", { reason: result.reason })
      return yield* new ServiceUnavailableError({
        message: "Prompt scope classification is unavailable",
        service: "prompt-scope.classify",
      })
    })

    return handlers.handle("classify", classify)
  }),
)
