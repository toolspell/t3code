import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import { canonicalRepositoryPath, parseGitRemoteRepository } from "@t3tools/shared/git";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  hostCredentialSettingsFields,
  isChangeRequestAuthorityOfProject,
  parseChangeRequestPath,
  parseIssuePath,
  parseCommitPath,
  remoteWebOrigin,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

// Azure DevOps Server runs on any hostname; its `_git` route identifies it.
const CHANGE_REQUEST_PATH = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/((?:[^/]+\/)*_git\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;
// Work items belong to the project: /{organization}/{project}/_workitems/edit/{id}.
const WORK_ITEM_PATH = /^\/([^/]+\/[^/]+)\/_workitems\/edit\/(\d+)(?:\/|$)/u;
// Below the `tfs` virtual directory of an Azure DevOps Server: /tfs/{collection}/{project}/...
const TFS_WORK_ITEM_PATH = /^\/(tfs\/[^/]+\/[^/]+)\/_workitems\/edit\/(\d+)(?:\/|$)/iu;
// A legacy organization is its hostname: https://{organization}.visualstudio.com/{project}/...
const LEGACY_WORK_ITEM_PATH = /^\/([^/]+)\/_workitems\/edit\/(\d+)(?:\/|$)/u;
const CHECKOUT_COMMAND = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i;
const ORGANIZATION_NAME = /^[a-z0-9][a-z0-9-]*$/iu;
const LEGACY_HOST = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/u;

// `ssh.dev.azure.com` is the default SSH clone host (git@ssh.dev.azure.com:v3/org/project/repo),
// so any `*.dev.azure.com` subdomain is Azure. Legacy hosts stay under `.visualstudio.com`,
// including `vs-ssh.visualstudio.com`.
function isAzureHostname(hostname: string): boolean {
  return (
    hostname === "dev.azure.com" ||
    hostname.endsWith(".dev.azure.com") ||
    hostname.endsWith(".visualstudio.com")
  );
}

/**
 * How many leading segments of an Azure DevOps Server path name the collection: one, or two below
 * the `tfs` virtual directory older installs keep.
 */
function collectionLength(segments: ReadonlyArray<string>): number {
  return segments[0]?.toLowerCase() === "tfs" ? 2 : 1;
}

/** Whether a remote's lower-case `host/path` key is a repository on an Azure DevOps Server. */
function isServerRepositoryKey(key: string): boolean {
  const segments = key.split("/").slice(1);
  const at = segments.indexOf("_git");
  return at >= collectionLength(segments) && at === segments.length - 2;
}

/**
 * The key a token is saved under: `https://dev.azure.com/{organization}`, or for a server
 * `https://{host}[:port]/[tfs/]{collection}`, lower case with each segment escaped once. Takes an
 * organization name or any page below either. Null otherwise, and for `http:`, sent in the clear.
 */
export function azureDevOpsOrganizationUrl(input: string): string | null {
  const trimmed = input.trim();
  if (ORGANIZATION_NAME.test(trimmed)) return `https://dev.azure.com/${trimmed.toLowerCase()}`;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname === "") return null;
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (isAzureHostname(hostname)) {
    const organization =
      hostname === "dev.azure.com" ? segments[0] : LEGACY_HOST.exec(hostname)?.[1];
    return organization !== undefined && ORGANIZATION_NAME.test(organization)
      ? `https://dev.azure.com/${organization.toLowerCase()}`
      : null;
  }
  const collection = segments.slice(0, collectionLength(segments));
  // `_apis`, `_signin` and the like are routes, never a collection.
  if (collection.length < collectionLength(segments) || collection.at(-1)!.startsWith("_")) {
    return null;
  }
  return `https://${url.host.toLowerCase()}/${canonicalRepositoryPath(collection.join("/"))}`;
}

/**
 * Azure alone addresses one repository under two names that share no part: `ssh.dev.azure.com` and
 * `v3/{org}/{project}/{repo}` over SSH, against `dev.azure.com` and `{org}/{project}/_git/{repo}`
 * everywhere a person sees it. A project cloned over SSH would otherwise be a different repository
 * to every comparison made against a pull request URL, which arrives in the web spelling.
 */
