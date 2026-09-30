export * as SessionWalkthrough from "./walkthrough"

import path from "path"
import { asSchema, jsonSchema, type Tool } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Option, Schema } from "effect"
import { Walkthrough } from "@opencode-ai/core/session/runner/walkthrough"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "@/question"
import type { MessageID, SessionID } from "./schema"

const edits = ["edit", "write", "apply_patch"]
const properties = {
  walkthrough: {
    type: "array",
    items: {
      type: "object",
      properties: { path: { type: "string" }, explanation: { type: "string" } },
      required: ["path", "explanation"],
    },
  },
  walkthrough_answer: { type: "string" },
} satisfies Record<string, JSONSchema7>

export function make(directory: string, question: Question.Interface) {
  const files = new Set<string>()
  let user: MessageID | undefined
  let approved = false
  let cancelled = false
  let followup: string | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const serial = <T>(task: () => Promise<T>) => {
    const next = queue.then(task)
    queue = next.catch(() => undefined)
    return next
  }

  return Effect.fn("SessionWalkthrough.apply")(function* (
    tools: Record<string, Tool>,
    input: { user: MessageID; sessionID: SessionID; messageID: MessageID },
  ) {
    if (input.user !== user) {
      user = input.user
      files.clear()
      approved = false
      cancelled = false
      followup = undefined
    }
    const run = yield* EffectBridge.make()

    const review = async (args: unknown, callID: string) => {
      const details = Option.getOrUndefined(Schema.decodeUnknownOption(Walkthrough.Input)(args))
      if (!details || !matches(details.walkthrough) || (followup && !details.walkthrough_answer))
        throw new Error(
          `No edit was made. Retry with walkthrough: [{path, explanation}], one entry per successfully read file, explaining its role and relevance to this change. Files: ${JSON.stringify([...files])}.${followup ? ` Include walkthrough_answer answering: ${followup}` : ""}`,
        )
      const answers = await run
        .promise(
          question.ask({
            sessionID: input.sessionID,
            tool: { messageID: input.messageID, callID },
            questions: [ask(details)],
          }),
        )
        .catch((error) => {
          cancelled = true
          throw error
        })
      const answer = answers[0]?.[0]
      if (!answer || answer === "Cancel") {
        cancelled = true
        throw new Question.RejectedError()
      }
      if (answer === "Continue") {
        approved = true
        return
      }
      followup = answer
      throw new Error(
        `No edit was made. The student asks: ${answer}\nRetry the edit with walkthrough_answer containing your answer and the complete walkthrough again. Do not edit through another tool.`,
      )
    }

    const read = tools.read
    const execute = read?.execute
    if (read && execute)
      tools.read = {
        ...read,
        execute: (args, options) =>
          serial(async () => {
            const result = await execute(args, options)
            if (result?.metadata?.display?.type === "file") files.add(path.resolve(directory, args.filePath))
            return result
          }),
      }

    for (const id of edits) {
      const item = tools[id]
      const edit = item?.execute
      if (!item || !edit) continue
      const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
      tools[id] = {
        ...item,
        inputSchema: approved
          ? item.inputSchema
          : jsonSchema({ ...schema, properties: { ...schema.properties, ...properties } }),
        execute: (args, options) =>
          serial(async () => {
            if (cancelled) throw new Question.RejectedError()
            if (!approved) await review(args, options.toolCallId)
            return edit(clean(args), options)
          }),
      }
    }
  })

  function matches(walkthrough: typeof Walkthrough.Input.Type.walkthrough) {
    const listed = walkthrough.map((file) => path.resolve(directory, file.path))
    return (
      listed.length === files.size && new Set(listed).size === files.size && listed.every((file) => files.has(file))
    )
  }

  function ask(details: typeof Walkthrough.Input.Type): Question.Info {
    const text = details.walkthrough.length
      ? details.walkthrough
          .map((file) => `${path.relative(directory, path.resolve(directory, file.path))} — ${file.explanation}`)
          .join("\n")
      : "No files have been read in this request."
    return {
      header: "Codebase walkthrough",
      question: `Codebase walkthrough\n\n${text}${followup ? `\n\nYour question: ${followup}\nAnswer: ${details.walkthrough_answer}` : ""}\n\nContinue with the edit, cancel, or type a question about a file.`,
      options: [
        { label: "Continue", description: "Allow edits for this request" },
        { label: "Cancel", description: "End this request without editing" },
      ],
      custom: true,
    }
  }
}

function clean(args: unknown) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args
  return Object.fromEntries(Object.entries(args).filter(([key]) => !(key in properties)))
}
