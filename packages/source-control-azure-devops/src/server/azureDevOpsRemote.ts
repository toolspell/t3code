import * as Effect from "effect/Effect";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import { azureDevOpsOrganizationUrl } from "../shared/definition.ts";

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

/**
 * Organization or collection, project, and repository of an Azure DevOps remote; null for any
 * other. `organizationUrl` is the URL its token is saved under; `webPortKnown` is false for an SSH
 * or http remote on Azure DevOps Server, whose https port the remote does not name.
 */
export function scopeFromRemoteUrl(remote: string) {
  try {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/u.exec(remote);
    const url = new URL(
      remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : remote,
    );
    if (url.search || url.hash) return null;
    const legacy = url.hostname.endsWith(".visualstudio.com");
    const services =
      legacy || url.hostname === "dev.azure.com" || url.hostname.endsWith(".dev.azure.com");
    const segments = url.pathname.slice(1).split("/");
    const parts = segments.map(decodeURIComponent);
    let organization: string | undefined;
    let server: { readonly organizationUrl: string; readonly webPortKnown: boolean } | undefined;
    if (
      url.protocol === "ssh:" &&
      (url.hostname === "ssh.dev.azure.com" || url.hostname === "vs-ssh.visualstudio.com")
    ) {
      if (parts.length !== 4 || parts.shift() !== "v3") return null;
      organization = parts.shift();
    } else if (
      url.protocol === "https:" &&
      (url.hostname === "dev.azure.com" || url.hostname.endsWith(".visualstudio.com"))
    ) {
      if (url.hostname === "dev.azure.com") organization = parts.shift();
      else {
        organization = /^([^.]+)\.visualstudio\.com$/u.exec(url.hostname)?.[1];
        if (!organization) return null;
        if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift();
      }
      if (parts.length !== 3 || parts[1] !== "_git") return null;
      parts.splice(1, 1);
    } else if (!services && ["ssh:", "https:", "http:"].includes(url.protocol)) {
      const collection = parts[0]?.toLowerCase() === "tfs" ? 2 : 1;
      if (parts.length !== collection + 3 || parts[collection + 1] !== "_git") return null;
      const webPortKnown = url.protocol === "https:";
      const organizationUrl = azureDevOpsOrganizationUrl(
        `https://${webPortKnown ? url.host : url.hostname}/${segments.slice(0, collection).join("/")}`,
      );
      if (organizationUrl === null) return null;
      server = { organizationUrl, webPortKnown };
      organization = parts.splice(0, collection).join("/");
      parts.splice(1, 1);
    } else return null;
    const [project, repository] = parts;
    if (!organization || !project || !repository) return null;
    // `az` replaces a value starting with `@` by the contents of that local file.
    if (
      [server === undefined ? organization : "", project, repository].some((part) =>
        /^@|[\p{Cc}/\\]/u.test(part),
      )
    ) {
      return null;
    }
    if (legacy && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(organization))
      return null;
    if (server !== undefined) {
      return {
        organizationName: organization,
        organization: server.organizationUrl,
        ...server,
        project,
        repository,
      };
    }
    const organizationUrl = `https://dev.azure.com/${encodeURIComponent(organization)}`;
    return {
      organizationName: organization,
      // az keys organization-scoped credentials by the original host family.
      organization: legacy ? `https://${organization}.visualstudio.com` : organizationUrl,
      organizationUrl: organizationUrl.toLowerCase(),
      webPortKnown: true,
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
