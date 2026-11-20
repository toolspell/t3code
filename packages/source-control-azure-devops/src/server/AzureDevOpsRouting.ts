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

/** An organization with a saved token talks REST; every other one keeps the Azure CLI. */
export type AzureDevOpsRoute =
  | {
      readonly _tag: "Rest";
      /** `https://dev.azure.com/{org}`, lower-case, as tokens are saved. */
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

export class AzureDevOpsRouting extends Context.Service<
  AzureDevOpsRouting,
  {
    /** Read fresh on each call, so a token saved or removed in Settings applies at once. */
    readonly resolve: (input: {
      readonly cwd: string;
      /** The remote T3 selected; without one, the checkout's primary remote decides. */
      readonly remoteUrl?: string | undefined;
    }) => Effect.Effect<AzureDevOpsRoute, AzureDevOpsTokenUnavailableError>;
    /**
     * The route for an organization URL such as `https://dev.azure.com/{org}` or
     * `https://{org}.visualstudio.com`; any other host keeps the Azure CLI.
     */
    readonly resolveOrganization: (
      organizationUrl: string,
    ) => Effect.Effect<AzureDevOpsOrganizationRoute, AzureDevOpsTokenUnavailableError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsRouting") {}

const CLI: AzureDevOpsRoute = { _tag: "Cli" };

const tokenKey = (organizationUrl: string) =>
  organizationUrl.trim().replace(/\/+$/u, "").toLowerCase();

/** `https://dev.azure.com/{org}` for an organization URL in either form, or null for another host. */
function organizationTokenKey(organizationUrl: string): string | null {
  const url = URL.parse(organizationUrl.trim());
  if (url === null) return null;
  const host = url.hostname.toLowerCase();
  const legacy = /^([^.]+)\.visualstudio\.com$/u.exec(host);
  if (legacy !== null) return tokenKey(`https://dev.azure.com/${legacy[1]}`);
  const [organization] = url.pathname.split("/").filter((part) => part.length > 0);
  return host === "dev.azure.com" && organization !== undefined
    ? tokenKey(`https://dev.azure.com/${organization}`)
    : null;
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
      Object.entries(tokens).flatMap(([organizationUrl, value]) =>
        (typeof value === "string" ? value.trim() === "" : value === undefined)
          ? []
          : [[tokenKey(organizationUrl), value] as const],
      ),
    );
    return saved.size === 0 ? null : { saved, secretProviders: settings.value.secretProviders };
  });

  const restRoute = (
    tokens: NonNullable<Effect.Success<typeof savedTokens>>,
    organizationUrl: string,
  ) => {
    const value = tokens.saved.get(organizationUrl);
    return value === undefined
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

  const resolve: AzureDevOpsRouting["Service"]["resolve"] = Effect.fn("AzureDevOpsRouting.resolve")(
    function* (input) {
      const tokens = yield* savedTokens;
      // Without any saved token, no `git remote` runs and nothing changes for `az` users.
      if (tokens === null) return CLI;

      const remoteUrl = input.remoteUrl ?? (yield* checkoutRemoteUrl(host.process, input.cwd));
      const scope = remoteUrl === null ? null : scopeFromRemoteUrl(remoteUrl);
      if (scope === null) return CLI;
      // Legacy `{org}.visualstudio.com` remotes share the organization's dev.azure.com token.
      const route = yield* restRoute(
        tokens,
        tokenKey(`https://dev.azure.com/${encodeURIComponent(scope.organizationName)}`),
      );
      return route === null
        ? CLI
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
    const tokens = yield* savedTokens;
    const key = tokens === null ? null : organizationTokenKey(organizationUrl);
    if (tokens === null || key === null) return CLI;
    return (yield* restRoute(tokens, key)) ?? CLI;
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
