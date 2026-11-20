// @effect-diagnostics nodeBuiltinImport:off -- Builds the zip Azure returns and stands in for az writing it.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as AzureDevOpsApi from "./AzureDevOpsApi.ts";
import * as AzureDevOpsPullRequestApi from "./AzureDevOpsPullRequestApi.ts";
import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";

const mockedExecute = vi.fn<AzureDevOpsApi.AzureDevOpsApi["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsPullRequestApi.layer.pipe(
    Layer.provide(
      Layer.mock(AzureDevOpsApi.AzureDevOpsApi)({
        execute: mockedExecute,
      }),
    ),
    // No saved token: every call takes the Azure CLI, and REST must not be reached.
    Layer.provide(AzureDevOpsRouting.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(Layer.mock(AzureDevOpsRest.AzureDevOpsRest)({})),
    Layer.provide(NodeServices.layer),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

const VCS_DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function outputWithin(maxOutputBytes: number | undefined, response: string) {
  const ceiling = maxOutputBytes ?? VCS_DEFAULT_MAX_OUTPUT_BYTES;
  return ceiling >= Buffer.byteLength(response)
    ? output(response)
    : { ...output(response.slice(0, ceiling)), stdoutTruncated: true };
}

const json = (value: Record<string, unknown>) => JSON.stringify(value);

const pullRequestRow = {
  pullRequestId: 42,
  title: "Add the page",
  status: "active",
  sourceRefName: "refs/heads/feat/page",
  targetRefName: "refs/heads/main",
  creationDate: "2026-07-01T00:00:00Z",
  url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
  repository: { name: "web", project: { name: "platform" } },
};

const oneIteration = {
  value: [
    {
      id: 1,
      sourceRefCommit: { commitId: "a".repeat(40) },
      commonRefCommit: { commitId: "b".repeat(40) },
    },
  ],
};

function pullRequestRows(
  count: number,
  firstNumber: number,
): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    pullRequestId: firstNumber + index,
    title: `Pull request ${firstNumber + index}`,
    status: "active",
    sourceRefName: "refs/heads/feat/page",
    targetRefName: "refs/heads/main",
    creationDate: "2026-07-01T00:00:00Z",
    repository: { name: "web", project: { name: "platform" } },
    url: `https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/${firstNumber + index}`,
  }));
}

function pullRequests(count: number, firstNumber: number): string {
  return JSON.stringify(pullRequestRows(count, firstNumber));
}

/** Entries as Azure streams them: data descriptors, with sizes only in the central directory. */
function streamedZip(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly data: Uint8Array;
    readonly stored?: true;
  }>,
): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const method = entry.stored ? 0 : 8;
    const body = entry.stored ? Buffer.from(entry.data) : NodeZlib.deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(entry.data.length, 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body, descriptor);
    directory.push(central, name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

function argsOfCall(index: number): ReadonlyArray<string> {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].args;
}

function changeEntries(count: number): ReadonlyArray<Record<string, unknown>> {
  const commit = "c".repeat(40);
  return Array.from({ length: count }, (_, index) => {
    const path = `/apps/server/src/generated/module-${index}/persisted-projection-${index}.ts`;
    return {
      changeType: "edit",
      item: {
        path,
        objectId: "a".repeat(40),
        originalObjectId: "b".repeat(40),
        commitId: commit,
        gitObjectType: "blob",
        url: `https://dev.azure.com/acme/platform/_apis/git/repositories/6f9c9b7f-0000-0000-0000-000000000000/items${path}?versionType=Commit&version=${commit}`,
      },
    };
  });
}

/**
 * The checkout's remote is in organization `contoso`, project `Web Site`, repository `web app`.
 * `saveToken(false)` runs a call through `execute`, `saveToken(true)` through `respond`.
 */
