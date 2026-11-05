# Traceability - wliu4

Feature: the read tool (`packages/opencode/src/tool/read.ts`)

Tests: `packages/opencode/test/tool/read.property.test.ts`

Interview IDs (C-, S-, O-) are from my Project 3 workbook.

## Requirements

| ID | Interview evidence | Requirement | Acceptance criteria | Changed in P4? | Property | Test |
|---|---|---|---|---|---|---|
| R1 | C-2, S-2, O-2, O-3: "Even if you ask them to open they shouldn't open." | If the user's read rules deny a file, the read tool refuses it and returns none of its contents. The decision only depends on the rules and the file path, so a new session with the same rules denies it too. | For any path matching a deny rule, the rules return deny every time, and the read output contains none of the file. | Yes | | |
| R2 | O-3, C-3, S-2: "It should have the function to ask for permission." | By default, reading a .env file asks the user first, and the contents are only returned if the user approves. | Default config: reading .env asks first. Deny gives an error with no contents. Allow gives the contents. .env.example does not ask. | No | | |
| R3 | C-4, S-3, O-4: "if changed file to whatever it was the output should be the same" | If a file is changed and then restored, reading it again shows the same file content as the first read (same numbered lines and footer). | Read as A, edit one line, restore, read as B. The content part of A and B is identical. | Yes | | |
| R4 | C-5, S-4, O-5: "The second read should have the exact lines except for the newly edited lines." | Adding lines to the end of a file does not change the lines already shown. Only the new lines and the total change. | Read a 5-line file, add 3 lines, read again. Lines 1-5 are the same, lines 6-8 are new, total goes from 5 to 8. | No | | |
| R5 | O-6, S-5: "Hard to know when the workload is very large" | When a file is too long to show at once, the output says which lines were shown and how to get the rest. | A 2500-line file shows lines 1-2000 and says "Use offset=2001 to continue." Reading from offset 2001 shows the rest. | No | | |
| R6 | C-6, S-1: "ask ai to trace back to specific code lines" | Every line the read tool shows starts with its line number in the original file, so the user can check the output against the file. | Reading a 20-line file with offset=10 and limit=3 shows exactly three lines, starting with 10:, 11:, and 12:, and their text matches lines 10 to 12 of the file. | No | | |

## Requirement changes

R1
- Original: ...refuses to read it and returns none of its contents, even when the user asks for that file by name. This still holds in a new session.
- Revised: same, but the new session part is now "the decision only depends on the rules and the file path, so a new session with the same rules denies it too."
- Why: checkability. I can't close and reopen opencode inside a test. The read tool doesn't remember anything between sessions anyway, the rules come from the config each time. Users (C-2, O-3) just wanted a deny to always stick.

R3
- Original: reading it again gives output identical to the first read.
- Revised: reading it again shows the same file content (numbered lines and footer).
- Why: feasibility. If there is an AGENTS.md nearby, opencode adds its instructions to the output only on the first read in a message, on purpose. I tested it and the full output really is different the second time even though the file is the same. Users (C-4, S-3, O-4) were talking about the file content, so that is what the revised version checks.

R2, R4, R5, and R6 are kept because the code already does them and they can be tested directly.

