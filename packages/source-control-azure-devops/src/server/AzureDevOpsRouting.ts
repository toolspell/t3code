import { requireSettingsSecretLiteral, SettingsSecretUnresolvedError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as AzureDevOpsClient from "../shared/definition.ts";
import { checkoutRemoteUrl, scopeFromRemoteUrl } from "./AzureDevOpsCli.ts";

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
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsRouting") {}

const CLI: AzureDevOpsRoute = { _tag: "Cli" };

const tokenKey = (organizationUrl: string) =>
  organizationUrl.trim().replace(/\/+$/u, "").toLowerCase();

/** @public */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;

  const resolve: AzureDevOpsRouting["Service"]["resolve"] = Effect.fn("AzureDevOpsRouting.resolve")(
    function* (input) {
      const settings = yield* host.settings
        .getWithSecrets(AzureDevOpsClient.definition.kind)
        .pipe(Effect.option);
      if (settings._tag === "None") return CLI;
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
      // Without any saved token, no `git remote` runs and nothing changes for `az` users.
      if (saved.size === 0) return CLI;

      const remoteUrl = input.remoteUrl ?? (yield* checkoutRemoteUrl(host.process, input.cwd));
      const scope = remoteUrl === null ? null : scopeFromRemoteUrl(remoteUrl);
      if (scope === null) return CLI;
      // Legacy `{org}.visualstudio.com` remotes share the organization's dev.azure.com token.
      const organizationUrl = tokenKey(
        `https://dev.azure.com/${encodeURIComponent(scope.organizationName)}`,
      );
      const value = saved.get(organizationUrl);
      if (value === undefined) return CLI;

      const token = yield* requireSettingsSecretLiteral(value, settings.value.secretProviders).pipe(
        Effect.mapError(
          (cause) => new AzureDevOpsTokenUnavailableError({ organizationUrl, cause }),
        ),
      );
      return {
        _tag: "Rest",
        organizationUrl,
        token: Redacted.make(token.trim()),
        project: scope.project,
        repository: scope.repository,
      } satisfies AzureDevOpsRoute;
    },
  );

  return AzureDevOpsRouting.of({ resolve });
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
