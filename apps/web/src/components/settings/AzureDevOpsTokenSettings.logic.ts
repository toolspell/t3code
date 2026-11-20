import type { SourceControlProviderAuth } from "@t3tools/contracts";
import * as Option from "effect/Option";

const ORGANIZATION_NAME = /^[a-z0-9][a-z0-9-]*$/iu;
const LEGACY_HOST = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/u;

/**
 * The organization URL a token is saved under, as `https://dev.azure.com/{organization}`. Accepts a
 * bare organization name, any page inside it, and the legacy `{organization}.visualstudio.com`.
 */
export function normalizeAzureDevOpsOrganizationUrl(input: string): string | null {
  const trimmed = input.trim();
  if (ORGANIZATION_NAME.test(trimmed)) return `https://dev.azure.com/${trimmed.toLowerCase()}`;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const organization =
    host === "dev.azure.com"
      ? url.pathname.split("/").find((segment) => segment !== "")
      : LEGACY_HOST.exec(host)?.[1];
  return organization !== undefined && ORGANIZATION_NAME.test(organization)
    ? `https://dev.azure.com/${organization.toLowerCase()}`
    : null;
}

export function azureDevOpsNewTokenUrl(organizationUrl: string): string {
  return `${organizationUrl}/_usersSettings/tokens`;
}

export type AzureDevOpsPatCheck =
  | { readonly status: "valid"; readonly account: string }
  | { readonly status: "rejected" }
  | { readonly status: "unknown" };

/**
 * MOCK until the server checks saved tokens: an organization named `invalid…` is rejected and one
 * named `offline…` cannot be reached; every other token passes.
 */
export function checkAzureDevOpsPat(organizationUrl: string): AzureDevOpsPatCheck {
  const organization = organizationUrl.split("/").at(-1) ?? "";
  if (organization.startsWith("invalid")) return { status: "rejected" };
  if (organization.startsWith("offline")) return { status: "unknown" };
  return { status: "valid", account: `mock.user@${organization}.example` };
}

/** The organizations with a saved token, sorted. */
export function savedAzureDevOpsOrganizations(tokens: Readonly<Record<string, unknown>>) {
  return Object.entries(tokens)
    .filter(([, value]) => (typeof value === "string" ? value.length > 0 : value !== undefined))
    .map(([organization]) => organization)
    .toSorted();
}

/**
 * The discovery item the header shows: a working token makes Azure DevOps usable even when the
 * `az` login is missing or signed out.
 */
export function withAzureDevOpsPatAuth<
  Item extends {
    readonly status: "available" | "missing";
    readonly auth: SourceControlProviderAuth;
  },
>(
  item: Item,
  tokens: Readonly<Record<string, unknown>>,
  describe: (workingTokens: number) => string,
): Item {
  if (item.auth.status === "authenticated") return item;
  const working = savedAzureDevOpsOrganizations(tokens).filter(
    (organization) => checkAzureDevOpsPat(organization).status === "valid",
  ).length;
  if (working === 0) return item;
  return {
    ...item,
    status: "available",
    auth: {
      status: "authenticated",
      account: Option.none(),
      host: Option.none(),
      detail: Option.some(describe(working)),
    },
  };
}

// FAKE: screenshot states driven by localStorage `azfake`, remove before commit.
export function fakeAzureDevOpsState(): {
  readonly cli: "signedIn" | "signedOut" | "missing";
  readonly tokens: Readonly<Record<string, unknown>>;
} | null {
  try {
    const raw = globalThis.localStorage?.getItem("azfake");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
