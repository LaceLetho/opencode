/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { Global } from "@opencode-ai/core/global"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, createSignal, onCleanup, type ParentProps, type Setter } from "solid-js"
import { KVProvider, useKV } from "@/cli/cmd/tui/context/kv"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { QuestionPrompt } from "@/cli/cmd/tui/routes/session/question"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { directory, eventSource, json } from "../../fixture/tui-sdk"

type QuestionReply = {
  requestID: string
  answers: QuestionAnswer[]
}

async function mountQuestion(input: { root: string; request: QuestionRequest }) {
  const previous = {
    config: Global.Path.config,
    state: Global.Path.state,
  }
  Global.Path.config = path.join(input.root, "config")
  Global.Path.state = path.join(input.root, "state")
  await mkdir(Global.Path.config, { recursive: true })
  await mkdir(Global.Path.state, { recursive: true })
  await Bun.write(path.join(Global.Path.state, "kv.json"), "{}")

  const replies: QuestionReply[] = []
  let setRequest!: Setter<QuestionRequest>
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const fetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init)
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/question\/([^/]+)\/reply$/)

    if (match) {
      const body = (await request.json()) as { answers: QuestionAnswer[] }
      replies.push({ requestID: match[1]!, answers: body.answers })
      return json({})
    }

    if (/^\/question\/[^/]+\/reject$/.test(url.pathname)) {
      return json({})
    }

    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const [request, set] = createSignal(input.request)
    setRequest = set

    onCleanup(offKeymap)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <Ready onReady={resolveReady}>
              <ThemeProvider mode="dark">
                <SDKProvider url="http://test" directory={directory} events={eventSource()} fetch={fetch}>
                  <QuestionPrompt request={request()} />
                </SDKProvider>
              </ThemeProvider>
            </Ready>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <box width={100} height={20}>
        <Harness />
      </box>
    ),
    { width: 100, height: 20, kittyKeyboard: true },
  )
  await ready

  return {
    app,
    replies,
    setRequest(request: QuestionRequest) {
      setRequest(request)
    },
    cleanup() {
      app.renderer.destroy()
      Global.Path.config = previous.config
      Global.Path.state = previous.state
    },
  }
}

function Ready(props: ParentProps<{ onReady: () => void }>) {
  const kv = useKV()
  createEffect(() => {
    if (kv.ready) props.onReady()
  })

  return <>{props.children}</>
}

test("question prompt answers a new request after a stale custom edit", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountQuestion({
    root: tmp.path,
    request: {
      id: "question-1",
      sessionID: "session-1",
      questions: [
        {
          header: "First",
          question: "First question?",
          options: [{ label: "Preset", description: "Use the preset answer." }],
          custom: true,
        },
      ],
    },
  })

  try {
    await prompt.app.renderOnce()
    prompt.app.mockInput.pressKey("2")
    await prompt.app.renderOnce()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    prompt.setRequest({
      id: "question-2",
      sessionID: "session-1",
      questions: [
        {
          header: "Second",
          question: "Second question?",
          options: [{ label: "Next", description: "Use the next answer." }],
          custom: false,
        },
      ],
    })
    await prompt.app.renderOnce()

    prompt.app.mockInput.pressKey("1")
    await prompt.app.renderOnce()

    expect(prompt.replies).toEqual([{ requestID: "question-2", answers: [["Next"]] }])
  } finally {
    prompt.cleanup()
  }
})

test("question prompt confirm keybinding works after leaving a custom edit by mouse", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountQuestion({
    root: tmp.path,
    request: {
      id: "question-1",
      sessionID: "session-1",
      questions: [
        {
          header: "First",
          question: "First question?",
          options: [{ label: "Preset", description: "Use the preset answer." }],
          custom: true,
        },
        {
          header: "Second",
          question: "Second question?",
          options: [{ label: "Next", description: "Use the next answer." }],
          custom: false,
        },
      ],
    },
  })

  try {
    await prompt.app.renderOnce()
    prompt.app.mockInput.pressKey("2")
    await prompt.app.renderOnce()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    const confirm = prompt.app.renderer.root.findDescendantById("tui-question-tab-confirm")
    if (!confirm) throw new Error("expected confirm tab")

    await prompt.app.mockMouse.click(confirm.screenX + 1, confirm.screenY)
    await prompt.app.renderOnce()
    prompt.app.mockInput.pressEnter()
    await prompt.app.renderOnce()

    expect(prompt.replies).toEqual([{ requestID: "question-1", answers: [[], []] }])
  } finally {
    prompt.cleanup()
  }
})
