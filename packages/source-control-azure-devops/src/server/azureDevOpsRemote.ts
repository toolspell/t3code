import * as Effect from "effect/Effect";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

/** The remote that scopes `az` when T3 selected none, from `git remote -v` output. */
export function primaryRemoteUrl(output: string) {
  if (!output.endsWith("\n")) return null;
  const remotes = new Map<string, string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(trimmed);
    if (!match?.[1] || !match[2]) return null;
    if (match[3] === "fetch" && !remotes.has(match[1])) remotes.set(match[1], match[2]);
  }
  // Match the provider context SourceControlProviderRegistry binds, and `az`'s own detection.
  return (
    remotes.get("origin") ??
    [...remotes.values()].find((url) => scopeFromRemoteUrl(url) !== null) ??
    null
  );
}

/** Organization, project, and repository of an Azure DevOps Services remote; null for any other. */
export function scopeFromRemoteUrl(remote: string) {
  try {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/u.exec(remote);
    const url = new URL(
      remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : remote,
    );
    if (url.search || url.hash) return null;
    const legacy = url.hostname.endsWith(".visualstudio.com");
    const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
    let organization: string | undefined;
    if (
      url.protocol === "ssh:" &&
      (url.hostname === "ssh.dev.azure.com" || url.hostname === "vs-ssh.visualstudio.com")
    ) {
      if (parts.length !== 4 || parts.shift() !== "v3") return null;
      organization = parts.shift();
    } else if (url.protocol === "https:") {
      if (url.hostname === "dev.azure.com") organization = parts.shift();
      else {
        organization = /^([^.]+)\.visualstudio\.com$/u.exec(url.hostname)?.[1];
        if (!organization) return null;
        if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift();
      }
      if (parts.length !== 3 || parts[1] !== "_git") return null;
      parts.splice(1, 1);
    } else return null;
    const [project, repository] = parts;
    if (!organization || !project || !repository) return null;
    // `az` replaces a value starting with `@` by the contents of that local file.
    if ([organization, project, repository].some((part) => /^@|[\p{Cc}/\\]/u.test(part))) {
      return null;
    }
    if (legacy && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(organization))
      return null;
    return {
      organizationName: organization,
      // az keys organization-scoped credentials by the original host family.
      organization: legacy
        ? `https://${organization}.visualstudio.com`
        : `https://dev.azure.com/${encodeURIComponent(organization)}`,
      project,
      repository,
    };
  } catch {
    return null;
  }
}

/** The checkout's primary remote, or null when git cannot name one. */
export const checkoutRemoteUrl = (
  process: SourceControlHost.SourceControlHost["Service"]["process"],
  cwd: string,
  timeoutMs = 30_000,
) =>
  process
    .run({
      operation: "AzureDevOpsRemote.resolveScope",
      command: "git",
      args: ["remote", "-v"],
      cwd,
      env: {
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      },
      timeoutMs,
      maxOutputBytes: 64 * 1024,
      allowNonZeroExit: true,
    })
    .pipe(
      Effect.map((remotes) =>
        remotes.exitCode === 0 && !remotes.stdoutTruncated && !remotes.stdoutInvalidUtf8
          ? primaryRemoteUrl(remotes.stdout)
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );
