declare const __SWARM_VERSION__: string;

export function resolveVersion(buildVersion: string | undefined, packageVersion: string): string {
  return buildVersion ?? `${packageVersion}+dev`;
}

export const VERSION = resolveVersion(
  typeof __SWARM_VERSION__ === "undefined" ? undefined : __SWARM_VERSION__,
  "0.1.0",
);
