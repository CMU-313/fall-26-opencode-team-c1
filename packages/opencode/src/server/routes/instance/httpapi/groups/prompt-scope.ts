import { PromptScopeClassification } from "@/prompt-scope/classifier"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/prompt-scope"

export const PromptScopeClassifyPayload = Schema.Struct({
  text: Schema.String,
})

export const PromptScopePaths = {
  classify: `${root}/classify`,
} as const

export const PromptScopeApi = HttpApi.make("prompt-scope")
  .add(
    HttpApiGroup.make("promptScope")
      .add(
        HttpApiEndpoint.post("classify", PromptScopePaths.classify, {
          query: WorkspaceRoutingQuery,
          payload: PromptScopeClassifyPayload,
          success: described(PromptScopeClassification, "Prompt scope classification"),
          error: ServiceUnavailableError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "promptScope.classify",
            summary: "Classify prompt scope",
            description:
              "Classify an ambiguous learning prompt with an OpenCode small model. This endpoint does not create sessions or execute agents.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "prompt scope",
          description: "Learning-oriented prompt scope classification.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
