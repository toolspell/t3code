import { assert, it } from "@effect/vitest";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";

const ORGANIZATION = "https://dev.azure.com/contoso";
const token = Redacted.make("secret-pat");

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = AzureDevOpsRest.layer.pipe(
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
        }),
      ),
    ),
  );
  return { requests, layer };
}

const read = (path: string, extra: Partial<AzureDevOpsRest.AzureDevOpsRestRequest> = {}) =>
  AzureDevOpsRest.AzureDevOpsRest.use((rest) =>
    rest.request({ organizationUrl: ORGANIZATION, token, operation: "test", path, ...extra }),
  );

it.effect("sends the token, suppresses the sign-in redirect, and escapes query values", () => {
  const { requests, layer } = harness(() => Response.json({ value: [] }));
  return Effect.gen(function* () {
    yield* read("project/_apis/git/repositories/repo/pullrequests", {
      query: { "searchCriteria.sourceRefName": "refs/heads/fix#1&2", $top: 5, skip: undefined },
    });
    const [request] = requests;
    const url = new URL(request!.url);
    assert.strictEqual(url.searchParams.get("searchCriteria.sourceRefName"), "refs/heads/fix#1&2");
    assert.strictEqual(url.searchParams.get("api-version"), "7.1");
    assert.isFalse(url.searchParams.has("skip"));
    assert.strictEqual(
      request!.headers.authorization,
      `Basic ${Buffer.from(":secret-pat").toString("base64")}`,
    );
    assert.strictEqual(request!.headers["x-tfs-fedauthredirect"], "Suppress");
  }).pipe(Effect.provide(layer));
});

it.effect("classifies Azure DevOps failures and keeps Azure's message", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [Response, AzureDevOpsRest.AzureDevOpsRestErrorReason]> = [
      [
        new Response("<html>Sign in</html>", {
          status: 203,
          headers: { "content-type": "text/html" },
        }),
        "authentication",
      ],
      [new Response(null, { status: 401 }), "authentication"],
      [
        Response.json(
          { message: "TF401027: You need the Git 'Contribute' permission." },
          { status: 403 },
        ),
        "permission",
      ],
      [
        Response.json({ message: "TF401019: The Git repository does not exist." }, { status: 404 }),
        "not-found",
      ],
      [Response.json({ message: "Invalid argument value." }, { status: 400 }), "response"],
    ];
    for (const [response, reason] of cases) {
      const { layer } = harness(() => response);
      const error = yield* Effect.flip(
        read("_apis/git/pullrequests/1").pipe(Effect.provide(layer)),
      );
      assert.strictEqual(error._tag, "AzureDevOpsRestError");
      if (error._tag !== "AzureDevOpsRestError") continue;
      assert.strictEqual(error.reason, reason);
      assert.notInclude(error.message, "secret-pat");
    }
    const { layer } = harness(() =>
      Response.json({ message: "TF401019: The Git repository does not exist." }, { status: 404 }),
    );
    const notFound = yield* Effect.flip(
      read("_apis/git/pullrequests/1").pipe(Effect.provide(layer)),
    );
    assert.include(notFound.message, "TF401019");
  }),
);

it.effect(
  "pauses background reads after a block until Retry-After, but lets writes through",
  () => {
    let blocked = true;
    const { requests, layer } = harness(() =>
      blocked
        ? Response.json(
            { message: "TF400733: The request has been canceled: Request was blocked." },
            { status: 429, headers: { "retry-after": "30" } },
          )
        : Response.json({ value: [] }),
    );
    return Effect.gen(function* () {
      const first = yield* Effect.flip(read("_apis/projects"));
      assert.strictEqual(first._tag === "AzureDevOpsRestError" && first.reason, "rate-limited");
      assert.strictEqual(first._tag === "AzureDevOpsRestError" && first.retryAt, 30_000);

      blocked = false;
      const paused = yield* Effect.flip(read("_apis/projects"));
      assert.strictEqual(paused._tag, "SourceControlRateLimitPausedError");
      assert.strictEqual(requests.length, 1);

      yield* read("project/_apis/wit/workitems/1", { method: "PATCH", body: [] });
      yield* read("_apis/projects").pipe(
        Effect.provideService(SourceControlRateLimit.Interactive, true),
      );
      assert.strictEqual(requests.length, 3);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("honors Retry-After on a successful answer", () => {
  let first = true;
  const { requests, layer } = harness(() => {
    const headers: Record<string, string> = first ? { "retry-after": "5" } : {};
    first = false;
    return Response.json({ value: [] }, { headers });
  });
  return Effect.gen(function* () {
    yield* read("_apis/projects");
    const paused = yield* Effect.flip(read("_apis/projects"));
    assert.strictEqual(paused._tag, "SourceControlRateLimitPausedError");
    assert.strictEqual(requests.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "resolves an area's host once per organization and falls back to the organization",
  () => {
    const { requests, layer } = harness((request) =>
      new URL(request.url).pathname.endsWith("/_apis/resourceAreas")
        ? Response.json({
            value: [{ name: "ims", locationUrl: "https://vssps.dev.azure.com/contoso/" }],
          })
        : Response.json({ value: [] }),
    );
    return Effect.gen(function* () {
      yield* read("_apis/identities", { area: "ims" });
      yield* read("_apis/identities", { area: "IMS" });
      yield* read("_apis/tags", { area: "unlisted" });
      assert.deepStrictEqual(
        requests.map((request) => new URL(request.url).origin + new URL(request.url).pathname),
        [
          "https://dev.azure.com/contoso/_apis/resourceAreas",
          "https://vssps.dev.azure.com/contoso/_apis/identities",
          "https://vssps.dev.azure.com/contoso/_apis/identities",
          "https://dev.azure.com/contoso/_apis/tags",
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("decodes JSON answers and reports a body that does not match", () => {
  const { layer } = harness(() => Response.json({ id: 7, title: "Fix" }));
  const PullRequest = Schema.Struct({ id: Schema.Number, title: Schema.String });
  const Mismatch = Schema.Struct({ id: Schema.String });
  return Effect.gen(function* () {
    const rest = yield* AzureDevOpsRest.AzureDevOpsRest;
    const input = {
      organizationUrl: ORGANIZATION,
      token,
      operation: "getPullRequest",
      path: "_apis/git/pullrequests/7",
    };
    assert.deepStrictEqual(yield* rest.json(input, PullRequest), { id: 7, title: "Fix" });
    const error = yield* Effect.flip(rest.json(input, Mismatch));
    assert.strictEqual(error._tag === "AzureDevOpsRestError" && error.reason, "response");
  }).pipe(Effect.provide(layer));
});

it.effect("tells a token missing a scope from a revoked one", () =>
  Effect.gen(function* () {
    for (const [tokenValid, reason] of [
      [true, "scope"],
      [false, "authentication"],
    ] as const) {
      const { layer } = harness((request) =>
        new URL(request.url).pathname.endsWith("/_apis/connectionData") && tokenValid
          ? Response.json({ authenticatedUser: { id: "user" } })
          : new Response(null, { status: 401 }),
      );
      const error = yield* Effect.flip(
        read("project/_apis/wit/workitems/1").pipe(Effect.provide(layer)),
      );
      assert.strictEqual(error._tag === "AzureDevOpsRestError" && error.reason, reason);
    }
  }),
);
