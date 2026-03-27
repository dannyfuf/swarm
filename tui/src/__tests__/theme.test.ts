import { describe, expect, test } from "bun:test"
import {
  badgeSymbols,
  borders,
  colors,
  spacing,
  spinnerFrames,
  spinnerIntervalMs,
} from "../theme.js"

const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/

describe("theme", () => {
  test("all colors are valid lowercase hex strings", () => {
    for (const [_key, value] of Object.entries(colors)) {
      expect(value).toMatch(HEX_COLOR_REGEX)
    }
  })

  test("all spacing values are non-negative integers", () => {
    for (const [_key, value] of Object.entries(spacing)) {
      expect(typeof value).toBe("number")
      expect(value).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  test("all border styles are valid", () => {
    const validStyles = ["single", "double", "rounded", "bold"]
    for (const [_key, value] of Object.entries(borders)) {
      expect(validStyles).toContain(value)
    }
  })

  test("badge symbols are single-character strings", () => {
    for (const [_key, value] of Object.entries(badgeSymbols)) {
      expect(typeof value).toBe("string")
      expect(value.length).toBe(1)
    }
  })

  test("spinner frames are non-empty", () => {
    expect(spinnerFrames.length).toBeGreaterThan(0)
    for (const frame of spinnerFrames) {
      expect(typeof frame).toBe("string")
      expect(frame.length).toBe(1)
    }
  })

  test("spinner interval is a positive number", () => {
    expect(spinnerIntervalMs).toBeGreaterThan(0)
  })
})