function repositoryKeyFromRemote(key: string): string | null {
  const match =
    /^(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(key);
  if (match === null) {
    // Azure takes a name as written, so its keys keep the `.git` other hosts drop.
    return isAzureHostname(key.split("/", 1)[0]!) || isServerRepositoryKey(key) ? key : null;
  }
  const [, host, organization, project, repository] = match;
  return host === "ssh.dev.azure.com"
    ? `dev.azure.com/${organization}/${project}/_git/${repository}`
    : `${organization}.visualstudio.com/${project}/_git/${repository}`;
}

/** Every spelling of an Azure DevOps Services repository, on `dev.azure.com`. */
function canonicalRepositoryKey(key: string): string | null {
  const canonical = key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
  return canonical.startsWith("dev.azure.com/") ? canonical : null;
}

function decodeUrlPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function checkoutCommandId(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") return parts[index + 1] ?? null;
    if (part.startsWith("--id=")) return part.slice("--id=".length) || null;
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

const KIND = SourceControlProviderKind.make("azure-devops");

/** Personal access tokens keyed by organization URL; Azure no longer accepts one token for every organization. */
export const settings = makeProviderSettingsSchema({ tokens: hostCredentialSettingsFields.tokens });
export type AzureDevOpsSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Azure DevOps",
  pickerLabel: "Azure DevOps",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "project/repository",
  // `az repos` reads need the checkout's organization and project, so a bare hostname names no
  // repository this client can act on.
  publicHost: null,
  publishDescription: "dev.azure.com",
  publishHost: () => "dev.azure.com",
  newRepositoryOwner: () => null,
  // Saved tokens are keyed `https://dev.azure.com/{organization}`; the server creates over REST there.
  // Only organizations whose saved token passed the check; publishing with a failing one would fail.
  publishNamespaces: (auth) =>
    (auth.accounts ?? []).flatMap((entry) => {
      if (!entry.authenticated) return [];
      const organization = /^https:\/\/dev\.azure\.com\/([^/]+)\/?$/iu.exec(entry.host)?.[1];
      return organization ? [decodeUrlPathSegment(organization)] : [];
    }),
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) => {
    if (webUrl) return changeRequestUrlBelow(webUrl, `pullrequest/${number}`);
    const key = `${host}/${repository}`.toLowerCase();
    const [canonicalHost = host, ...path] = (canonicalRepositoryKey(key) ?? key).split("/");
    return `${remoteWebOrigin(canonicalHost, remoteUrl)}/${path.join("/")}/pullrequest/${number}`;
  },
  commitUrl: (input) => {
    const key = `${input.host}/${input.repository}`.toLowerCase();
    const [host = input.host, ...path] = (canonicalRepositoryKey(key) ?? key).split("/");
    return buildCommitUrl({ ...input, host, repository: path.join("/") }, "commit");
  },
  parseCommitUrl: (url) => parseCommitPath(url, COMMIT_PATH),
  // Servers on different ports are different servers, so a port stays in the link.
  parseChangeRequestUrl: (url) => {
    const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
    return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
  },
  // A project named with spaces arrives percent-encoded; the binding it is matched against is not.
  parseIssueUrl: (url) => {
    const hostname = url.hostname.toLowerCase();
    const legacy = hostname.endsWith(".visualstudio.com");
    const link =
      !isAzureHostname(hostname) && /^\/tfs\//iu.test(url.pathname)
        ? parseIssuePath(url, TFS_WORK_ITEM_PATH)
        : (parseIssuePath(url, WORK_ITEM_PATH) ??
          (legacy ? parseIssuePath(url, LEGACY_WORK_ITEM_PATH) : null));
    if (link === null) return null;
    const scope = link.scope.split("/").map(decodeUrlPathSegment).join("/").toLowerCase();
    if (!legacy) return { ...link, scope };
    // On legacy hosts the default collection is optional in a work item URL.
    const scopeAlias =
      /^defaultcollection\/([^/]+)$/u.exec(scope)?.[1] ??
      (scope.includes("/") ? undefined : `defaultcollection/${scope}`);
    return { ...link, scope, ...(scopeAlias === undefined ? {} : { scopeAlias }) };
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  checkoutCommand: ({ number }) => `az repos pr checkout --id ${number}`,
  // Completing or abandoning is a status change, the same `update` this package runs.
  changeRequestCloseCommand:
    /\baz\s+repos\s+pr\s+update\b[^;&|]*--status[\s=]+["']?(?:completed|abandoned)\b/u,
  authorProfileUrl: () => null,
  hardLineBreaks: true,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => {
    const args = CHECKOUT_COMMAND.exec(input)?.[1];
    return args ? checkoutCommandId(args) : null;
  },
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ remoteUrl, host, hostname }) => {
    if (isAzureHostname(hostname)) {
      return { kind: KIND, name: "Azure DevOps", baseUrl: `https://${host}` };
    }
    const path = parseGitRemoteRepository(remoteUrl, { keepGitSuffix: true })?.path;
    if (path === undefined || !isServerRepositoryKey(`${hostname}/${path}`)) return null;
    const segments = path.split("/");
    const collection = segments.slice(0, collectionLength(segments)).join("/");
    // An SSH remote's port is the SSH server's; the web is on the host's default https port.
    return {
      kind: KIND,
      name: "Azure DevOps Server",
      baseUrl: `${remoteWebOrigin(host, remoteUrl)}/${collection}`,
    };
  },
  /**
   * `az repos pr list --repository` takes a name; organisation and project come from checkout.
   * Decode the remote URL's name segment: `az` treats escapes literally and returns 404.
   */
  repositorySelector: (identity) => {
    const segments = (identity.displayName ?? "").split("/").filter((part) => part !== "_git");
    const name = identity.name || segments.at(-1);
    return name ? decodeUrlPathSegment(name) : null;
  },
  // Work items belong to the project: `organization/project` out of the remote's
  // `organization/project/_git/repository`. A shorter path depends on the host: `acme/_git/web`
  // is a project named after its repository on dev.azure.com and a bare project on a legacy host.
  issueScope: (identity) => {
    const segments = (identity.displayName ?? "")
      .split("/")
      .filter((part) => part !== "")
      .map(decodeUrlPathSegment);
    const at = segments.indexOf("_git");
    const repository = segments[at + 1];
    const host = identity.canonicalKey?.split("/", 1)[0]?.toLowerCase() ?? "";
    // On Azure DevOps Server the project follows the collection, which may sit below `tfs`.
    if (host !== "" && !isAzureHostname(host) && repository !== undefined) {
      const collection = collectionLength(segments);
      if (at === collection + 1) return segments.slice(0, at).join("/");
      return at === collection ? [...segments.slice(0, at), repository].join("/") : null;
    }
    if (at === 2) return segments.slice(0, at).join("/");
    if ((at !== 0 && at !== 1) || repository === undefined) return null;
    const legacy = host.endsWith(".visualstudio.com");
    const [first = ""] = segments;
    if (at === 0) return legacy ? repository : null;
    if (host === "dev.azure.com") return `${first}/${repository}`;
    if (!legacy) return null;
    // Work item URLs on a legacy host leave the collection out.
    return first.toLowerCase() === "defaultcollection" ? repository : first;
  },
  repositoryKeyFromRemote,
  canonicalRepositoryKey,
  isChangeRequestInRepository: (identity, link) => {
    if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
    const projectKey = canonicalRepositoryPath(identity.canonicalKey);
    const linkKey = canonicalRepositoryPath(`${link.host}/${link.repository}`);
    return (
      (canonicalRepositoryKey(projectKey) ?? projectKey) ===
      (canonicalRepositoryKey(linkKey) ?? linkKey)
    );
  },
  canReadChangeRequestOnHost: () => false,
  settings,
});
