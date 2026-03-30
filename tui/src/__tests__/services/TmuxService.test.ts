import { describe, expect, test } from "bun:test"
import { TmuxService } from "../../services/TmuxService.js"

describe("TmuxService", () => {
  test("skips custom layout when the configured script path does not exist", () => {
    const service = new TmuxService({
      layoutScriptPath: "/tmp/swarm-layout-script-that-does-not-exist.sh",
    })

    expect(() => {
      service.applyConfiguredLayout("session-name", "/tmp")
    }).not.toThrow()
  })
})
