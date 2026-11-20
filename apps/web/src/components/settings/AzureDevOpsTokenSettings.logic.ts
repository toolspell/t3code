import { azureDevOpsOrganizationUrl } from "@t3tools/client-runtime/source-control-clients";
import type { SourceControlProviderAuth } from "@t3tools/contracts";
import * as Option from "effect/Option";

/** A saved organization or collection URL as the list shows it: `host/path`, unescaped. */
export function azureDevOpsOrganizationLabel(organizationUrl: string): string {
  const label = organizationUrl.replace(/^https:\/\//u, "");
  try {
    return decodeURIComponent(label);
  } catch {
    return label;
  }
}

export function azureDevOpsNewTokenUrl(organizationUrl: string): string {
  return `${organizationUrl}/_usersSettings/tokens`;
}

/** The organizations with a saved token, sorted. */
export function savedAzureDevOpsOrganizations(tokens: Readonly<Record<string, unknown>>) {
  return Object.entries(tokens)
    .filter(([, value]) => (typeof value === "string" ? value.length > 0 : value !== undefined))
    .map(([organization]) => organization)
    .toSorted();
}

/** Scope ids the server reports, by the name Azure DevOps shows when creating a token. */
export const AZURE_DEVOPS_SCOPE_NAMES: Readonly<Record<string, string>> = {
  code: "Code",
  "work-items": "Work Items",
  identity: "Identity",
  "project-and-team": "Project and Team",
};

export type AzureDevOpsTokenCheck =
  | {
      readonly status: "valid";
      readonly account: string;
      readonly missingScopes: ReadonlyArray<string>;
    }
  | { readonly status: "missing-scopes"; readonly scopes: ReadonlyArray<string> }
  | { readonly status: "unsupported-version"; readonly version: string }
  | {
      readonly status:
        | "rejected"
        | "organization-not-found"
        | "not-azure-devops"
        | "secret-unresolved"
        | "unreachable"
        | "not-checked";
    };

/** The server's check of one organization's token, from the discovery item's accounts. */
export function azureDevOpsTokenCheck(
  auth: SourceControlProviderAuth,
  organizationUrl: string,
): AzureDevOpsTokenCheck {
  const key = azureDevOpsOrganizationUrl(organizationUrl);
  const entry = auth.accounts?.find(
    (account) => key !== null && azureDevOpsOrganizationUrl(account.host) === key,
  );
  if (entry === undefined) return { status: "not-checked" };
  const separator = (entry.error ?? "").indexOf(":");
  const code = separator === -1 ? (entry.error ?? "") : entry.error!.slice(0, separator);
  const value = separator === -1 ? "" : entry.error!.slice(separator + 1);
  const scopes = code === "missing-scopes" ? value.split(",").filter(Boolean) : [];
  if (entry.authenticated) {
    return { status: "valid", account: entry.account, missingScopes: scopes };
  }
  if (code === "missing-scopes") return { status: "missing-scopes", scopes };
  if (code === "unsupported-version") return { status: "unsupported-version", version: value };
  if (
    code === "rejected" ||
    code === "organization-not-found" ||
    code === "not-azure-devops" ||
    code === "secret-unresolved"
  ) {
    return { status: code };
  }
  return { status: "unreachable" };
}

/**
 * Names the tokens in the header when they, not the `az` login, sign Azure DevOps in.
 */
export function withAzureDevOpsTokenDetail<
  Item extends { readonly auth: SourceControlProviderAuth },
>(item: Item, describe: (workingTokens: number) => string): Item {
  if (item.auth.status !== "authenticated" || Option.isSome(item.auth.account)) return item;
  const working = item.auth.accounts?.filter((account) => account.authenticated).length ?? 0;
  if (working === 0) return item;
  return { ...item, auth: { ...item.auth, detail: Option.some(describe(working)) } };
}
