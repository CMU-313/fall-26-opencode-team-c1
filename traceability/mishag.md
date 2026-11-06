# Traceability: mishag

**Target feature:** Aggregation Statistics

Source Files:
- packages/opencode/src/cli/cmd/stats.ts
- packages/opencode/src/index.ts
- packages/opencode/src/session/session.ts
- packages/opencode/src/project/project.ts
- packages/opencode/src/cli/effect-cmd.ts
- packages/core/src/session/sql.ts

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | C-12: “even though I deleted the session, I still sent that message, so that can't really be undone”<br>S-6: ”...you still, like, actively send a message and use the model. Um, maybe they're gonna be like separate, like, deleted, like, sessions or something, but, like, to me, like, these numbers should always be there.”<br>O-6: “the same stats that we saw before we deleted the session” | Deleting a session doesn’t remove historical token usage, cost, session count, and message cost from the stats. | The token usage, cost, session count, and message count remain the same in the statistics after deleting a session with at least one message sent. | No | | |
| R2 | S-8: “Well, the top 3 of the top 5 should be the same as the top 3, um, like just looking at the top 3. I guess for the top 5, you also have the 4th one and the 5th one<br>O-9: “I'm assuming, the first three outputted for the list of five will be the same as the ones that were listed for the list of three” | Increasing the number of displayed models must preserve the existing ranking and stats of previously displayed models. | Having used at least 5 distinct models, running the stats with –models 3 and –models 5 should produce the same top three models with the same stats. | No | Round-trip | Changing the model limit from 3 to 5 and back to 3 reproduces the original 3 displayed records exactly. |
| R3 | S-10: “your usage across, like, all models, so that should always, like, stay the same”<br>O-10: “No [the overview values should not change]” | Changing the models displayed should not change the overall aggregated stats. | Having used at least 5 distinct models, running the stats with the models flag set to 3 and the models flag set to 5 should produce the session counts, message counts, and overall token counts. | No | invariant | For any two model limits, all overview cost and token fields are identical. |
| R4 | C-10: “I would say every message, though, because who knows how many tokens I'm using with one message”<br>S-4: “[the stats should update] after every message.”<br>O-3: “[the stats should update] after every message.” | The statistics feature must record newly sent messages and their associated token usage and cost before closing the session. | Given one terminal with a running session and another one with the latest stats, sending a message, and then getting the stats again on the 2nd terminal after receiving a reply, before closing the session should increment the message count, increase the token count, and increase the total cost. | No | | |
| R5 | C-8: “I would absolutely not want the number of tokens I've used to be incorrect in any way”<br>S-3: “I think the cost, like, affects the users the most”<br>O-3: “token usage slash cost” | The stats feature must accurately report the total token usage and total cost stats. | Given a session with two messages that used 100 tokens and 200 tokens, and cost $0.03 and $0.08, the total tokens should increase by 300 tokens and the total cost should increase by $0.11 as a result of this session. | No | oracle | For any generated collection of sessions containing nonnegative usage fields, the aggregator agrees field-for-field with a simple reference implementation that sums those fields sequentially. |
| R6 | C-8: “I would want to accurately know the number of days I've actually used the tool versus, like, how many days it's been since I started using it” | The stats feature must distinguish between the number of days OpenCode has been used and the number of days since the user started using it. | Given that the user starts using OpenCode and then goes back and uses it again 10 days later, with no usage in between, the number of days OpenCode has been used should be 2 days, but the number of days since the user started using it should be 10 days. | No | metamorphic | Adding another message on an already active day does not change the number of active days. |

Properties written or suggested by opencode or another AI tool: R2, R3, R5, R6

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|

I kept all of my original requirements because they can all be build as written without any changes. All of the requirements are feasible, non-conflicting, and can be checked. 