function routed(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const execute = vi.fn<AzureDevOpsApi.AzureDevOpsApi["Service"]["execute"]>(() =>
    Effect.die("An organization with a saved token must not reach az."),
  );
  const layer = AzureDevOpsPullRequestApi.layer.pipe(
    Layer.provide(Layer.mock(AzureDevOpsApi.AzureDevOpsApi)({ execute })),
    Layer.provide(AzureDevOpsRouting.layer),
    Layer.provide(
      AzureDevOpsRest.layer.pipe(
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
      ),
    ),
    Layer.provideMerge(
      TestSourceControlHost.layer({
        process: {
          run: () =>
            Effect.succeed(
              TestSourceControlHost.processOutput(
                "origin\thttps://dev.azure.com/contoso/Web%20Site/_git/web%20app (fetch)\n",
              ),
            ),
        },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const saveToken = (saved: boolean) =>
    TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
      settings.update({
        sourceControlHosts: {
          "azure-devops": {
            tokens: saved ? { "https://dev.azure.com/contoso": "contoso-pat" } : {},
          },
        },
      }),
    );
  return { requests, execute, layer, saveToken };
}

const urlOf = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  assert.isDefined(request);
  return new URL(request.url);
};

// Azure DevOps Server names a Windows user `max` here and `ADO2022\max` on every pull request.
it.effect.each([
  { account: "bilal@acme.dev", domain: undefined, viewer: "bilal@acme.dev", requests: 1 },
  { account: "ADO2022\\max", domain: undefined, viewer: "ADO2022\\max", requests: 1 },
  { account: "max", domain: "ADO2022", viewer: "ADO2022\\max", requests: 2 },
  { account: "max", domain: undefined, viewer: "max", requests: 2 },
])(
  "names the viewer $account from connectionData as pull requests name them: $viewer",
  ({ account, domain, viewer, requests: count }) => {
    const { requests, execute, layer, saveToken } = routed((request) =>
      new URL(request.url).pathname.endsWith("/_apis/identities")
        ? Response.json({
            value: [{ properties: domain === undefined ? {} : { Domain: { $value: domain } } }],
          })
        : new URL(request.url).pathname.endsWith("/_apis/resourceAreas")
          ? Response.json({ value: [] })
          : Response.json({
              authenticatedUser: {
                id: "c50f0341-3b9a-46d8-81e9-769d2e509704",
                providerDisplayName: "Bilal",
                properties: { Account: { $type: "System.String", $value: account } },
              },
            }),
    );
    return Effect.gen(function* () {
      yield* saveToken(true);
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      assert.strictEqual(yield* cli.getViewer({ cwd: "/w" }), viewer);
      const url = urlOf(requests[0]);
      assert.strictEqual(
        url.origin + url.pathname,
        "https://dev.azure.com/contoso/_apis/connectionData",
      );
      assert.strictEqual(url.searchParams.get("api-version"), "7.1-preview");
      const lookups = requests.filter((request) => request.url.includes("/_apis/identities"));
      assert.strictEqual(lookups.length, count - 1);
      if (lookups[0] !== undefined) {
        assert.strictEqual(
          urlOf(lookups[0]).searchParams.get("identityIds"),
          "c50f0341-3b9a-46d8-81e9-769d2e509704",
        );
      }
      expect(execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  },
);

const restLocation = { project: "Web Site", repository: "web app" };
const restPullRequest = "/contoso/Web%20Site/_apis/git/repositories/web%20app/pullRequests/42";

it.effect.each([
  {
    read: "a pull request",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.getPullRequest({ cwd: "/w", number: 42 }),
    body: { ...pullRequestRow, labels: [{ name: "release-1.0" }] },
    path: "/contoso/_apis/git/pullrequests/42",
    query: {},
  },
  {
    read: "review threads",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.listThreads({ cwd: "/w", location: restLocation, number: 42 }),
    body: {
      value: [
        {
          id: 3,
          threadContext: { filePath: "/src/page.ts" },
          comments: [
            {
              id: 1,
              content: "Rename this",
              author: { uniqueName: "ana@acme.dev", displayName: "Ana" },
              publishedDate: "2026-07-02T00:00:00Z",
            },
          ],
        },
      ],
    },
    path: `${restPullRequest}/threads`,
    query: {},
  },
  {
    read: "labels",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.listLabels({ cwd: "/w", location: restLocation, number: 42 }),
    body: { count: 1, value: [{ id: "4f1c", name: "release-1.0" }] },
    path: `${restPullRequest}/labels`,
    query: {},
  },
  {
    read: "iterations",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.listIterations({ cwd: "/w", location: restLocation, number: 42 }),
    body: oneIteration,
    path: `${restPullRequest}/iterations`,
    query: {},
  },
  {
    read: "an iteration's changes",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.listIterationChanges({ cwd: "/w", location: restLocation, number: 42, iterationId: 2 }),
    body: { changeEntries: changeEntries(2) },
    path: `${restPullRequest}/iterations/2/changes`,
    query: { $top: "2000", $skip: "0" },
  },
  {
    read: "a file",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.readItemContent({
        cwd: "/w",
        location: restLocation,
        path: "docs/a#1&b.md",
        commit: "c".repeat(40),
      }),
    body: { content: "text\n", contentMetadata: { isBinary: false } },
    path: "/contoso/Web%20Site/_apis/git/repositories/web%20app/items",
    query: {
      path: "/docs/a#1&b.md",
      "versionDescriptor.versionType": "commit",
      "versionDescriptor.version": "c".repeat(40),
      includeContent: "true",
      includeContentMetadata: "true",
      $format: "json",
    },
  },
])("reads $read over REST as az reads it", ({ call, body, path, query }) => {
  const { requests, execute, layer, saveToken } = routed(() => Response.json(body));
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;
    execute.mockReturnValue(Effect.succeed(output(JSON.stringify(body))));
    const viaCli = yield* call(cli);
    execute.mockClear();
    yield* saveToken(true);

    assert.deepStrictEqual(yield* call(cli), viaCli);
    expect(execute).not.toHaveBeenCalled();
    const url = urlOf(requests[0]);
    assert.strictEqual(url.pathname, path);
    assert.strictEqual(url.searchParams.get("api-version"), "7.1");
    for (const [name, value] of Object.entries(query)) {
      assert.strictEqual(url.searchParams.get(name), value, name);
    }
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  {
    involvement: "authored",
    author: "ana@acme.dev",
    creatorId: "viewer-id",
    reviewerId: null,
  },
  {
    involvement: "reviewing",
    author: "ana@acme.dev",
    creatorId: "ana-id",
    reviewerId: "viewer-id",
  },
  { involvement: "all", author: undefined, creatorId: null, reviewerId: null },
] as const)(
  "lists $involvement pull requests over REST by the ids az would resolve",
  ({ involvement, author, creatorId, reviewerId }) => {
    const rows = pullRequestRows(3, 1);
    const { requests, execute, layer, saveToken } = routed((request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/_apis/connectionData")) {
        return Response.json({ authenticatedUser: { id: "viewer-id" } });
      }
      if (pathname.endsWith("/_apis/resourceAreas")) return Response.json({ value: [] });
      if (pathname.endsWith("/_apis/identities"))
        return Response.json({ value: [{ id: "ana-id" }] });
      return Response.json({ count: rows.length, value: rows });
    });
    return Effect.gen(function* () {
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;
      const list = cli.listPullRequests({
        cwd: "/w",
        repository: "web app",
        state: "open",
        involvement,
        viewer: "bilal@acme.dev",
        limit: 2,
        author,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 20 },
      });
      execute.mockReturnValue(Effect.succeed(output(JSON.stringify(rows))));
      const viaCli = yield* list;
      execute.mockClear();
      yield* saveToken(true);

      assert.deepStrictEqual(yield* list, viaCli);
      expect(execute).not.toHaveBeenCalled();
      const url = urlOf(requests.at(-1));
      assert.strictEqual(
        url.pathname,
        "/contoso/Web%20Site/_apis/git/repositories/web%20app/pullrequests",
      );
      assert.deepStrictEqual(
        {
          status: url.searchParams.get("searchCriteria.status"),
          creatorId: url.searchParams.get("searchCriteria.creatorId"),
          reviewerId: url.searchParams.get("searchCriteria.reviewerId"),
          includeLinks: url.searchParams.get("searchCriteria.includeLinks"),
          skip: url.searchParams.get("$skip"),
          top: url.searchParams.get("$top"),
        },
        { status: "active", creatorId, reviewerId, includeLinks: "true", skip: "20", top: "3" },
      );
      if (author !== undefined && involvement !== "authored") {
        const lookup = urlOf(requests.find((request) => request.url.includes("/_apis/identities")));
        assert.strictEqual(lookup.searchParams.get("filterValue"), author);
        assert.strictEqual(lookup.searchParams.get("searchFilter"), "General");
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("fails a REST listing by an author no identity matches, as az does", () => {
  const { requests, layer, saveToken } = routed((request) =>
    new URL(request.url).pathname.endsWith("/_apis/resourceAreas")
      ? Response.json({ value: [] })
      : Response.json({ count: 0, value: [] }),
  );
  return Effect.gen(function* () {
    yield* saveToken(true);
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;
    const error = yield* Effect.flip(
      cli.listPullRequests({
        cwd: "/w",
        repository: "web app",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 2,
        author: "nobody@acme.dev",
      }),
    );
    assert.strictEqual(error._tag, "AzureDevOpsRestError");
    expect(requests.some((request) => request.url.includes("/pullrequests"))).toBe(false);
  }).pipe(Effect.provide(layer));
});

it.effect("reads policy evaluations over REST under the project id the pull request names", () => {
  const policyRow = (name: string, status: string) => ({
    status,
    configuration: {
      url: "https://dev.azure.com/contoso/Web%20Site/_apis/policy/configurations/54",
      isBlocking: true,
      type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
      settings: { displayName: name },
    },
  });
  const pages = [
    Array.from({ length: 100 }, () => policyRow("Lint", "approved")),
    [policyRow("Tests", "rejected")],
  ];
  const { requests, execute, layer, saveToken } = routed((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/contoso/_apis/git/pullrequests/42") {
      return Response.json({ ...pullRequestRow, repository: { project: { id: "p-1" } } });
    }
    const page = pages[Number(url.searchParams.get("$skip")) / 100] ?? [];
    return Response.json({ count: page.length, value: page });
  });
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;
    const read = cli.listPolicyChecks({ cwd: "/w", number: 42, isDraft: false });
    execute
      .mockReturnValueOnce(Effect.succeed(output(JSON.stringify(pages[0]))))
      .mockReturnValueOnce(Effect.succeed(output(JSON.stringify(pages[1]))));
    const viaCli = yield* read;
    execute.mockClear();
    yield* saveToken(true);

    assert.deepStrictEqual(yield* read, viaCli);
    expect(execute).not.toHaveBeenCalled();
    const evaluations = requests.slice(1).map(urlOf);
    assert.deepStrictEqual(
      evaluations.map((url) => [url.pathname, url.searchParams.get("$skip")]),
      [
        ["/contoso/p-1/_apis/policy/evaluations", "0"],
        ["/contoso/p-1/_apis/policy/evaluations", "100"],
      ],
    );
    assert.strictEqual(
      evaluations[0]?.searchParams.get("artifactId"),
      "vstfs:///CodeReview/CodeReviewId/p-1/42",
    );
    assert.strictEqual(evaluations[0]?.searchParams.get("api-version"), "7.1-preview");
  }).pipe(Effect.provide(layer));
});

it.effect("posts the blob ids over REST and reads the zip as az's archive is read", () => {
  const id = (digit: string) => digit.repeat(40);
  const zip = streamedZip([
    { name: id("a"), data: new TextEncoder().encode("plain text\n") },
    { name: id("c"), data: Uint8Array.of(0x89, 0x50, 0x00, 0x01) },
  ]);
  const { requests, execute, layer, saveToken } = routed(() => new Response(new Uint8Array(zip)));
  return Effect.gen(function* () {
    yield* saveToken(true);
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

    const blobs = yield* cli.readBlobs({
      cwd: "/w",
      location: restLocation,
      objectIds: [id("a"), id("C"), id("a"), "../etc"],
    });

    expect(execute).not.toHaveBeenCalled();
    expect(Object.fromEntries(blobs)).toEqual({
      [id("a")]: { contents: "plain text\n", isBinary: false },
      [id("c")]: { contents: "", isBinary: true },
    });
    const [request] = requests;
    assert.isDefined(request);
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(
      new URL(request.url).pathname,
      "/contoso/Web%20Site/_apis/git/repositories/web%20app/blobs",
    );
    assert.strictEqual(request.headers.accept, "application/zip");
    assert.strictEqual(request.body._tag, "Uint8Array");
    if (request.body._tag === "Uint8Array") {
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual([id("a"), id("C")]);
    }
  }).pipe(Effect.provide(layer));
});

const bodyOf = (request: HttpClientRequest.HttpClientRequest | undefined): unknown => {
  assert.isDefined(request);
  return request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;
};

/** Azure as a write sees it: pull request 42 lives in another project and repository than the remote. */
function writable(
  respond: (
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) => Response | undefined = () => undefined,
) {
  return routed((request) => {
    const url = new URL(request.url);
    const answer = respond(request, bodyOf(request));
    if (answer !== undefined) return answer;
    if (url.pathname.endsWith("/_apis/resourceAreas")) return Response.json({ value: [] });
    if (url.pathname.endsWith("/_apis/connectionData")) {
      return Response.json({ authenticatedUser: { id: "viewer-id" } });
    }
    if (url.pathname === "/contoso/_apis/git/pullrequests/42") {
      return Response.json({
        ...pullRequestRow,
        repository: { id: "repo-id", project: { id: "project-id" } },
        lastMergeSourceCommit: { commitId: "a".repeat(40) },
        reviewers: [{ id: "required-id", isRequired: true, vote: 0 }],
      });
    }
    return Response.json(pullRequestRow);
  });
}

const restWritePath = "/contoso/project-id/_apis/git/repositories/repo-id/pullRequests/42";

it.effect.each([
  {
    write: "a title and description",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.updatePullRequest({ cwd: "/w", number: 42, title: "@title", body: "- body" }),
    body: { title: "@title", description: "- body" },
  },
  {
    write: "a title alone",
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.updatePullRequest({ cwd: "/w", number: 42, title: "Renamed" }),
    body: { title: "Renamed" },
  },
  ...(
    [
      [
        "merge",
        "squash",
        {
          status: "completed",
          lastMergeSourceCommit: { commitId: "a".repeat(40) },
          completionOptions: { mergeStrategy: "squash" },
        },
      ],
      [
        "merge",
        "merge",
        {
          status: "completed",
          lastMergeSourceCommit: { commitId: "a".repeat(40) },
          completionOptions: { mergeStrategy: "noFastForward" },
        },
      ],
      [
        "enable-auto-merge",
        "squash",
        { autoCompleteSetBy: { id: "viewer-id" }, completionOptions: { mergeStrategy: "squash" } },
      ],
      ["enable-auto-merge", undefined, { autoCompleteSetBy: { id: "viewer-id" } }],
      [
        "disable-auto-merge",
        undefined,
        { autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" } },
      ],
      ["ready", undefined, { isDraft: false }],
      ["draft", undefined, { isDraft: true }],
      ["close", undefined, { status: "abandoned" }],
      ["reopen", undefined, { status: "active" }],
    ] as const
  ).map(([action, mergeMethod, body]) => ({
    write: `${action}${mergeMethod === undefined ? "" : ` by ${mergeMethod}`}`,
    call: (cli: AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi["Service"]) =>
      cli.runPullRequestAction({
        cwd: "/w",
        number: 42,
        action,
        ...(mergeMethod === undefined ? {} : { mergeMethod }),
      }),
    body,
  })),
])("patches $write over REST where the pull request lives", ({ call, body }) => {
  const { requests, execute, layer, saveToken } = writable();
  return Effect.gen(function* () {
    yield* saveToken(true);
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

    yield* call(cli);

    expect(execute).not.toHaveBeenCalled();
    const patch = requests.at(-1);
    assert.strictEqual(patch?.method, "PATCH");
    assert.strictEqual(urlOf(patch).pathname, restWritePath);
    expect(bodyOf(patch)).toEqual(body);
  }).pipe(Effect.provide(layer));
});

it.effect("returns the pull request an action left, as az prints it", () => {
  const { layer, saveToken } = writable((request) =>
    request.method === "PATCH" ? Response.json({ ...pullRequestRow, isDraft: true }) : undefined,
  );
  return Effect.gen(function* () {
    yield* saveToken(true);
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;
    const left = yield* cli.runPullRequestAction({ cwd: "/w", number: 42, action: "draft" });
    assert.strictEqual(left?.isDraft, true);
  }).pipe(Effect.provide(layer));
});

/** A user with an empty `mail` is a Windows user of Azure DevOps Server, named by `account`. */
const picker = (
  identities: ReadonlyArray<{ id: string; name: string; mail: string; account?: string }>,
) =>
  Response.json({
    results: [
      {
        identities: identities.map((identity) => ({
          localId: identity.id,
          displayName: identity.name,
          mail: identity.mail,
          ...(identity.account === undefined
            ? {}
            : { scopeName: "ADO2022", samAccountName: identity.account }),
        })),
      },
    ],
  });

/** Identities by exact email, and the picker's prefix matches for `Ana` and `Sam`. */
const directory = (request: HttpClientRequest.HttpClientRequest, body: unknown) => {
  const url = new URL(request.url);
  if (url.pathname === "/contoso/_apis/identities") {
    const id = { "ana@acme.dev": "ana-id", "req@acme.dev": "required-id" }[
      url.searchParams.get("filterValue") ?? ""
    ];
    return Response.json({ value: id === undefined ? [] : [{ id }] });
  }
  if (url.pathname === "/contoso/_apis/IdentityPicker/Identities") {
    const query = (body as { query?: string }).query;
    if (query === "Ana") return picker([{ id: "ana-id", name: "Ana", mail: "ana@acme.dev" }]);
    if (query === "ADO2022\\ana" || query === "ana") {
      return picker([{ id: "ana-id", name: "Ana", mail: "", account: "ana" }]);
    }
    if (query === "Max") {
      return picker([
        { id: "max-1", name: "Max Beckenbach", mail: "", account: "max" },
        { id: "max-2", name: "Max Roe", mail: "", account: "mroe" },
      ]);
    }
    if (query === "Sam") {
      return picker([
        { id: "sam-1", name: "Sam Lee", mail: "sam.lee@acme.dev" },
        { id: "sam-2", name: "Sam Roe", mail: "sam.roe@acme.dev" },
      ]);
    }
    return picker([]);
  }
  return undefined;
};

it.effect.each([
  { requested: true, reviewers: ["ana@acme.dev"], lookup: "identities" },
  { requested: true, reviewers: ["Ana"], lookup: "picker" },
  { requested: false, reviewers: ["Ana"], lookup: "picker" },
  { requested: true, reviewers: ["ADO2022\\ana"], lookup: "picker" },
  { requested: true, reviewers: ["ana"], lookup: "picker" },
] as const)(
  "names reviewer $reviewers by its $lookup identity and requested=$requested over REST",
  ({ requested, reviewers, lookup }) => {
    const { requests, execute, layer, saveToken } = writable(directory);
    return Effect.gen(function* () {
      yield* saveToken(true);
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      yield* cli.setPullRequestReviewers({ cwd: "/w", number: 42, reviewers, requested });

      expect(execute).not.toHaveBeenCalled();
      const write = requests.at(-1);
      assert.strictEqual(write?.method, requested ? "PUT" : "DELETE");
      assert.strictEqual(urlOf(write).pathname, `${restWritePath}/reviewers/ana-id`);
      expect(bodyOf(write)).toEqual(requested ? { vote: 0, isRequired: false } : undefined);
      if (lookup === "picker") {
        const search = requests.find((request) => request.url.includes("/IdentityPicker/"));
        assert.strictEqual(search?.method, "POST");
        assert.strictEqual(urlOf(search).searchParams.get("api-version"), "7.1-preview.1");
        expect(bodyOf(search)).toEqual({
          query: reviewers[0],
          identityTypes: ["user"],
          operationScopes: ["ims", "source"],
          options: { MinResults: 5, MaxResults: 20 },
          properties: ["DisplayName", "Mail", "SamAccountName", "ScopeName"],
        });
      } else {
        const search = urlOf(requests.find((request) => request.url.includes("/_apis/identities")));
        assert.strictEqual(search.searchParams.get("searchFilter"), "General");
        assert.strictEqual(search.searchParams.get("queryMembership"), "None");
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps a required reviewer required when adding them again over REST", () => {
  const { requests, layer, saveToken } = writable(directory);
  return Effect.gen(function* () {
    yield* saveToken(true);
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

    yield* cli.setPullRequestReviewers({
      cwd: "/w",
      number: 42,
      reviewers: ["req@acme.dev", "ana@acme.dev"],
      requested: true,
    });

    const puts = requests.filter((request) => request.method === "PUT");
    assert.deepStrictEqual(
      puts.map((request) => [urlOf(request).pathname.split("/").at(-1), bodyOf(request)]),
      [
        ["required-id", { vote: 0, isRequired: true }],
        ["ana-id", { vote: 0, isRequired: false }],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  {
    reviewer: "Sam",
    candidates: ["Sam Lee (sam.lee@acme.dev)", "Sam Roe (sam.roe@acme.dev)"],
  },
  {
    reviewer: "Max",
    candidates: ["Max Beckenbach (ADO2022\\max)", "Max Roe (ADO2022\\mroe)"],
  },
  { reviewer: "Nobody", candidates: [] },
  { reviewer: "nobody@acme.dev", candidates: [] },
])("writes no reviewer when $reviewer names no single user", ({ reviewer, candidates }) => {
  const { requests, layer, saveToken } = writable(directory);
  return Effect.gen(function* () {
    yield* saveToken(true);
    const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

    const error = yield* Effect.flip(
      cli.setPullRequestReviewers({
        cwd: "/w",
        number: 42,
        reviewers: ["ana@acme.dev", reviewer],
        requested: true,
      }),
    );

    assert.strictEqual(error._tag, "AzureDevOpsIdentityError");
    if (error._tag === "AzureDevOpsIdentityError") {
      assert.deepStrictEqual(error.candidates, candidates);
      for (const candidate of candidates) expect(error.detail).toContain(candidate);
    }
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  }).pipe(Effect.provide(layer));
});

afterEach(() => {
  mockedExecute.mockReset();
});

layer("AzureDevOpsPullRequestApi.layer", (it) => {
  it.effect("reports the latest pushed source commit even while the trial merge is stale", () =>
    Effect.gen(function* () {
      const previousHead = "a".repeat(40);
      const latestHead = "c".repeat(40);
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(json({ ...pullRequestRow, lastMergeSourceCommit: { commitId: previousHead } })),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 2,
                    sourceRefCommit: { commitId: latestHead },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                  ...oneIteration.value,
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(json({ changeEntries: [] }))))
        .mockReturnValueOnce(Effect.succeed(output("[]")))
        .mockReturnValueOnce(
          Effect.succeed(output(json({ count: 1, value: [{ id: "4f1c", name: "release-1.0" }] }))),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "platform/web",
        host: "dev.azure.com",
        number: 42,
      });

      expect(detail.headSha).toBe(latestHead);
      expect(argsOfCall(2)).toContain("iterationId=2");
      expect(argsOfCall(4)).toContain("pullRequestLabels");
      expect(detail.labels).toEqual([{ name: "release-1.0", color: null }]);
      expect(mockedExecute).toHaveBeenCalledTimes(5);
    }),
  );

  it.effect("reads an Azure pull request page larger than the VCS default output limit", () =>
    Effect.gen(function* () {
      const rows = pullRequestRows(100, 1).map((row) => ({
        ...row,
        description: "x".repeat(10_000),
      }));
      const response = JSON.stringify(rows);
      expect(Buffer.byteLength(response)).toBeGreaterThan(1_000_000);

      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "merged",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 99,
      });

      assert.strictEqual(batch.items.length, 99);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("steps over what it has already handed over, which is all Azure can be told", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 20 },
      });

      const args = argsOfCall(0);
      expect(args).toContain("--skip");
      assert.strictEqual(args[args.indexOf("--skip") + 1], "20");
      expect(args).not.toContain("2026-07-02T00:00:00Z");
    }),
  );

  it.effect("asks Azure for the author's pull requests by creator", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(1, 1))));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal@acme.dev",
        limit: 10,
        author: "ana@acme.dev",
      });

      const args = argsOfCall(0);
      assert.strictEqual(args[args.indexOf("--creator") + 1], "ana@acme.dev");
      assert.strictEqual(args[args.indexOf("--reviewer") + 1], "bilal@acme.dev");
    }),
  );

  it.effect("advances by malformed raw rows and keeps reading until the page is full", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([
                { pullRequestId: "malformed" },
                pullRequestRows(1, 1)[0],
                { pullRequestId: "also malformed" },
              ]),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(pullRequests(2, 2))));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      assert.isTrue(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 4);
      const secondArgs = argsOfCall(1);
      assert.strictEqual(secondArgs[secondArgs.indexOf("--skip") + 1], "3");
      assert.strictEqual(secondArgs[secondArgs.indexOf("--top") + 1], "2");
    }),
  );

  it.effect("reads the signed-in account, which az reports as a bare value", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ name: "bilal@acme.dev", type: "user" }))),
      );
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const viewer = yield* cli.getViewer({ cwd: "/w" });

      assert.strictEqual(viewer, "bilal@acme.dev");
      expect(argsOfCall(0)).toEqual([
        "account",
        "show",
        "--query",
        "user",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("names a token sign-in by the viewer's own pull request", () =>
    Effect.gen(function* () {
      const notLoggedIn = new AzureDevOpsApi.AzureDevOpsCliAuthenticationError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 7,
        cause: new Error("Please run 'az login' to setup account."),
      });
      mockedExecute
        .mockReturnValueOnce(Effect.fail(notLoggedIn))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([{ ...pullRequestRow, createdBy: { uniqueName: "bilal@acme.dev" } }]),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("")))
        .mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      assert.strictEqual(yield* cli.getViewer({ cwd: "/w" }), "bilal@acme.dev");
      expect(argsOfCall(1)).toEqual(expect.arrayContaining(["--creator", "me", "--top", "1"]));
      const error = yield* Effect.flip(cli.getViewer({ cwd: "/w" }));
      assert.strictEqual(error._tag, "AzureDevOpsViewerUnavailableError");
    }),
  );

  it.effect("fails when no sign-in can read pull requests", () =>
    Effect.gen(function* () {
      const signedOut = new AzureDevOpsApi.AzureDevOpsCliAuthenticationError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 7,
        cause: new Error("signed out"),
      });
      mockedExecute.mockReturnValue(Effect.fail(signedOut));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const error = yield* Effect.flip(cli.getViewer({ cwd: "/w" }));

      assert.strictEqual(error._tag, "AzureDevOpsCliAuthenticationError");
    }),
  );

  const policyRow = (name: string, status: string) => ({
    status,
    configuration: {
      url: "https://dev.azure.com/acme/platform/_apis/policy/configurations/54",
      isBlocking: true,
      type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
      settings: { displayName: name },
    },
  });

  it.effect("follows every page of policies and puts failures first", () =>
    Effect.gen(function* () {
      const fullPage = Array.from({ length: 100 }, () => policyRow("Lint", "approved"));
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify(fullPage))))
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify([policyRow("Tests", "rejected")]))),
        );
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;
      const checks = yield* cli.listPolicyChecks({ cwd: "/w", number: 42, isDraft: false });
      assert.deepStrictEqual(argsOfCall(1).slice(0, 12), [
        "repos",
        "pr",
        "policy",
        "list",
        "--detect",
        "true",
        "--id",
        "42",
        "--top",
        "100",
        "--skip",
        "100",
      ]);
      assert.strictEqual(checks.length, 101);
      assert.strictEqual(checks[0]?.name, "Tests");
    }),
  );

  it.effect.each([
    { name: "cut off", result: { ...output("[]"), stdoutTruncated: true } },
    { name: "unreadable", result: output(JSON.stringify([{ status: 7 }])) },
  ])("fails rather than report a $name policy page as complete", ({ result }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(result));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;
      const error = yield* Effect.flip(
        cli.listPolicyChecks({ cwd: "/w", number: 42, isDraft: false }),
      );
      assert.strictEqual(error._tag, "AzureDevOpsPullRequestReadError");
    }),
  );

  it.effect("sends a description that starts with a dash as one value, not as a flag", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      yield* cli.updatePullRequest({
        cwd: "/w",
        number: 42,
        body: "- rewrote the page\n- kept the rest",
      });

      expect(argsOfCall(0)).toContain("--description=- rewrote the page\n- kept the rest");
    }),
  );

  it.effect(
    "sends a title or description that looks like `@path` as text, not as a file for az to read",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
        const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

        yield* cli.updatePullRequest({
          cwd: "/w",
          number: 42,
          title: "@notes.txt",
          body: "@notes.txt",
        });

        // az replaces an argument that starts with `@`, or whose text after the first `=` does, with that file's contents.
        const fileReads = argsOfCall(0).flatMap((arg) => {
          const value = arg.startsWith("@") ? arg : arg.slice(arg.indexOf("=") + 1);
          return (arg.startsWith("@") || arg.includes("=")) && value.startsWith("@")
            ? [value.slice(1)]
            : [];
        });
        expect(fileReads).not.toContain("notes.txt");
        // Each `@` value goes over stdin, which reaches az wherever it runs; one per call.
        expect(mockedExecute.mock.calls.map(([call]) => call.stdin)).toEqual([
          "@notes.txt",
          "@notes.txt",
        ]);
      }),
  );

  it.effect("names the head's blob as what a cleared file was cleared at", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                  {
                    id: 2,
                    sourceRefCommit: { commitId: "c".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                changeEntries: [
                  { changeType: "edit", item: { path: "/README.md", objectId: "8f80" } },
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      assert.strictEqual(provider.capabilities.viewedFiles, "environment");
      assert.isDefined(provider.getFileRevisions);
      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["README.md"],
      });

      expect(argsOfCall(2)).toContain("iterationId=2");
      expect([...answer.revisions]).toEqual([["README.md", "8f80"]]);
    }),
  );

  it.effect(
    "answers for a marked file the pull request no longer changes as the empty version",
    () =>
      Effect.gen(function* () {
        mockedExecute
          .mockReturnValueOnce(
            Effect.succeed(
              output(
                json({
                  pullRequestId: 42,
                  title: "Add the page",
                  status: "active",
                  sourceRefName: "refs/heads/feat/page",
                  targetRefName: "refs/heads/main",
                  creationDate: "2026-07-01T00:00:00Z",
                  url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                  repository: { name: "web", project: { name: "platform" } },
                }),
              ),
            ),
          )
          .mockReturnValueOnce(
            Effect.succeed(
              output(
                json({
                  value: [
                    {
                      id: 1,
                      sourceRefCommit: { commitId: "a".repeat(40) },
                      commonRefCommit: { commitId: "b".repeat(40) },
                    },
                  ],
                }),
              ),
            ),
          )
          .mockReturnValueOnce(Effect.succeed(output('{"changeEntries":[]}')));
        const provider = yield* AzureDevOpsPullRequestProvider.make;
        assert.isDefined(provider.getFileRevisions);

        const answer = yield* provider.getFileRevisions({
          cwd: "/w",
          repository: "web",
          host: "dev.azure.com",
          number: 42,
          paths: ["GONE.md"],
        });

        expect([...answer.revisions]).toEqual([["GONE.md", ""]]);
      }),
  );

  it.effect("says nothing about the files past the end of a change it gave up following", () =>
    Effect.gen(function* () {
      const entries = (from: number, count: number) =>
        Array.from({ length: count }, (_, index) => ({
          changeType: "edit",
          item: { path: `/src/f${from + index}.ts`, objectId: `blob-${from + index}` },
        }));
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(json({ changeEntries: entries(0, 5_000), nextSkip: 5_000 }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(json({ changeEntries: entries(5_000, 5_000), nextSkip: 10_000 }))),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["src/f1.ts", "src/f5001.ts", "src/past-the-cut.ts"],
      });

      expect(argsOfCall(3)).toContain("$skip=5000");
      expect([...answer.revisions]).toEqual([
        ["src/f1.ts", "blob-1"],
        ["src/f5001.ts", "blob-5001"],
      ]);
    }),
  );

  it.effect("stops following pages by what Azure counts, not by what survives decoding", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockImplementation((command) => {
          const skip = command.args.find((arg) => arg.startsWith("$skip="));
          const from = Number(skip?.slice("$skip=".length) ?? 0);
          return Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "add", item: { path: "/src", isFolder: true } }],
                nextSkip: from + 2_000,
              }),
            ),
          );
        });
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["src/page.ts"],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 7);
      assert.strictEqual(answer.revisions.size, 0);
    }),
  );

  it.effect("leaves one file the host would not hand over listed without its hunks", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(json(pullRequestRow))))
        .mockReturnValueOnce(Effect.succeed(output(json(oneIteration))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/huge.bin", objectId: "8f80" } },
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.fail(
            new AzureDevOpsApi.AzureDevOpsCommandFailedError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: 1,
              cause: "the blob is past what the route will carry",
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(json({ content: "hello\n" }))));
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const slice = yield* provider.getDiff({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
      });

      assert.isTrue(slice.truncated);
      expect(slice.patch).toContain("diff --git a/huge.bin b/huge.bin");
      expect(slice.patch).toContain("+hello");
    }),
  );

  it.effect("fails the whole read when it is the connection that would not answer", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(json(pullRequestRow))))
        .mockReturnValueOnce(Effect.succeed(output(json(oneIteration))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.fail(
            new AzureDevOpsApi.AzureDevOpsCliRateLimitError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: 1,
              cause: "429",
            }),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const error = yield* Effect.flip(
        provider.getDiff({ cwd: "/w", repository: "web", host: "dev.azure.com", number: 42 }),
      );

      assert.strictEqual(error.reason, "rate-limited");
    }),
  );

  it.effect("takes Azure's own word on a file it will not spell out", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/logo.png", objectId: "8f80" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(json({ content: "iVBORw0KGgo=", contentMetadata: { isBinary: true } })),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const slice = yield* provider.getDiff({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
      });

      expect(argsOfCall(3)).toContain("includeContentMetadata=true");
      expect(slice.patch).toContain("Binary files a/logo.png and b/logo.png differ");
      assert.isTrue(slice.truncated);
    }),
  );

  it.effect("stops following pages when one of them does not move the cursor on", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "edit", item: { path: "/a.ts", objectId: "8f80" } }],
                nextSkip: 2_000,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "edit", item: { path: "/b.ts", objectId: "0ca4" } }],
                nextSkip: 2_000,
              }),
            ),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["a.ts", "b.ts", "unlisted.ts"],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 4);
      expect([...answer.revisions]).toEqual([
        ["a.ts", "8f80"],
        ["b.ts", "0ca4"],
      ]);
    }),
  );

  it.effect("reads a full page of change entries, which is past the default output limit", () =>
    Effect.gen(function* () {
      const response = json({ changeEntries: changeEntries(2_000) });
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const page = yield* cli.listIterationChanges({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        iterationId: 1,
      });

      assert.strictEqual(page.changes.length, 2_000);
      assert.isFalse(page.truncated);
    }),
  );

  it.effect("reads a file whose JSON envelope is past the default output limit", () =>
    Effect.gen(function* () {
      const file = "const value = 1;\n".repeat(57_000);
      const response = json({ content: file });
      expect(Buffer.byteLength(file)).toBeLessThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const item = yield* cli.readItemContent({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        path: "src/generated/schema.ts",
        commit: "a".repeat(40),
      });

      assert.strictEqual(item.contents, file);
      assert.isFalse(item.isBinary);
    }),
  );

  it.effect(
    "reads a batch of files from one blobs zip, keeping only what Azure's read would say",
    () =>
      Effect.gen(function* () {
        const id = (digit: string) => digit.repeat(40);
        const utf8 = (text: string) => new TextEncoder().encode(text);
        let sent = "";
        mockedExecute.mockImplementationOnce((input) =>
          Effect.sync(() => {
            const flag = (name: string) => input.args[input.args.indexOf(name) + 1] ?? "";
            sent = NodeFS.readFileSync(flag("--in-file"), "utf8");
            NodeFS.writeFileSync(
              flag("--out-file"),
              streamedZip([
                { name: id("a"), data: utf8("plain text\n") },
                { name: id("b"), data: utf8("\uFEFFcafé ✓\n") },
                { name: id("c"), data: Uint8Array.of(0x89, 0x50, 0x00, 0x01) },
                // Windows-1252 "café" and UTF-16: Azure decodes these itself.
                { name: id("d"), data: Uint8Array.of(0x63, 0x61, 0x66, 0xe9) },
                { name: id("e"), data: Uint8Array.of(0xff, 0xfe, 0x68, 0x00) },
                { name: id("f"), data: utf8("stored\n"), stored: true },
                { name: id("9"), data: utf8("never asked for\n") },
              ]),
            );
            return output("");
          }),
        );
        const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

        const blobs = yield* cli.readBlobs({
          cwd: "/w",
          location: { project: "platform", repository: "web" },
          objectIds: [id("A"), id("b"), id("C"), id("d"), id("e"), id("f"), id("a"), "../etc"],
        });

        expect(JSON.parse(sent)).toEqual([id("A"), id("b"), id("C"), id("d"), id("e"), id("f")]);
        expect(argsOfCall(0)).toEqual(
          expect.arrayContaining(["blobs", "POST", "application/zip", "project=platform"]),
        );
        expect(Object.fromEntries(blobs)).toEqual({
          [id("a")]: { contents: "plain text\n", isBinary: false },
          [id("b")]: { contents: "café ✓\n", isBinary: false },
          [id("c")]: { contents: "", isBinary: true },
          [id("f")]: { contents: "stored\n", isBinary: false },
        });
      }),
  );

  it.effect("leaves blobs past the batch's total size to per-file reads", () =>
    Effect.gen(function* () {
      const ids = ["1", "2", "3", "4", "5", "6"].map((digit) => digit.repeat(40));
      // Compresses to a few KiB each, so only the inflated total can bound memory.
      const blob = new Uint8Array(3 * 1024 * 1024).fill(0x61);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.sync(() => {
          NodeFS.writeFileSync(
            input.args[input.args.indexOf("--out-file") + 1] ?? "",
            streamedZip(ids.map((name) => ({ name, data: blob }))),
          );
          return output("");
        }),
      );
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const blobs = yield* cli.readBlobs({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        objectIds: ids,
      });

      expect([...blobs.keys()]).toEqual(ids.slice(0, 5));
    }),
  );

  it.effect("escapes characters in a file path that would cut the query string", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(json({ content: "x" }))));
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      yield* cli.readItemContent({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        path: "docs/C#/a&b.md",
        commit: "a".repeat(40),
      });

      expect(mockedExecute.mock.calls.at(-1)?.[0].args).toContain("path=%2Fdocs%2FC%23%2Fa%26b.md");
    }),
  );

  it.effect("reports a pull request it cannot place as its own outcome", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add the page",
              sourceRefName: "refs/heads/feat/page",
              targetRefName: "refs/heads/main",
              creationDate: "2026-07-01T00:00:00Z",
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/w", number: 42 }));

      assert.strictEqual(error._tag, "AzureDevOpsPullRequestIncompleteError");
    }),
  );

  it.effect("refuses a reviewer az would read as a flag, before running anything", () =>
    Effect.gen(function* () {
      const cli = yield* AzureDevOpsPullRequestApi.AzureDevOpsPullRequestApi;

      const error = yield* Effect.flip(
        cli.setPullRequestReviewers({
          cwd: "/w",
          number: 42,
          reviewers: ["--query"],
          requested: true,
        }),
      );

      assert.strictEqual(error._tag, "AzureDevOpsReviewerNameError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );
});
