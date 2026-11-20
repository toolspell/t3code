import type {
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { isAzureDevOpsServicesUrl } from "../shared/definition.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";

type AccountEntry = NonNullable<SourceControlProviderAuth["accounts"]>[number];

/** The REST API version every call is written against; Azure DevOps Server 2022.1 and later. */
const REQUIRED_API_VERSION = [7, 1] as const;
const CHECK_TIMEOUT = Duration.seconds(15);

/**
 * Scopes a token needs, by the read request that proves each. Write access cannot be shown
 * without writing, so the settings hint names the write scopes.
 */
const SCOPE_PROBES = [
  { scope: "code", required: true, path: "_apis/git/repositories", query: { $top: 1 } },
  { scope: "work-items", required: false, path: "_apis/wit/fields", query: { $top: 1 } },
  {
    scope: "project-and-team",
    required: false,
    path: "_apis/teams",
    query: { $top: 1 },
    apiVersion: "7.1-preview",
  },
] as const;

/**
 * Error codes on an organization's entry; clients turn them into text.
 * `missing-scopes:` lists scope ids, `unsupported-version:` the highest version the server offers.
 */
const TOKEN_ERROR = {
  rejected: "rejected",
  organizationNotFound: "organization-not-found",
  notAzureDevOps: "not-azure-devops",
  unreachable: "unreachable",
  secretUnresolved: "secret-unresolved",
  unsupportedVersion: (version: string) => `unsupported-version:${version}`,
  missingScopes: (scopes: ReadonlyArray<string>) => `missing-scopes:${scopes.join(",")}`,
} as const;

const Viewer = Schema.Struct({
  authenticatedUser: Schema.Struct({
    id: Schema.String,
    providerDisplayName: Schema.optional(Schema.String),
  }),
});

const Locations = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({ area: Schema.String, resourceName: Schema.String, maxVersion: Schema.String }),
  ),
});

