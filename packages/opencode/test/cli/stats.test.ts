import { expect, it } from "bun:test"
import { assert, integer, property } from "fast-check"
import { aggregateSessionStatsInputs, rankModels } from "../../src/cli/cmd/stats"
import type { SessionStats, SessionStatsInput } from "../../src/cli/cmd/stats"
import {
  modelUsageArbitrary,
  nonEmptySessionStatsInputsArbitrary,
  sessionStatsInputsArbitrary,
} from "./stats.generator"

function aggregateReference(inputs: SessionStatsInput[]) {
  return inputs.reduce(
    (totals, input) => ({
      totalSessions: totals.totalSessions + 1,
      totalMessages: totals.totalMessages + input.messageCount,
      totalCost: totals.totalCost + input.sessionCost,
      totalTokens: {
        input: totals.totalTokens.input + input.sessionTokens.input,
        output: totals.totalTokens.output + input.sessionTokens.output,
        reasoning: totals.totalTokens.reasoning + input.sessionTokens.reasoning,
        cache: {
          read: totals.totalTokens.cache.read + input.sessionTokens.cache.read,
          write: totals.totalTokens.cache.write + input.sessionTokens.cache.write,
        },
      },
    }),
    {
      totalSessions: 0,
      totalMessages: 0,
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  )
}

function displayedAggregateFields(stats: SessionStats) {
  return {
    totalSessions: stats.totalSessions,
    totalMessages: stats.totalMessages,
    days: stats.days,
    activeDays: stats.activeDays,
    totalCost: stats.totalCost,
    costPerDay: stats.costPerDay,
    tokensPerSession: stats.tokensPerSession,
    medianTokensPerSession: stats.medianTokensPerSession,
    totalTokens: stats.totalTokens,
  }
}

function activeDaysReference(inputs: SessionStatsInput[]) {
  return new Set(
    inputs.flatMap((input) =>
      input.activityTimes.map((time) => {
        const date = new Date(time)
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
      }),
    ),
  ).size
}

// R2 — Increasing the number of displayed models must preserve the existing ranking and stats of previously displayed models.
it("changing the model limit from 3 to 5 and back to 3 reproduces the original records", () => {
  console.log("PBT R2: model display limit round-trip")
  assert(
    property(modelUsageArbitrary, (modelUsage) => {
      const original = rankModels(modelUsage, 3)
      const expanded = rankModels(modelUsage, 5)
      expect(expanded.slice(0, 3)).toEqual(original)
      expect(rankModels(modelUsage, 3)).toEqual(original)
    }),
  )
})

// R3 — Changing the models displayed should not change the overall aggregated stats.
it("model limits leave all overview, cost, and token fields unchanged", () => {
  console.log("PBT R3: aggregate statistics invariant across model limits")
  assert(
    property(
      sessionStatsInputsArbitrary,
      modelUsageArbitrary,
      integer({ min: 0, max: 20 }),
      integer({ min: 0, max: 20 }),
      (inputs, modelUsage, firstLimit, secondLimit) => {
        const stats = aggregateSessionStatsInputs(inputs)
        stats.modelUsage = modelUsage
        const expected = displayedAggregateFields(stats)
        const firstReport = {
          aggregate: displayedAggregateFields(stats),
          models: rankModels(stats.modelUsage, firstLimit),
        }
        const secondReport = {
          aggregate: displayedAggregateFields(stats),
          models: rankModels(stats.modelUsage, secondLimit),
        }
        expect(firstReport.aggregate).toEqual(expected)
        expect(secondReport.aggregate).toEqual(expected)
      },
    ),
  )
})

// R5 — The stats feature must accurately report the total token usage and total cost stats.
it("aggregation agrees field-for-field with a sequential reference implementation", () => {
  console.log("PBT R5: aggregate statistics match the reference oracle")
  assert(
    property(sessionStatsInputsArbitrary, (inputs) => {
      const actual = aggregateSessionStatsInputs(inputs)
      const expected = aggregateReference(inputs)

      expect(actual.totalSessions).toBe(expected.totalSessions)
      expect(actual.totalMessages).toBe(expected.totalMessages)
      expect(actual.totalCost).toBeCloseTo(expected.totalCost, 10)
      expect(actual.totalTokens).toEqual(expected.totalTokens)
    }),
  )
})

// R6 — The stats feature must distinguish between the number of days OpenCode has been used and the number of days since the user started using it.
it("adding another message on an already active day does not change the number of active days", () => {
  console.log("PBT R6: same-day messages preserve active-day count")
  assert(
    property(nonEmptySessionStatsInputsArbitrary, (inputs) => {
      const before = aggregateSessionStatsInputs(inputs)
      const changedInputs = [
        {
          ...inputs[0],
          messageCount: inputs[0].messageCount + 1,
          activityTimes: [...inputs[0].activityTimes, inputs[0].activityTimes[0]],
        },
        ...inputs.slice(1),
      ]
      const after = aggregateSessionStatsInputs(changedInputs)

      expect(before.activeDays).toBe(activeDaysReference(inputs))
      expect(after.activeDays).toBe(activeDaysReference(changedInputs))
      expect(after.activeDays).toBe(before.activeDays)
      expect(after.totalMessages).toBe(before.totalMessages + 1)
    }),
  )
})
