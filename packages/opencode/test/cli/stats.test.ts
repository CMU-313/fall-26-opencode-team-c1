import { assert, configureGlobal, integer, property } from "fast-check"
configureGlobal({ seed: 42 })

import { expect, it, spyOn } from "bun:test"
import { aggregateSessionStatsInputs, displayStats, rankModels } from "../../src/cli/cmd/stats"
import type { SessionStats, SessionStatsInput } from "../../src/cli/cmd/stats"
import {
  modelUsageArbitrary,
  nonEmptySessionStatsInputsArbitrary,
  sessionStatsInputsArbitrary,
  windowDaysArbitrary,
} from "./stats.generator"

const MS_IN_DAY = 24 * 60 * 60 * 1000

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

function modelUsageReference(inputs: SessionStatsInput[]) {
  const result: SessionStats["modelUsage"] = {}
  for (const input of inputs) {
    for (const [model, usage] of Object.entries(input.sessionModelUsage)) {
      const current = result[model] ?? {
        messages: 0,
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      }
      result[model] = {
        messages: current.messages + usage.messages,
        tokens: {
          input: current.tokens.input + usage.tokens.input,
          output: current.tokens.output + usage.tokens.output,
          cache: {
            read: current.tokens.cache.read + usage.tokens.cache.read,
            write: current.tokens.cache.write + usage.tokens.cache.write,
          },
        },
        cost: current.cost + usage.cost,
      }
    }
  }
  return result
}

