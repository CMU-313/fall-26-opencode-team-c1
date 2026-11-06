import { array, constantFrom, integer, oneof, record, tuple, type Arbitrary } from "fast-check"
import type { SessionStats, SessionStatsInput } from "../../src/cli/cmd/stats"

// Generates counts biased toward zero, top-3/top-5 boundaries, ties, and a large maximum.
const countArbitrary = oneof(constantFrom(0, 1, 3, 5, 10_000), integer({ min: 0, max: 10_000 }))

// Generates nonnegative token counts biased toward zero, one, and the maximum.
const tokenArbitrary = oneof(constantFrom(0, 1, 1_000_000), integer({ min: 0, max: 1_000_000 }))

// Generates exact cent values biased toward zero, the interview examples, and the maximum.
const costInCentsArbitrary = oneof(constantFrom(0, 1, 3, 8, 1_000_000), integer({ min: 0, max: 1_000_000 }))

// Generates input, output, reasoning, and cache token usage independently.
const tokenUsageArbitrary = record({
  input: tokenArbitrary,
  output: tokenArbitrary,
  reasoning: tokenArbitrary,
  cache: record({
    read: tokenArbitrary,
    write: tokenArbitrary,
  }),
})

// Generates 5–20 distinct models with likely ranking ties and boundary usage values.
export const modelUsageArbitrary: Arbitrary<SessionStats["modelUsage"]> = array(
  record({
    messages: countArbitrary,
    tokens: record({
      input: tokenArbitrary,
      output: tokenArbitrary,
      cache: record({
        read: tokenArbitrary,
        write: tokenArbitrary,
      }),
    }),
    costInCents: costInCentsArbitrary,
  }),
  { minLength: 5, maxLength: 20 },
).map((models) =>
  Object.fromEntries(
    models.map((model, index) => [
      `provider-${index}/model-${index}`,
      {
        messages: model.messages,
        tokens: model.tokens,
        cost: model.costInCents / 100,
      },
    ]),
  ),
)

// Generates one summarized session with usage totals and day-aligned activity timestamps.
const sessionStatsInputArbitrary: Arbitrary<SessionStatsInput> = tuple(
  record({
    messageCount: countArbitrary,
    costInCents: costInCentsArbitrary,
    sessionTokens: tokenUsageArbitrary,
  }),
  tuple(
    oneof(
      constantFrom(0, 86_400_000, 864_000_000),
      integer({ min: 0, max: 18_518 }).map((day) => day * 86_400_000),
    ),
    oneof(constantFrom(0, 86_400_000, 864_000_000), integer({ min: 0, max: 31_536_000_000 })),
  ),
).map(([session, timestamps]) => ({
  messageCount: session.messageCount,
  sessionCost: session.costInCents / 100,
  sessionTokens: session.sessionTokens,
  sessionTotalTokens:
    session.sessionTokens.input +
    session.sessionTokens.output +
    session.sessionTokens.reasoning +
    session.sessionTokens.cache.read +
    session.sessionTokens.cache.write,
  sessionToolUsage: {},
  sessionModelUsage: {},
  activityTimes: [timestamps[0]],
  earliestTime: timestamps[0],
  latestTime: timestamps[0] + timestamps[1],
}))

// Generates zero to 50 sessions, including the empty-dataset boundary.
export const sessionStatsInputsArbitrary = array(sessionStatsInputArbitrary, { maxLength: 50 })

// Generates 1–50 sessions for properties that require an existing active day.
export const nonEmptySessionStatsInputsArbitrary = array(sessionStatsInputArbitrary, {
  minLength: 1,
  maxLength: 50,
})
