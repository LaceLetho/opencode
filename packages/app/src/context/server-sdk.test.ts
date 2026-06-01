import { describe, expect, test } from "bun:test"
import { normalizeEventMode, shouldConnectEventStream } from "./server-sdk"

describe("normalizeEventMode", () => {
  test("uses auto only when explicitly requested", () => {
    expect(normalizeEventMode("auto")).toBe("auto")
    expect(normalizeEventMode("sse")).toBe("sse")
    expect(normalizeEventMode("poll")).toBe("sse")
    expect(normalizeEventMode(undefined)).toBe("sse")
  })
})

describe("shouldConnectEventStream", () => {
  test("keeps explicit sse mode connected regardless of visibility", () => {
    expect(shouldConnectEventStream({ mode: "sse", visibility: "hidden" })).toBe(true)
  })

  test("connects auto mode only while visible", () => {
    expect(shouldConnectEventStream({ mode: "auto", visibility: "visible" })).toBe(true)
    expect(shouldConnectEventStream({ mode: "auto", visibility: "hidden" })).toBe(false)
  })

  test("connects when document visibility is unavailable", () => {
    expect(shouldConnectEventStream({ mode: "auto" })).toBe(true)
  })
})
