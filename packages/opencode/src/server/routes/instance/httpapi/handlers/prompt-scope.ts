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
      if (result) return result
      return yield* new ServiceUnavailableError({
        message: "Prompt scope classification is unavailable",
        service: "prompt-scope.classify",
      })
    })

    return handlers.handle("classify", classify)
  }),
)
