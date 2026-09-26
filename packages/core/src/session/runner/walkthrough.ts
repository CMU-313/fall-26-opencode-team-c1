export * as Walkthrough from "./walkthrough"

import path from "path"
import { ToolDefinition } from "@opencode-ai/llm"
import { Effect, Option, Schema, Semaphore } from "effect"
import { QuestionV2 } from "../../question"
import type { ToolRegistry } from "../../tool/registry"

const edits = new Set(["edit", "write", "apply_patch"])
const line = Schema.String.check(Schema.isPattern(/^[^\r\n]*\S[^\r\n]*$/))
const Input = Schema.Struct({
  walkthrough: Schema.Array(Schema.Struct({ path: line, explanation: line })),
  walkthrough_answer: line.pipe(Schema.optional),
})
const properties = Schema.toJsonSchemaDocument(Input).schema.properties

export function make(directory: string, question: Pick<QuestionV2.Interface, "ask">) {
  const files = new Set<string>()
  const serial = Semaphore.makeUnsafe(1)
  let approved = false
  let cancelled = false
  let followup: string | undefined

  const reset = () => {
    files.clear()
    approved = false
    cancelled = false
    followup = undefined
  }
  const definitions = (tools: ReadonlyArray<ToolDefinition>) =>
    tools.map((tool) =>
      !edits.has(tool.name) || approved
        ? tool
        : new ToolDefinition({
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...(tool.inputSchema.properties as Record<string, unknown>),
                ...(properties as Record<string, unknown>),
              },
            },
          }),
    )

  const settle = (
    input: ToolRegistry.ExecuteInput,
    execute: ToolRegistry.Materialization["settle"],
  ): ReturnType<ToolRegistry.Materialization["settle"]> =>
    serial.withPermit(
      Effect.gen(function* () {
        if (cancelled) return yield* Effect.die(new QuestionV2.RejectedError())
        if (edits.has(input.call.name) && !approved) {
          const decoded = Schema.decodeUnknownOption(Input)(input.call.input)
          const details = Option.getOrUndefined(decoded)
          const listed = details?.walkthrough.map((file) => path.resolve(directory, file.path)) ?? []
          if (
            !details ||
            listed.length !== files.size ||
            new Set(listed).size !== files.size ||
            listed.some((file) => !files.has(file)) ||
            (followup && !details.walkthrough_answer)
          )
            return {
              result: {
                type: "error",
                value: `No edit was made. Retry with walkthrough: [{path, explanation}], one entry per successfully read file, explaining its role and relevance to this change. Files: ${JSON.stringify([...files])}.${followup ? ` Include walkthrough_answer answering: ${followup}` : ""}`,
              },
            }
          const text = details.walkthrough.length
            ? details.walkthrough.map((file) => `${file.path} — ${file.explanation}`).join("\n")
            : "No files have been read in this request."
          const answers = yield* question
            .ask({
              sessionID: input.sessionID,
              tool: { messageID: input.assistantMessageID, callID: input.call.id },
              questions: [
                {
                  header: "Codebase walkthrough",
                  question: `${text}${followup ? `\n\nYour question: ${followup}\nAnswer: ${details.walkthrough_answer}` : ""}\n\nContinue with the edit, cancel, or type a question about a file.`,
                  options: [
                    { label: "Continue", description: "Allow edits for this request" },
                    { label: "Cancel", description: "End this request without editing" },
                  ],
                  custom: true,
                },
              ],
            })
            .pipe(
              Effect.tapError(() => Effect.sync(() => (cancelled = true))),
              Effect.orDie,
            )
          const answer = answers[0]?.[0]
          if (!answer || answer === "Cancel") {
            cancelled = true
            return yield* Effect.die(new QuestionV2.RejectedError())
          }
          if (answer !== "Continue") {
            followup = answer
            return {
              result: {
                type: "error",
                value: `No edit was made. The student asks: ${answer}\nRetry the edit with walkthrough_answer containing your answer and the complete walkthrough again. Do not edit through another tool.`,
              },
            }
          }
          approved = true
        }
        // Walkthrough fields belong to the runner, not the underlying editing tool.
        const call = input.call.input
        const clean =
          edits.has(input.call.name) && typeof call === "object" && call !== null && !Array.isArray(call)
            ? Object.fromEntries(
                Object.entries(call).filter(([key]) => !["walkthrough", "walkthrough_answer"].includes(key)),
              )
            : call
        const result = yield* execute({ ...input, call: { ...input.call, input: clean } })
        const output = result.output?.structured
        if (
          input.call.name === "read" &&
          result.result.type !== "error" &&
          typeof call === "object" &&
          call !== null &&
          "path" in call &&
          typeof call.path === "string" &&
          typeof output === "object" &&
          output !== null &&
          "content" in output
        )
          files.add(path.resolve(directory, call.path))
        return result
      }),
    )

  return { reset, definitions, settle }
}

export type State = ReturnType<typeof make>
