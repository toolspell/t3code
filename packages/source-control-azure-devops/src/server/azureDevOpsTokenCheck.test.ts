import { assert, it } from "@effect/vitest";
import type { SourceControlProviderDiscoveryItem } from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import { checkOrganizationToken, withTokenAccounts } from "./azureDevOpsTokenCheck.ts";

const ORGANIZATION = "https://dev.azure.com/contoso";

const pullRequestLocations = (maxVersion: string) =>
  Response.json({ value: [{ area: "git", resourceName: "pullRequests", maxVersion }] });

function layerFor(
  respond: (path: string, request: HttpClientRequest.HttpClientRequest) => Response,
) {
  return AzureDevOpsRest.layer.pipe(
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, respond(new URL(request.url).pathname, request)),
          ),
        ),
      ),
    ),
  );
}

/** A token that passes every check, overridden per path. */
const answer =
  (overrides: Readonly<Record<string, () => Response>> = {}) =>
  (path: string) => {
    const name = path.replace(/^\/contoso/u, "");
    const override = overrides[name];
    if (override) return override();
    if (name === "/_apis/connectionData") {
      return Response.json({
        authenticatedUser: { id: "user-1", providerDisplayName: "Sabine Test" },
      });
    }
    if (name === "/_apis/git/pullrequests") return pullRequestLocations("7.2");
    if (name === "/_apis/resourceAreas") return Response.json({ value: [] });
    return Response.json({ value: [] });
  };

const check = (respond: (path: string, request: HttpClientRequest.HttpClientRequest) => Response) =>
  checkOrganizationToken(ORGANIZATION, Redacted.make("pat")).pipe(
    Effect.provide(layerFor(respond)),
  );

const denied = () => new Response(null, { status: 401 });

it.effect("reports who a working token signs in as", () =>
  Effect.gen(function* () {
    const entry = yield* check(answer());
    assert.deepStrictEqual(entry, {
      host: ORGANIZATION,
      account: "Sabine Test",
      active: false,
      authenticated: true,
    });
  }),
);

it.effect("tells a rejected token, an old server and missing scopes apart", () =>
  Effect.gen(function* () {
    const rejected = yield* check(() => denied());
    assert.deepStrictEqual([rejected.authenticated, rejected.error], [false, "rejected"]);

    const oldServer = yield* check(
      answer({ "/_apis/git/pullrequests": () => pullRequestLocations("7.0") }),
    );
    assert.deepStrictEqual(
      [oldServer.authenticated, oldServer.error],
      [false, "unsupported-version:7.0"],
    );

    const noCode = yield* check(answer({ "/_apis/git/repositories": denied }));
    assert.deepStrictEqual([noCode.authenticated, noCode.error], [false, "missing-scopes:code"]);

    const optional = yield* check(
      answer({ "/_apis/wit/fields": denied, "/_apis/identities": denied }),
    );
    assert.deepStrictEqual(
      [optional.authenticated, optional.error],
      [true, "missing-scopes:work-items,identity"],
    );

    const unknownOrganization = yield* check(
      () => new Response("The resource cannot be found.", { status: 404 }),
    );
    assert.deepStrictEqual(
      [unknownOrganization.authenticated, unknownOrganization.error],
      [false, "organization-not-found"],
    );

    const down = yield* check(() => new Response("upstream", { status: 503 }));
    assert.deepStrictEqual([down.authenticated, down.error], [false, "unreachable"]);
  }),
);

// Unauthenticated answers as the testbed's Azure DevOps Server 2022 and github.com gave them.
it.effect.each([
  {
    server: "an Azure DevOps Server refusing anonymous access",
    anonymous: () =>
      Response.json(
        { message: "TF400813: Resource not available for anonymous access." },
        { status: 401, headers: { "x-tfs-processid": "e962d66f", "x-vss-e2eid": "b245b74a" } },
      ),
    error: undefined,
  },
  {
    server: "an Azure DevOps Server answering with its sign-in page",
    anonymous: () =>
      new Response("<html></html>", {
        status: 203,
        headers: { "content-type": "text/html", "X-TFS-ProcessId": "e962d66f" },
      }),
    error: undefined,
  },
  {
    server: "a host that is not Azure DevOps",
    anonymous: () => Response.json({ error: "Not Found" }, { status: 404 }),
    error: "not-azure-devops",
  },
  {
    server: "a host that does not answer",
    anonymous: () => {
      throw new Error("connect ECONNREFUSED");
    },
    error: "unreachable",
  },
])("asks $server, without the token, before checking a collection", ({ anonymous, error }) =>
  Effect.gen(function* () {
    const collection = "https://ado.example/second%20collection";
    const seen: Array<{ path: string; authorization: string | undefined }> = [];
    const respond = answer();
    const layer = AzureDevOpsRest.layer.pipe(
      Layer.provide(SourceControlRateLimit.layer),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            const authorization = request.headers.authorization;
            seen.push({ path: url.pathname, authorization });
            return Effect.try({
              try: () =>
                HttpClientResponse.fromWeb(
                  request,
                  authorization === undefined
                    ? anonymous()
                    : respond(url.pathname.replace(/^\/second%20collection/u, "")),
                ),
              catch: (cause) =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request, cause }),
                }),
            });
          }),
        ),
      ),
    );
    const entry = yield* checkOrganizationToken(collection, Redacted.make("pat")).pipe(
      Effect.provide(layer),
    );
    assert.deepStrictEqual(seen[0], {
      path: "/second%20collection/_apis/connectionData",
      authorization: undefined,
    });
    if (error === undefined) {
      assert.deepStrictEqual([entry.authenticated, entry.account], [true, "Sabine Test"]);
    } else {
      assert.deepStrictEqual(
        [entry.authenticated, entry.error, entry.account],
        [false, error, "second collection"],
      );
      assert.strictEqual(seen.length, 1);
    }
  }),
);

it("lets a working token make Azure DevOps usable without az", () => {
  const cli: SourceControlProviderDiscoveryItem = {
    kind: SourceControlProviderKind.make("azure-devops"),
    label: "Azure DevOps",
    executable: "az",
    status: "missing",
    version: Option.none(),
    installHint: "Install az",
    detail: Option.none(),
    auth: { status: "unknown", account: Option.none(), host: Option.none(), detail: Option.none() },
  };
  const working = {
    host: ORGANIZATION,
    account: "Sabine Test",
    active: false,
    authenticated: true,
  };
  const failing = { ...working, authenticated: false, error: "rejected" };

  assert.strictEqual(withTokenAccounts(cli, []), cli);
  const usable = withTokenAccounts(cli, [failing, working]);
  assert.deepStrictEqual([usable.status, usable.auth.status], ["available", "authenticated"]);
  assert.deepStrictEqual(usable.auth.accounts, [failing, working]);

  const stillMissing = withTokenAccounts(cli, [failing]);
  assert.deepStrictEqual([stillMissing.status, stillMissing.auth.status], ["missing", "unknown"]);

  const signedIn = {
    ...cli,
    status: "available" as const,
    auth: { ...cli.auth, status: "authenticated" as const, account: Option.some("az user") },
  };
  assert.deepStrictEqual(
    withTokenAccounts(signedIn, [working]).auth.account,
    Option.some("az user"),
  );
});
