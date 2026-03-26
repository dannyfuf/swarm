import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { RepoList } from "../../components/RepoList.js"
import type { Repo } from "../../types/repo.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy()
  }
})

const mockRepos: Repo[] = [
  {
    name: "my-project",
    path: "/home/user/repos/my-project",
    defaultBranch: "main",
    lastScanned: new Date("2026-01-01"),
  },
  {
    name: "other-project",
    path: "/home/user/repos/other-project",
    defaultBranch: "main",
    lastScanned: new Date("2026-01-01"),
  },
]

const noop = () => {}

describe("RepoList", () => {
  test("renders repo names", async () => {
    testSetup = await testRender(
      <box width={40} height={20} flexDirection="column">
        <RepoList
          repos={mockRepos}
          selectedIndex={0}
          focused={true}
          onSelect={noop}
          onChange={noop}
        />
      </box>,
      { width: 40, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("my-project")
    expect(frame).toContain("other-project")
  })

  test("renders empty state when no repos", async () => {
    testSetup = await testRender(
      <box width={40} height={20} flexDirection="column">
        <RepoList repos={[]} selectedIndex={0} focused={true} onSelect={noop} onChange={noop} />
      </box>,
      { width: 40, height: 20 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("No repositories found")
  })
})