function aggregateReference(inputs: SessionStatsInput[], windowDays?: number) {
  const totals = inputs.reduce(
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
  if (inputs.length === 0) {
    return {
      ...totals,
      days: windowDays ?? 0,
      activeDays: 0,
      costPerDay: 0,
      tokensPerSession: 0,
      medianTokensPerSession: 0,
    }
  }

  const earliest = Math.min(...inputs.map((input) => input.earliestTime))
  const latest = Math.max(...inputs.map((input) => input.latestTime))
  const days = windowDays ?? Math.max(1, Math.ceil((latest - earliest) / MS_IN_DAY))
  const sessionTokens = inputs.map((input) => input.sessionTotalTokens).sort((first, second) => first - second)
  const middle = Math.floor(sessionTokens.length / 2)

  return {
    ...totals,
    dateRange: { earliest, latest },
    days,
    activeDays: activeDaysReference(inputs),
    costPerDay: totals.totalCost / days,
    tokensPerSession:
      (totals.totalTokens.input +
        totals.totalTokens.output +
        totals.totalTokens.reasoning +
        totals.totalTokens.cache.read +
        totals.totalTokens.cache.write) /
      inputs.length,
    medianTokensPerSession:
      sessionTokens.length % 2 === 0 ? (sessionTokens[middle - 1] + sessionTokens[middle]) / 2 : sessionTokens[middle],
  }
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

function displayedTotalCost(stats: SessionStats, modelLimit: number) {
  const output: string[] = []
  const log = spyOn(console, "log").mockImplementation((...values) => {
    output.push(values.map(String).join(" "))
  })
  const write = spyOn(process.stdout, "write").mockImplementation(() => true)

  try {
    displayStats(stats, undefined, modelLimit)
  } finally {
    log.mockRestore()
    write.mockRestore()
  }

  return output.find((line) => line.includes("Total Cost"))
}

// R2 — Increasing the number of displayed models must preserve the existing ranking and stats of previously displayed models.
it("aggregated model statistics agree with a sequential reference implementation", () => {
  console.log("PBT R2: aggregated model statistics match the reference oracle")
  assert(
    property(sessionStatsInputsArbitrary, (inputs) => {
      expect(aggregateSessionStatsInputs(inputs).modelUsage).toEqual(modelUsageReference(inputs))
    }),
  )
})

// R2 — Increasing the number of displayed models must preserve the existing ranking and stats of previously displayed models.
it("changing the model limit from 3 to 5 and back to 3 reproduces the original records", () => {
  console.log("PBT R2: model display limit round-trip")
  assert(
    property(modelUsageArbitrary, (modelUsage) => {
      const expected = Object.entries(modelUsage).sort(([modelA, usageA], [modelB, usageB]) => {
        const messages = usageB.messages - usageA.messages
        if (messages !== 0) return messages
        return modelA.localeCompare(modelB)
      })
      const original = rankModels(modelUsage, 3)
      const expanded = rankModels(modelUsage, 5)
      expect(rankModels(modelUsage, Infinity)).toEqual(expected)
      expect(original).toEqual(expected.slice(0, 3))
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
      windowDaysArbitrary,
      integer({ min: 0, max: 20 }),
      integer({ min: 0, max: 20 }),
      (inputs, modelUsage, windowDays, firstLimit, secondLimit) => {
        const stats = aggregateSessionStatsInputs(inputs, windowDays)
        stats.modelUsage = Object.fromEntries(
          Object.entries(modelUsage).map(([model, usage]) => [model, { ...usage, cost: usage.cost + 0.01 }]),
        )
        const expected = aggregateReference(inputs, windowDays)
        const firstReport = {
          aggregate: displayedAggregateFields(stats),
          models: rankModels(stats.modelUsage, firstLimit),
        }
        const secondReport = {
          aggregate: displayedAggregateFields(stats),
          models: rankModels(stats.modelUsage, secondLimit),
        }
        expect(firstReport.aggregate).toEqual(displayedAggregateFields({ ...stats, ...expected }))
        expect(secondReport.aggregate).toEqual(displayedAggregateFields({ ...stats, ...expected }))
        expect(displayedTotalCost(stats, 3)).toBe(displayedTotalCost(stats, 5))
      },
    ),
  )
})

// R5 — The stats feature must accurately report the total token usage and total cost stats.
it("aggregation agrees field-for-field with a sequential reference implementation", () => {
  console.log("PBT R5: aggregate statistics match the reference oracle")
  assert(
    property(sessionStatsInputsArbitrary, windowDaysArbitrary, (inputs, windowDays) => {
      const actual = aggregateSessionStatsInputs(inputs, windowDays)
      const expected = aggregateReference(inputs, windowDays)

      expect(actual.totalSessions).toBe(expected.totalSessions)
      expect(actual.totalMessages).toBe(expected.totalMessages)
      expect(actual.totalCost).toBeCloseTo(expected.totalCost, 10)
      expect(actual.totalTokens).toEqual(expected.totalTokens)
      expect(actual.days).toBe(expected.days)
      expect(actual.activeDays).toBe(expected.activeDays)
      expect(actual.costPerDay).toBeCloseTo(expected.costPerDay, 10)
      expect(actual.tokensPerSession).toBeCloseTo(expected.tokensPerSession, 10)
      expect(actual.medianTokensPerSession).toBeCloseTo(expected.medianTokensPerSession, 10)
      if (inputs.length > 0 && "dateRange" in expected) expect(actual.dateRange).toEqual(expected.dateRange)
    }),
  )
})

// R5 — The stats feature must accurately report the total token usage and total cost stats.
it("empty aggregates retain a well-formed date range for every reporting window", () => {
  console.log("PBT R5: empty aggregate date range remains well formed")
  assert(
    property(windowDaysArbitrary, (windowDays) => {
      const actual = aggregateSessionStatsInputs([], windowDays)

      expect(Number.isFinite(actual.dateRange.earliest)).toBe(true)
      expect(Number.isFinite(actual.dateRange.latest)).toBe(true)
      expect(actual.dateRange.earliest).toBeLessThanOrEqual(actual.dateRange.latest)
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
          activityTimes: [...inputs[0].activityTimes, inputs[0].activityTimes[0] + 60 * 60 * 1000],
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
