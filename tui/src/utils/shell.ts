/**
 * Shell execution utilities wrapping Bun's spawn API.
 *
 * Provides both synchronous and asynchronous helpers for running
 * external commands (git, tmux) with structured output.
 */

/** Structured result from a shell command execution. */
export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

/**
 * Execute a command synchronously, blocking until completion.
 * Suitable for fast commands (git, tmux) that complete in milliseconds.
 *
 * @param command - The executable name (e.g. "git", "tmux").
 * @param args    - Arguments to pass to the command.
 * @param cwd     - Optional working directory.
 */
export function execSync(command: string, args: string[], cwd?: string): ShellResult {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
    success: proc.exitCode === 0,
  }
}

/**
 * Execute a command asynchronously, returning a promise.
 * Suitable for potentially long-running operations.
 *
 * @param command - The executable name (e.g. "git", "tmux").
 * @param args    - Arguments to pass to the command.
 * @param cwd     - Optional working directory.
 */
export async function exec(command: string, args: string[], cwd?: string): Promise<ShellResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  const exitCode = await proc.exited

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
    success: exitCode === 0,
  }
}
