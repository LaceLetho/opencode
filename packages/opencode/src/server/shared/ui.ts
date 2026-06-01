import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "", sleepFriendly = false) =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src ${sleepFriendly ? "'self' data:" : "* data:"}`
export const DEFAULT_CSP = csp()
export type WebEventMode = "auto" | "sse"

const PUBLIC_STATIC_PATHS = new Set([
  "/favicon.ico",
  "/favicon-v3.ico",
  "/favicon-v3.svg",
  "/favicon-96x96-v3.png",
  "/apple-touch-icon-v3.png",
  "/site.webmanifest",
  "/social-share.png",
  "/oc-theme-preload.js",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string, sleepFriendly = false) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "", sleepFriendly)
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function staticNotFound() {
  return HttpServerResponse.text("Not Found\n", {
    status: 404,
    contentType: "text/plain; charset=utf-8",
  })
}

function missingEmbeddedUI() {
  return HttpServerResponse.text("Embedded web UI is missing and hosted UI proxy is disabled.\n", {
    status: 500,
    contentType: "text/plain; charset=utf-8",
  })
}

function isStaticAsset(path: string) {
  if (PUBLIC_STATIC_PATHS.has(path)) return true
  if (path.startsWith("/assets/")) return true
  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json|webmanifest|wasm)$/.test(path)
}

function embeddedUIFile(path: string, embeddedWebUI: Record<string, string>) {
  const exact = embeddedWebUI[path.replace(/^\//, "")]
  if (exact) return exact
  if (isStaticAsset(path)) return null
  return embeddedWebUI["index.html"] ?? null
}

function normalizeWebEventMode(mode: string | undefined): WebEventMode {
  return mode === "auto" ? "auto" : "sse"
}

function injectRuntimeConfig(body: string, mode: string | undefined) {
  const tag = `<meta name="opencode-web-event-mode" content="${normalizeWebEventMode(mode)}">`
  if (body.includes('name="opencode-web-event-mode"')) return body
  if (/<\/head>/i.test(body)) return body.replace(/<\/head>/i, `${tag}</head>`)
  return body
}

function embeddedUIResponse(
  file: string,
  body: Uint8Array,
  options: { sleepFriendlyCsp: boolean; webEventMode: string } = { sleepFriendlyCsp: false, webEventMode: "sse" },
) {
  const mime = AppFileSystem.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    const html = injectRuntimeConfig(new TextDecoder().decode(body), options.webEventMode)
    headers.set("content-security-policy", cspForHtml(html, options.sleepFriendlyCsp))
    return HttpServerResponse.raw(new TextEncoder().encode(html), { headers })
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  embeddedWebUI: Record<string, string>,
  options: { sleepFriendlyCsp: boolean; webEventMode: string } = { sleepFriendlyCsp: false, webEventMode: "sse" },
) {
  const file = embeddedUIFile(requestPath, embeddedWebUI)
  if (!file) return Effect.succeed(isStaticAsset(requestPath) ? staticNotFound() : notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body, options)),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed(isStaticAsset(requestPath) ? staticNotFound() : notFound()),
    ),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: {
    fs: AppFileSystem.Interface
    client: HttpClient.HttpClient
    disableEmbeddedWebUi: boolean
    disableHostedUiProxy: boolean
    sleepFriendlyCsp: boolean
    webEventMode: string
  },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI)
      return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI, {
        sleepFriendlyCsp: services.sleepFriendlyCsp,
        webEventMode: services.webEventMode,
      })
    if (services.disableHostedUiProxy) {
      if (isStaticAsset(path)) return staticNotFound()
      return missingEmbeddedUI()
    }

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = injectRuntimeConfig(yield* response.text, services.webEventMode)
      headers.set("Content-Security-Policy", cspForHtml(body, services.sleepFriendlyCsp))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp("", services.sleepFriendlyCsp))
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
