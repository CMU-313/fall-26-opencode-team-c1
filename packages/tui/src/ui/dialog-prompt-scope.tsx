import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "./dialog"

export type DialogPromptScopeProps = {
  suggestion: string
  onUseSuggestion: () => void
  onSendAnyway: () => void
}

export function DialogPromptScope(props: DialogPromptScopeProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "suggestion" as "suggestion" | "send",
  })

  function submit() {
    if (store.active === "suggestion") props.onUseSuggestion()
    if (store.active === "send") props.onSendAnyway()
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Confirm dialog selection",
        group: "Dialog",
        cmd: submit,
      },
      {
        key: "left",
        desc: "Previous dialog option",
        group: "Dialog",
        cmd: () => setStore("active", store.active === "suggestion" ? "send" : "suggestion"),
      },
      {
        key: "right",
        desc: "Next dialog option",
        group: "Dialog",
        cmd: () => setStore("active", store.active === "suggestion" ? "send" : "suggestion"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          This request may be too broad
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>Try a smaller learning-focused step instead.</text>
      <box paddingTop={1} paddingBottom={1}>
        <text fg={theme.text}>{props.suggestion}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <For each={["send", "suggestion"] as const}>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                if (key === "suggestion") props.onUseSuggestion()
                if (key === "send") props.onSendAnyway()
                dialog.clear()
              }}
            >
              <text fg={key === store.active ? theme.selectedListItemText : theme.textMuted}>
                {key === "suggestion" ? "Use suggestion" : "Ask anyway"}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
