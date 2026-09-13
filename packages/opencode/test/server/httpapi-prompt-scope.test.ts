import { describe, expect } from "bun:test"
import { Context, Effect } from "effect"
import { PromptScopePaths } from "../../src/server/routes/instance/httpapi/groups/prompt-scope"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { TestInstance } from "../fixture/fixture"
import { it } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(handler: ReturnType<typeof HttpApiApp.webHandler>, directory: string, init: RequestInit) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${PromptScopePaths.classify}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
}

describe("prompt scope HttpApi", () => {
  it.instance(
    "validates payloads and maps unavailable classification to 503",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const invalid = yield* request(handler, test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(invalid.status).toBe(400)

        const unavailable = yield* request(handler, test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Help with my project" }),
        })
        expect(unavailable.status).toBe(503)
        expect(yield* Effect.promise(() => unavailable.json())).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Prompt scope classification is unavailable",
          service: "prompt-scope.classify",
        })
      }),
    { config: { enabled_providers: [] } },
  )
})
