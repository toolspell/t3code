import { requireSettingsSecretLiteral, SettingsSecretUnresolvedError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as AzureDevOpsClient from "../shared/definition.ts";
import { checkoutRemoteUrl, scopeFromRemoteUrl } from "./azureDevOpsRemote.ts";

/**
 * An organization or collection with a saved token talks REST. Without one, an Azure DevOps
 * Services organization keeps the Azure CLI; an Azure DevOps Server collection, which `az`
 * refuses, fails with `AzureDevOpsTokenRequiredError`.
 */
export type AzureDevOpsRoute =
  | {
      readonly _tag: "Rest";
      /** The organization or collection URL, as `azureDevOpsOrganizationUrl` keys tokens. */
      readonly organizationUrl: string;
      readonly token: Redacted.Redacted<string>;
      readonly project: string;
      readonly repository: string;
    }
  | { readonly _tag: "Cli" };

export type AzureDevOpsRestRoute = Extract<AzureDevOpsRoute, { readonly _tag: "Rest" }>;

/** The route for a whole organization, where no repository is involved. */
export type AzureDevOpsOrganizationRoute =
  | Pick<AzureDevOpsRestRoute, "_tag" | "organizationUrl" | "token">
  | { readonly _tag: "Cli" };

/** What every REST request on the route carries. */
export const credentials = (route: Pick<AzureDevOpsRestRoute, "organizationUrl" | "token">) => ({
  organizationUrl: route.organizationUrl,
  token: route.token,
});

/** The organization has a saved token the server cannot read; it must not fall back to `az`. */
export class AzureDevOpsTokenUnavailableError extends Schema.TaggedError<AzureDevOpsTokenUnavailableError>()(
  "AzureDevOpsTokenUnavailableError",
  {
    organizationUrl: Schema.String,
    cause: SettingsSecretUnresolvedError,
  },
) {
  get detail(): string {
    return `The personal access token saved for ${this.organizationUrl} could not be read. ${this.cause.message}`;
  }

  override get message(): string {
    return `Azure DevOps failed: ${this.detail}`;
  }
}

/** An Azure DevOps Server collection without a saved token: `az` cannot reach a server. */
export class AzureDevOpsTokenRequiredError extends Schema.TaggedError<AzureDevOpsTokenRequiredError>()(
  "AzureDevOpsTokenRequiredError",
  { organizationUrl: Schema.String },
) {
  get detail(): string {
    return `Azure DevOps Server needs a personal access token for ${AzureDevOpsClient.azureDevOpsOrganizationLabel(this.organizationUrl)}; save one in Settings → Source control & issues.`;
  }

  override get message(): string {
    return `Azure DevOps failed: ${this.detail}`;
  }
}

export type AzureDevOpsRouteError =
  | AzureDevOpsTokenUnavailableError
  | AzureDevOpsTokenRequiredError;

export class AzureDevOpsRouting extends Context.Service<
  AzureDevOpsRouting,
  {
    /** Read fresh on each call, so a token saved or removed in Settings applies at once. */
    readonly resolve: (input: {
      readonly cwd: string;
      /** The remote T3 selected; without one, the checkout's primary remote decides. */
      readonly remoteUrl?: string | undefined;
    }) => Effect.Effect<AzureDevOpsRoute, AzureDevOpsRouteError>;
    /**
     * The route for an organization or collection URL such as `https://dev.azure.com/{org}`,
     * `https://{org}.visualstudio.com` or `https://{server}/{collection}`.
     */
    readonly resolveOrganization: (
      organizationUrl: string,
    ) => Effect.Effect<AzureDevOpsOrganizationRoute, AzureDevOpsRouteError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsRouting") {}

const CLI: AzureDevOpsRoute = { _tag: "Cli" };

/**
 * The saved key for an organization or collection. Without a known https port, as from an SSH or
 * http remote, it takes the one key saved for its host and collection path, at any port.
 */
function savedKey(
  saved: ReadonlyMap<string, unknown>,
  organizationUrl: string,
  webPortKnown: boolean,
): string | undefined {
  if (saved.has(organizationUrl) || webPortKnown) return organizationUrl;
  const wanted = new URL(organizationUrl);
  const matches = [...saved.keys()].filter((key) => {
    const url = new URL(key);
    return url.hostname === wanted.hostname && url.pathname === wanted.pathname;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** @public */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;

  const savedTokens = Effect.gen(function* () {
    const settings = yield* host.settings
      .getWithSecrets(AzureDevOpsClient.definition.kind)
      .pipe(Effect.option);
    if (settings._tag === "None") return null;
    const { tokens } = readSourceControlHostSettings(
      AzureDevOpsClient.settings,
      settings.value.sourceControlHosts[AzureDevOpsClient.definition.kind],
    );
    const saved = new Map(
      Object.entries(tokens).flatMap(([organizationUrl, value]) => {
        // A key that is no https organization or collection URL never gets a request.
        const key = AzureDevOpsClient.azureDevOpsOrganizationUrl(organizationUrl);
        return key === null ||
          (typeof value === "string" ? value.trim() === "" : value === undefined)
          ? []
          : [[key, value] as const];
      }),
    );
    return saved.size === 0 ? null : { saved, secretProviders: settings.value.secretProviders };
  });

  const restRoute = (
    tokens: NonNullable<Effect.Success<typeof savedTokens>>,
    organizationUrl: string | null | undefined,
  ) => {
    const value = organizationUrl == null ? undefined : tokens.saved.get(organizationUrl);
    return organizationUrl == null || value === undefined
      ? Effect.succeed(null)
      : requireSettingsSecretLiteral(value, tokens.secretProviders).pipe(
          Effect.map((token) => ({
            _tag: "Rest" as const,
            organizationUrl,
            token: Redacted.make(token.trim()),
          })),
          Effect.mapError(
            (cause) => new AzureDevOpsTokenUnavailableError({ organizationUrl, cause }),
          ),
        );
  };

  /** Where an organization without a usable saved token goes. */
  const withoutToken = (organizationUrl: string) =>
    AzureDevOpsClient.isAzureDevOpsServicesUrl(organizationUrl)
      ? Effect.succeed(CLI)
      : Effect.fail(new AzureDevOpsTokenRequiredError({ organizationUrl }));

  const resolve: AzureDevOpsRouting["Service"]["resolve"] = Effect.fn("AzureDevOpsRouting.resolve")(
    function* (input) {
      const tokens = yield* savedTokens;
      // Without any saved token, no `git remote` runs; `az` itself refuses a server's remote.
      if (tokens === null) return CLI;

      const remoteUrl = input.remoteUrl ?? (yield* checkoutRemoteUrl(host.process, input.cwd));
      const scope = remoteUrl === null ? null : scopeFromRemoteUrl(remoteUrl);
      if (scope === null) return CLI;
      // Legacy `{org}.visualstudio.com` remotes share the organization's dev.azure.com token.
      const route = yield* restRoute(
        tokens,
        savedKey(tokens.saved, scope.organizationUrl, scope.webPortKnown),
      );
      return route === null
        ? yield* withoutToken(scope.organizationUrl)
        : ({
            ...route,
            project: scope.project,
            repository: scope.repository,
          } satisfies AzureDevOpsRoute);
    },
  );

  const resolveOrganization: AzureDevOpsRouting["Service"]["resolveOrganization"] = Effect.fn(
    "AzureDevOpsRouting.resolveOrganization",
  )(function* (organizationUrl) {
    // An http URL never gets a token, but names its server all the same.
    const key = AzureDevOpsClient.azureDevOpsOrganizationUrl(
      organizationUrl.trim().replace(/^http:/iu, "https:"),
    );
    if (key === null) return CLI;
    const tokens = yield* savedTokens;
    const portKnown = URL.parse(key)?.port !== "";
    const route =
      tokens === null ? null : yield* restRoute(tokens, savedKey(tokens.saved, key, portKnown));
    return route ?? (yield* withoutToken(key));
  });

  return AzureDevOpsRouting.of({ resolve, resolveOrganization });
});

export const layer = Layer.effect(AzureDevOpsRouting, make);

/**
 * Runs `rest` for an organization with a saved token and `cli` for any other. Every Azure DevOps
 * operation goes through here, so an organization with a token never reaches `az`.
 */
export const byRoute = <A, E, R, B, F, Q>(
  routing: AzureDevOpsRouting["Service"],
  input: Parameters<AzureDevOpsRouting["Service"]["resolve"]>[0],
  handlers: {
    readonly rest: (route: AzureDevOpsRestRoute) => Effect.Effect<A, E, R>;
    readonly cli: () => Effect.Effect<B, F, Q>;
  },
) =>
  routing
    .resolve(input)
    .pipe(
      Effect.flatMap((route): Effect.Effect<A | B, E | F, R | Q> =>
        route._tag === "Rest" ? handlers.rest(route) : handlers.cli(),
      ),
    );
