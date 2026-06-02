import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "fetch-outbound" })
const marker = Symbol.for("opencode.fetchLogOutbound")

export function install() {
  if (process.env.OPENCODE_RAILWAY_SLEEP_MODE !== "true") return
  if (process.env.LOG_SLEEP_BLOCKERS !== "true") return
  if (Reflect.get(globalThis, marker)) return

  const original = globalThis.fetch
  Reflect.set(globalThis, marker, true)

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    logRequest(input)
    return original.call(globalThis, input, init)
  }) as typeof fetch

  log.info("installed outbound fetch logger")
}

function logRequest(input: RequestInfo | URL) {
  const url = urlFromInput(input)
  if (!url) return log.info("outbound fetch", { target: "unknown" })
  log.info("outbound fetch", {
    protocol: url.protocol,
    host: url.host,
    path: url.pathname,
  })
}

function urlFromInput(input: RequestInfo | URL) {
  if (input instanceof URL) return input
  if (input instanceof Request) return new URL(input.url)
  if (typeof input !== "string") return
  if (!URL.canParse(input)) return
  return new URL(input)
}

export * as FetchLogOutbound from "./fetch-log-outbound"
