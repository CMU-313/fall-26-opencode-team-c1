/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { SDKProvider } from "../../../src/context/sdk"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { QuestionPrompt } from "../../../src/routes/session/question"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { eventSource } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

for (const choice of ["Continue", "Cancel", "Why main.ts?"])
  test(`walkthrough question renders files and submits ${choice}`, async () => {
    await using dir = await tmpdir()
    await Bun.write(`${dir.path}/kv.json`, "{}")
    const replies: unknown[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      if (!(input instanceof Request)) throw new Error("Expected SDK request")
      replies.push(await input.json())
      return Response.json(true)
    }) as typeof globalThis.fetch
    const config = createTuiResolvedConfig()
    const files = ["main.ts", "config.ts", "main.test.ts"]

    function Harness() {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      onCleanup(registerOpencodeKeymap(keymap, renderer, config))
      return (
        <TestTuiContexts directory={dir.path} paths={{ home: dir.path, state: dir.path, worktree: dir.path }}>
          <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
            <OpencodeKeymapProvider keymap={keymap}>
              <TuiConfigProvider config={config}>
                <KVProvider>
                  <ThemeProvider mode="dark">
                    <QuestionPrompt
                      request={{
                        id: "que_walkthrough",
                        sessionID: "ses_walkthrough",
                        questions: [
                          {
                            header: "Codebase walkthrough",
                            question:
                              files.map((file) => `${file} — Supports the startup fix.`).join("\n") +
                              "\n\nContinue with the edit, cancel, or type a question about a file.",
                            options: [
                              { label: "Continue", description: "Allow edits for this request" },
                              { label: "Cancel", description: "End this request without editing" },
                            ],
                            custom: true,
                          },
                        ],
                      }}
                    />
                  </ThemeProvider>
                </KVProvider>
              </TuiConfigProvider>
            </OpencodeKeymapProvider>
          </SDKProvider>
        </TestTuiContexts>
      )
    }

    const app = await testRender(() => <Harness />, { width: 100, height: 30 })
    try {
      await app.renderOnce()
      for (let attempt = 0; !app.captureCharFrame().includes("main.ts") && attempt < 100; attempt++) {
        await Bun.sleep(10)
        await app.renderOnce()
      }
      const frame = app.captureCharFrame()
      for (const file of files) expect(frame).toContain(`${file} — Supports the startup fix.`)
      expect(frame).toContain("Continue")
      expect(frame).toContain("Cancel")
      expect(frame).toContain("Type your own answer")
      if (choice !== "Continue") app.mockInput.pressArrow("down")
      if (choice === "Why main.ts?") {
        app.mockInput.pressArrow("down")
        app.mockInput.pressEnter()
        await app.renderOnce()
        await app.mockInput.typeText(choice)
      }
      app.mockInput.pressEnter()
      for (let attempt = 0; replies.length === 0 && attempt < 100; attempt++) await Bun.sleep(10)
      expect(replies).toEqual([{ answers: [[choice]] }])
    } finally {
      app.renderer.destroy()
    }
  })