function versionParts(version: string): ReadonlyArray<number> {
  return version
    .split(/[.-]/u)
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function supportsRequiredVersion(version: string): boolean {
  const [major = 0, minor = 0] = versionParts(version);
  return (
    major > REQUIRED_API_VERSION[0] ||
    (major === REQUIRED_API_VERSION[0] && minor >= REQUIRED_API_VERSION[1])
  );
}

function organizationName(organizationUrl: string): string {
  const url = URL.parse(organizationUrl);
  const last = url?.pathname.split("/").findLast(Boolean);
  if (last === undefined) return url?.hostname ?? organizationUrl;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Whether a failed probe means the token lacks the scope, as opposed to any other trouble. */
const isScopeDenial = (error: { readonly _tag: string; readonly reason?: string }) =>
  error._tag === "AzureDevOpsRestError" &&
  (error.reason === "scope" || error.reason === "authentication" || error.reason === "permission");

/** An organization whose saved token is a secret reference the server could not read. */
export function unresolvedSecretAccount(organizationUrl: string): AccountEntry {
  return {
    host: organizationUrl,
    account: organizationName(organizationUrl),
    active: false,
    authenticated: false,
    error: TOKEN_ERROR.secretUnresolved,
  };
}

/** Checks one organization's token: who it signs in as, the API version, and its read scopes. */
export const checkOrganizationToken = Effect.fn("AzureDevOpsTokenCheck.organization")(function* (
  organizationUrl: string,
  token: Redacted.Redacted<string>,
) {
  const rest = yield* AzureDevOpsRest.AzureDevOpsRest;
  const base = { organizationUrl, token };
  const entry = (
    fields: Partial<AccountEntry> & Pick<AccountEntry, "authenticated">,
  ): AccountEntry => ({
    host: organizationUrl,
    account: organizationName(organizationUrl),
    active: false,
    ...fields,
  });

  const check = Effect.gen(function* () {
    // Any https URL with a path passes for a collection, so a server is asked, without the
    // token, whether it is Azure DevOps before the token goes to it.
    if (!isAzureDevOpsServicesUrl(organizationUrl)) {
      const server = yield* rest.identify(organizationUrl);
      if (server !== "azure-devops") {
        return entry({
          authenticated: false,
          error: server === "other" ? TOKEN_ERROR.notAzureDevOps : TOKEN_ERROR.unreachable,
        });
      }
    }
    const viewer = yield* rest
      .json(
        {
          ...base,
          operation: "tokenCheck.viewer",
          path: "_apis/connectionData",
          apiVersion: "7.1-preview",
        },
        Viewer,
      )
      .pipe(Effect.result);
    if (viewer._tag === "Failure") {
      return entry({
        authenticated: false,
        error: isScopeDenial(viewer.failure)
          ? TOKEN_ERROR.rejected
          : // Azure answers an organization that does not exist with 404, whatever the token.
            viewer.failure._tag === "AzureDevOpsRestError" && viewer.failure.reason === "not-found"
            ? TOKEN_ERROR.organizationNotFound
            : TOKEN_ERROR.unreachable,
      });
    }
    const user = viewer.success.authenticatedUser;
    const account = user.providerDisplayName?.trim() || organizationName(organizationUrl);

    const locations = yield* rest
      .json(
        {
          ...base,
          operation: "tokenCheck.version",
          method: "OPTIONS",
          path: "_apis/git/pullrequests",
        },
        Locations,
      )
      .pipe(Effect.option);
    const offered = Option.match(locations, {
      onNone: () => [],
      onSome: (answer) =>
        answer.value
          .filter(
            (location) =>
              location.area.toLowerCase() === "git" &&
              location.resourceName.toLowerCase() === "pullrequests",
          )
          .map((location) => location.maxVersion),
    });
    const highest = offered.toSorted((left, right) => {
      const [lm = 0, ln = 0] = versionParts(left);
      const [rm = 0, rn = 0] = versionParts(right);
      return rm - lm || rn - ln;
    })[0];
    if (highest !== undefined && !supportsRequiredVersion(highest)) {
      return entry({
        account,
        authenticated: false,
        error: TOKEN_ERROR.unsupportedVersion(highest),
      });
    }

    const probes = [
      ...SCOPE_PROBES.map(({ scope, required, ...request }) => ({ scope, required, request })),
      {
        scope: "identity",
        required: false,
        request: {
          area: "ims",
          path: "_apis/identities",
          query: { identityIds: user.id, queryMembership: "None" },
        },
      },
    ].map(({ scope, required, request }) =>
      rest.request({ ...base, operation: `tokenCheck.${scope}`, ...request }).pipe(
        Effect.as(true),
        // Anything but a denial, such as a timeout, says nothing about the scope.
        Effect.catch((error) => Effect.succeed(!isScopeDenial(error))),
        Effect.map((granted) => ({ scope, required, granted })),
      ),
    );
    const results = yield* Effect.all(probes, { concurrency: "unbounded" });
    const missing = results.filter((result) => !result.granted);
    if (missing.length === 0) return entry({ account, authenticated: true });
    return entry({
      account,
      authenticated: !missing.some((result) => result.required),
      error: TOKEN_ERROR.missingScopes(missing.map((result) => result.scope)),
    });
  });

  return yield* check.pipe(
    Effect.timeout(CHECK_TIMEOUT),
    Effect.orElseSucceed(() => entry({ authenticated: false, error: TOKEN_ERROR.unreachable })),
  );
});

/**
 * Adds the organizations' token checks to what the `az` probe found. A working token makes Azure
 * DevOps usable even when `az` is missing or signed out; a signed-in `az` keeps its own account.
 */
export function withTokenAccounts(
  cli: SourceControlProviderDiscoveryItem,
  accounts: ReadonlyArray<AccountEntry>,
): SourceControlProviderDiscoveryItem {
  if (accounts.length === 0) return cli;
  if (cli.auth.status === "authenticated" || !accounts.some((entry) => entry.authenticated)) {
    return { ...cli, auth: { ...cli.auth, accounts } };
  }
  return {
    ...cli,
    status: "available",
    auth: {
      status: "authenticated",
      account: Option.none(),
      host: Option.none(),
      detail: Option.none(),
      accounts,
    },
  };
}
