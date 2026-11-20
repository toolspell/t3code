import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";

const encode = (value: unknown) => JSON.stringify(value);

const WORK_ITEM = {
  id: 7,
  url: "https://dev.azure.com/acme/_apis/wit/workItems/7",
  fields: {
    "System.Title": "Composer loses focus",
    "System.State": "Shipped",
    "System.CreatedDate": "2026-07-01T00:00:00Z",
    "System.ChangedDate": "2026-07-03T00:00:00Z",
    "Microsoft.VSTS.Common.ClosedDate": "2026-07-03T00:00:00Z",
    "System.CreatedBy": { uniqueName: "octo@acme.test", displayName: "Octo Cat" },
    "System.AssignedTo": "Theo <theo@acme.test>",
    "System.Tags": "bug; ui; bug",
    "System.TeamProject": "Web App",
    "System.WorkItemType": "Bug",
    "System.CommentCount": 2,
    "System.Description": "<p>Typing drops focus.</p>",
  },
  relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F50" },
    { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/acme/_apis/wit/workItems/8" },
  ],
};

/** A custom process: "Shipped" is finished only because its category says so. */
const WORK_ITEM_TYPES = {
  value: [
    // Another type's workflow, which a Bug cannot be moved through.
    { name: "Epic", states: [{ name: "Funded", category: "Proposed" }] },
    {
      name: "Bug",
      states: [
        { name: "Active", category: "InProgress" },
        { name: "Shipped", category: "Completed" },
      ],
    },
  ],
};

const PULL_REQUEST = {
  pullRequestId: 50,
  title: "fix(web): keep composer focus",
  status: "completed",
  isDraft: false,
  sourceRefName: "refs/heads/fix",
  targetRefName: "refs/heads/main",
  creationDate: "2026-07-02T00:00:00Z",
  closedDate: "2026-07-03T00:00:00Z",
  mergeStatus: "succeeded",
  repository: {
    id: "r-guid",
    name: "web",
    webUrl: "https://dev.azure.com/acme/Web%20App/_git/web",
    project: { id: "p-guid", name: "Web App" },
  },
  createdBy: { uniqueName: "theo@acme.test", displayName: "Theo" },
  description: "",
  reviewers: [],
  _links: { web: { href: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50" } },
};

const COMMENTS = {
  continuationToken: "next-token",
  // Newest first, as `order=desc` answers.
  comments: [
    {
      id: 3,
      text: "Still happening.",
      createdDate: "2026-07-04T00:00:00Z",
      createdBy: { uniqueName: "octo@acme.test" },
    },
    {
      id: 1,
      text: "Repro attached.",
      createdDate: "2026-07-02T00:00:00Z",
      createdBy: { uniqueName: "julius@acme.test", displayName: "Julius" },
      reactions: [
        { type: "like", count: 2, isCurrentUserEngaged: true },
        { type: "dislike", count: 0 },
      ],
    },
    { id: 2, text: "gone", createdDate: "2026-07-02T00:00:00Z", isDeleted: true },
  ],
};

const UPDATES = {
  value: [
    {
      id: 1,
      revisedDate: "2026-07-01T00:00:00Z",
      fields: { "System.Title": { newValue: "x" } },
    },
    {
      id: 2,
      // The newest revision has not been superseded, which Azure writes as year 9999.
      revisedDate: "9999-01-01T00:00:00Z",
      revisedBy: { uniqueName: "theo@acme.test" },
      fields: {
        "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
        "System.State": { oldValue: "Active", newValue: "Shipped" },
        "System.Tags": { oldValue: "ui", newValue: "bug; ui" },
      },
    },
  ],
};

/** Every `az` command the detail read runs, told apart by its first few arguments. */
function answer(args: ReadonlyArray<string>): string {
  const resource = args[args.indexOf("--resource") + 1];
  if (args[0] === "boards") return encode(WORK_ITEM);
  if (resource === "workitemtypes") return encode(WORK_ITEM_TYPES);
  if (args[0] === "repos") return encode(PULL_REQUEST);
  if (resource === "comments") return encode(COMMENTS);
  if (resource === "updates") return encode(UPDATES);
  throw new Error(`unexpected az invocation ${args.join(" ")}`);
}

/** No token is saved, so every call takes the Azure CLI and REST must not be reached. */
const cliRoute = Layer.mergeAll(
  AzureDevOpsRouting.layer.pipe(Layer.provide(TestSourceControlHost.layer())),
  Layer.mock(AzureDevOpsRest.AzureDevOpsRest)({}),
);

function tracker(onExecute: (args: ReadonlyArray<string>, stdin: string | undefined) => string) {
  return AzureDevOpsIssueTracker.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        cliRoute,
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
          execute: ({ args, stdin }) =>
            Effect.succeed(TestSourceControlHost.processOutput(onExecute(args, stdin))),
        }),
      ),
    ),
  );
}

describe("AzureDevOpsIssueTracker", () => {
  it.effect("maps a work item, its conversation and revisions to the neutral issue shape", () =>
    Effect.gen(function* () {
      const seen: string[][] = [];
      const api = yield* tracker((args) => {
        seen.push([...args]);
        return answer(args);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
      });
      // Every command names the organization rather than detecting it from the checkout.
      for (const args of seen) {
        expect(args).toContain("https://dev.azure.com/acme");
      }
      expect(issue).toMatchObject({
        key: "7",
        displayKey: "#7",
        title: "Composer loses focus",
        url: "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
        // The project's own state name survives; the category is what the list filters by.
        state: { category: "closed", name: "Shipped" },
        // Its own type's workflow, in Azure's order, not the stock list or another type's.
        states: [
          { category: "open", name: "Active" },
          { category: "closed", name: "Shipped" },
        ],
        author: { login: "octo@acme.test", name: "Octo Cat" },
        assignees: [{ login: "Theo <theo@acme.test>" }],
        labels: [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
        commentCount: 2,
        body: "<p>Typing drops focus.</p>",
        commentsCursor: "next-token",
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
      });
      // The first page is the newest comments, handed over oldest first.
      expect(seen.find((args) => args.includes("comments"))).toContain("order=desc");
      expect(issue.comments.map((comment) => comment.id)).toEqual(["1", "3"]);
      expect(issue.comments.slice(0, 1)).toEqual([
        {
          id: "1",
          author: { login: "julius@acme.test", name: "Julius", avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00Z",
          url: null,
          reactions: [{ content: "thumbs-up", count: 2, actors: [], viewerHasReacted: true }],
        },
      ]);
      // The first revision is the creation; a state move across the category line is a close.
      expect(issue.events.map((event) => [event.kind, event.detail, event.createdAt])).toEqual([
        ["closed", "Shipped", "2026-07-03T00:00:00Z"],
        ["labeled", "bug", "2026-07-03T00:00:00Z"],
      ]);
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "Web App/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50",
          state: "merged",
          isDraft: false,
          closesIssue: false,
        },
      ]);
    }),
  );

  it.effect("filters open work items by the project's own finished states", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bodies: string[] = [];
      const hydrated: string[] = [];
      let typeReads = 0;
      let finished = "Shipped";
      let workflowUnavailable = false;
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(cliRoute),
        Effect.provide(
          Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
            execute: ({ args }) => {
              const resource = args[args.indexOf("--resource") + 1];
              if (resource === "workitems") {
                // `az devops invoke` resolves `wit/workitems` to the create route
                // (`.../workitems/${type}`) and fails before sending anything.
                return Effect.fail(
                  new AzureDevOpsCli.AzureDevOpsCommandFailedError({
                    operation: "execute",
                    command: "az",
                    cwd: "/w",
                    argumentCount: args.length,
                    cause: "KeyError: 'type'",
                  }),
                );
              }
              if (resource === "workitemtypes") {
                typeReads += 1;
                if (workflowUnavailable) {
                  return Effect.fail(
                    new AzureDevOpsCli.AzureDevOpsCommandFailedError({
                      operation: "execute",
                      command: "az",
                      cwd: "/w",
                      argumentCount: args.length,
                      cause: "workflow metadata unavailable",
                    }),
                  );
                }
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    encode({
                      value: [{ name: "Bug", states: [{ name: finished, category: "Completed" }] }],
                    }),
                  ),
                );
              }
              if (resource !== "wiql" && resource !== "workitemsbatch") {
                return Effect.succeed(TestSourceControlHost.processOutput(answer(args)));
              }
              return fs.readFileString(args[args.indexOf("--in-file") + 1]!).pipe(
                Effect.orDie,
                Effect.map((body) => {
                  if (resource === "wiql") {
                    bodies.push(body);
                    return TestSourceControlHost.processOutput(
                      encode({ workItems: [{ id: 9 }, { id: 7 }, { id: 3 }] }),
                    );
                  }
                  hydrated.push((JSON.parse(body) as { ids: number[] }).ids.join(","));
                  // The page as REST answers it: an envelope, in an order of its own.
                  return TestSourceControlHost.processOutput(
                    encode({ count: 2, value: [WORK_ITEM, { ...WORK_ITEM, id: 9 }] }),
                  );
                }),
              );
            },
          }),
        ),
      );
      const list = api.listIssues({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "open",
        involvement: "mentioned",
        viewer: "octo@acme.test",
        labels: ["o'hare"],
        assignee: "theo@acme.test",
        sort: "created",
        limit: 2,
        cursor: "2026-07-01T00:00:00Z|7",
      });
      const page = yield* list;
      yield* list;
      // The rows come back in WIQL's order, and the cursor is the last one of the page.
      expect(hydrated).toEqual(["9,7", "9,7"]);
      expect(page.items.map((item) => item.key)).toEqual(["9", "7"]);
      expect(page.nextCursor).toBe("2026-07-01T00:00:00Z|7");
      // Each `az` call costs seconds, so a second list reuses the project's states.
      expect(typeReads).toBe(1);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[0]).toContain("AND [System.State] NOT IN ('shipped')");
      const { query } = JSON.parse(bodies[0]!) as { query: string };
      // Mentions cannot be asked for over REST, so the filter sends no clause for them.
      expect(query).not.toContain("@RecentMentions");
      expect(query).toContain(
        " AND [System.Tags] CONTAINS 'o''hare' AND [System.AssignedTo] = 'theo@acme.test'" +
          " AND ([System.CreatedDate] < '2026-07-01T00:00:00Z' OR ([System.CreatedDate] = '2026-07-01T00:00:00Z' AND [System.Id] < 7))" +
          " ORDER BY [System.CreatedDate] DESC, [System.Id] DESC",
      );

      // An explicit refresh rereads the workflow; a failed one keeps the last good states.
      const firstPage = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "open",
        involvement: "all",
        sort: "updated",
        limit: 2,
      } as const;
      finished = "Released";
      yield* api.listIssues({ ...firstPage, refresh: true });
      expect(typeReads).toBe(2);
      expect(bodies[2]).toContain("AND [System.State] NOT IN ('released')");
      workflowUnavailable = true;
      const refreshError = yield* Effect.flip(api.listIssues({ ...firstPage, refresh: true }));
      expect(refreshError).toMatchObject({ operation: "listIssues", reason: "failed" });
      yield* api.listIssues(firstPage);
      expect(typeReads).toBe(3);
      expect(bodies[3]).toContain("AND [System.State] NOT IN ('released')");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("names the viewer without a request that a sign-in could refuse", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => {
        throw new Error(`unexpected az invocation ${args.join(" ")}`);
      });
      expect(yield* api.getViewer({ cwd: "/w", host: "dev.azure.com" })).toBe("@Me");
    }),
  );

  it.effect("refuses a scope that is not organization/project without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "{}";
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "dev.azure.com", scope: "web", key: "7" }),
      );
      expect(error.reason).toBe("failed");
      expect(requests).toBe(0);
    }),
  );

  it.effect("reads a legacy organization's work item and every page of its updates", () =>
    Effect.gen(function* () {
      const seen: string[][] = [];
      const api = yield* tracker((args) => {
        seen.push([...args]);
        if (args[0] === "boards") {
          return encode({
            ...WORK_ITEM,
            url: "https://acme.visualstudio.com/p-guid/_apis/wit/workItems/7",
            relations: [],
          });
        }
        if (args[args.indexOf("--resource") + 1] !== "updates") return answer(args);
        const rename = (id: number) => ({
          id,
          revisedDate: "2026-07-02T00:00:00Z",
          fields: { "System.Title": { oldValue: "a", newValue: `title ${id}` } },
        });
        return encode({
          value: args.includes("$skip=100")
            ? [rename(102)]
            : Array.from({ length: 100 }, (_, index) => rename(index + 2)),
        });
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "acme.visualstudio.com",
        scope: "Web App",
        key: "7",
      });
      for (const args of seen) {
        expect(args).toContain("https://acme.visualstudio.com");
      }
      expect(issue.url).toBe("https://acme.visualstudio.com/Web%20App/_workitems/edit/7");
      expect(issue.events).toHaveLength(101);
      expect(issue.events.at(-1)?.detail).toBe("title 102");
    }),
  );

  it.effect("refuses a write Azure cannot carry out as asked, without writing", () =>
    Effect.gen(function* () {
      const writes: string[][] = [];
      const api = yield* tracker((args) => {
        if (args[0] === "boards" && args[2] !== "show") writes.push([...args]);
        return answer(args);
      });
      const target = { cwd: "/w", host: "dev.azure.com", key: "7" };
      const own = { ...target, scope: "acme/Web App" };
      // Work item 7 is in "Web App"; an id alone would let another project's scope write to it.
      const elsewhere = { ...target, scope: "acme/Other" };
      const refusals = yield* Effect.all([
        Effect.flip(api.update!({ ...elsewhere, title: "x" })),
        Effect.flip(api.setState!({ ...elsewhere, state: "Active" })),
        Effect.flip(api.update!({ ...own, assignees: ["a@acme.test", "b@acme.test"] })),
        // `az` would send the contents of that file as the tag.
        Effect.flip(api.update!({ ...own, labels: ["@/etc/hostname"] })),
        Effect.flip(api.getIssue({ ...target, scope: "acme/@secrets" })),
        // A stock state and another type's state, neither in this Bug's custom workflow.
        Effect.flip(api.setState!({ ...own, state: "Closed" })),
        Effect.flip(api.setState!({ ...own, state: "Funded" })),
      ]);
      expect(refusals.map((error) => error.reason)).toEqual([
        "not-found",
        "not-found",
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
      ]);
      expect(writes).toEqual([]);
    }),
  );

  it.effect("moves a work item to a state of its own type, custom ones included", () =>
    Effect.gen(function* () {
      const writes: string[][] = [];
      const api = yield* tracker((args) => {
        if (args[0] === "boards" && args[2] !== "show") writes.push([...args]);
        return answer(args);
      });
      const own = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
      yield* api.setState!({ ...own, state: "Shipped" });
      expect(writes.map((args) => args[args.indexOf("--state") + 1])).toEqual(["Shipped"]);
      // A type that reports no states falls back to the stock workflow, plus where the item is.
      const stock = yield* tracker((args) =>
        args[args.indexOf("--resource") + 1] === "workitemtypes"
          ? encode({ value: [{ name: "Bug" }] })
          : answer(args),
      );
      expect((yield* stock.getIssue(own)).states.map((state) => state.name)).toEqual([
        "New",
        "To Do",
        "Active",
        "Doing",
        "Resolved",
        "Done",
        "Closed",
        "Removed",
        "Shipped",
      ]);
    }),
  );

  it.effect("sends text that starts with @ on stdin, where az reads no file for it", () =>
    Effect.gen(function* () {
      const writes: Array<{ args: string[]; stdin: string | undefined }> = [];
      const api = yield* tracker((args, stdin) => {
        if (args[0] === "boards" && args[2] !== "show") writes.push({ args: [...args], stdin });
        return answer(args);
      });
      const scope = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App" };
      yield* api.update!({ ...scope, key: "7", title: "@/etc/hostname", body: "@notes" });
      yield* api.create!({
        ...scope,
        title: "@/etc/hostname",
        body: "@notes",
        labels: [],
        assignees: [],
      });
      for (const write of writes) {
        expect(write.args.filter((arg) => arg.startsWith("@") || arg.includes("=@/"))).toEqual([]);
      }
      expect(
        writes.map((write) => [
          write.args[2],
          write.args.find((arg) => arg.endsWith("=@-")),
          write.stdin,
        ]),
      ).toEqual([
        ["update", "--title=@-", "@/etc/hostname"],
        ["update", "--description=@-", "@notes"],
        ["create", "--title=@-", "@/etc/hostname"],
        ["update", "--description=@-", "@notes"],
      ]);
    }),
  );

  it.effect("keeps a failure's own text in the cause, out of the detail a caller reads", () =>
    Effect.gen(function* () {
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeTempFileScoped",
        pathOrDescriptor: "/private/tmp/secret-dir",
      });
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              FileSystem.FileSystem,
              FileSystem.makeNoop({ makeTempFileScoped: () => Effect.fail(denied) }),
            ),
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
            cliRoute,
          ),
        ),
      );
      const error = yield* Effect.flip(
        api.comment!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          body: "x",
        }),
      );
      expect(error.detail).toBe("Could not write the Azure DevOps request body.");
      expect(error.cause).toBe(denied);
    }),
  );
});

interface SeenRequest {
  readonly method: string;
  readonly url: URL;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? {
        contentType: request.body.contentType,
        body: JSON.parse(new TextDecoder().decode(request.body.body)),
      }
    : { contentType: undefined, body: undefined };

const WEB_APP = "/acme/Web%20App/_apis/wit";

/** Identities for `klaus@acme.test`, the picker's one `Klaus` and two people starting `Sabine`. */
function directory(url: URL, body: unknown): Response | undefined {
  if (url.pathname === "/acme/_apis/identities") {
    const mail = url.searchParams.get("filterValue");
    return Response.json({
      value:
        mail === "klaus@acme.test"
          ? [
              {
                id: "klaus-id",
                providerDisplayName: "Klaus",
                properties: { Mail: { $value: mail } },
              },
            ]
          : [],
    });
  }
  if (url.pathname === "/acme/_apis/IdentityPicker/Identities") {
    const people = {
      Klaus: [{ localId: "klaus-id", displayName: "Klaus Demo", mail: "klaus@acme.test" }],
      Sabine: [
        { localId: "sabine-1", displayName: "Sabine Demo", mail: "sabinedemo@acme.test" },
        { localId: "sabine-2", displayName: "Sabine Test", mail: "sabinetest@acme.test" },
      ],
    }[(body as { query: string }).query];
    return Response.json({ results: [{ identities: people ?? [] }] });
  }
  return undefined;
}

/** Azure as REST answers it for organization `acme`, project `Web App`, with `respond` first. */
function restAnswer(url: URL, body: unknown): Response {
  const path = url.pathname;
  if (path.endsWith("/_apis/resourceAreas")) return Response.json({ value: [] });
  const identity = directory(url, body);
  if (identity !== undefined) return identity;
  // REST answers whole types, layouts and all, where `az` was trimmed by `--query`.
  if (path === `${WEB_APP}/workitemtypes`) {
    return Response.json({
      value: WORK_ITEM_TYPES.value.map((type) => ({ ...type, fieldInstances: [{ name: "x" }] })),
    });
  }
  if (path === `${WEB_APP}/workitems/7`) return Response.json(WORK_ITEM);
  if (path === `${WEB_APP}/workItems/7/comments`) return Response.json(COMMENTS);
  if (path === `${WEB_APP}/workItems/7/updates`) return Response.json(UPDATES);
  if (path === "/acme/_apis/git/pullrequests/50") return Response.json(PULL_REQUEST);
  throw new Error(`unexpected request ${url.toString()}`);
}

/** Organization `acme` has a saved token; any other one takes `execute`, which answers as `az`. */
function restTracker(respond: (url: URL, body: unknown) => Response | undefined = () => undefined) {
  const requests: SeenRequest[] = [];
  const execute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>(({ args }) =>
    Effect.succeed(TestSourceControlHost.processOutput(answer(args))),
  );
  const layer = Layer.mergeAll(
    NodeFileSystem.layer,
    Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({ execute }),
    AzureDevOpsRouting.layer,
    AzureDevOpsRest.layer.pipe(
      Layer.provide(SourceControlRateLimit.layer),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            const { contentType, body } = bodyOf(request);
            requests.push({ method: request.method, url, contentType, body });
            const response = respond(url, body) ?? restAnswer(url, body);
            return Effect.succeed(HttpClientResponse.fromWeb(request, response));
          }),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(TestSourceControlHost.layer()));
  const api = Effect.gen(function* () {
    yield* TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
      settings.update({
        sourceControlHosts: {
          "azure-devops": { tokens: { "https://dev.azure.com/acme": "acme-pat" } },
        },
      }),
    );
    return yield* AzureDevOpsIssueTracker.make;
  });
  const writes = () => requests.filter((request) => request.method !== "GET");
  return { requests, writes, execute, layer, api };
}

describe("AzureDevOpsIssueTracker over REST", () => {
  it.effect("routes by the scope's organization and reads a work item as the CLI does", () => {
    const { requests, execute, layer, api } = restTracker();
    return Effect.gen(function* () {
      const tracker = yield* api;
      const target = { cwd: "/w", host: "dev.azure.com", key: "7" };
      // `fabrikam` has no saved token, so it keeps the Azure CLI.
      const viaCli = yield* tracker.getIssue({ ...target, scope: "fabrikam/Web App" });
      const cliCalls = execute.mock.calls.length;
      expect(cliCalls).toBeGreaterThan(0);
      expect(requests).toEqual([]);

      const viaRest = yield* tracker.getIssue({ ...target, scope: "acme/Web App" });
      expect(viaRest).toEqual(viaCli);
      expect(execute).toHaveBeenCalledTimes(cliCalls);
      const find = (path: string) => {
        const request = requests.find((entry) => entry.url.pathname === path);
        assert.isDefined(request);
        return request.url.searchParams;
      };
      expect(find(`${WEB_APP}/workitems/7`).get("$expand")).toBe("relations");
      expect(Object.fromEntries(find(`${WEB_APP}/workItems/7/comments`))).toEqual({
        $top: "100",
        order: "desc",
        $expand: "reactions",
        "api-version": "7.1-preview.4",
      });
      expect(find(`${WEB_APP}/workItems/7/updates`).get("$top")).toBe("100");

      // A legacy organization shares the token saved for its dev.azure.com address.
      yield* tracker.getIssue({ ...target, host: "acme.visualstudio.com", scope: "Web App" });
      expect(execute).toHaveBeenCalledTimes(cliCalls);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists with a WIQL query and hydrates the page in one batch", () => {
    const { requests, execute, layer, api } = restTracker((url) => {
      if (url.pathname === `${WEB_APP}/wiql`) {
        return Response.json({ workItems: [{ id: 9 }, { id: 7 }, { id: 3 }] });
      }
      if (url.pathname === `${WEB_APP}/workitemsbatch`) {
        return Response.json({ count: 2, value: [WORK_ITEM, { ...WORK_ITEM, id: 9 }] });
      }
      return undefined;
    });
    return Effect.gen(function* () {
      const page = yield* (yield* api).listIssues({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "open",
        involvement: "assigned",
        viewer: "@Me",
        sort: "updated",
        limit: 2,
      });
      expect(page.items.map((item) => item.key)).toEqual(["9", "7"]);
      expect(page.nextCursor).toBe("2026-07-03T00:00:00Z|7");
      const [wiql, batch] = requests.filter((request) => request.method === "POST");
      assert.isDefined(wiql);
      assert.isDefined(batch);
      expect(wiql.url.searchParams.get("$top")).toBe("3");
      expect(wiql.url.searchParams.get("timePrecision")).toBe("true");
      expect((wiql.body as { query: string }).query).toContain(
        "WHERE [System.TeamProject] = 'Web App' AND [System.State] NOT IN ('shipped') AND [System.AssignedTo] = @Me",
      );
      expect(batch.url.pathname).toBe(`${WEB_APP}/workitemsbatch`);
      expect(batch.body).toMatchObject({
        ids: [9, 7],
        fields: expect.arrayContaining(["System.Title"]),
      });
      expect(execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("pages comments by the continuation token, sent as a query value", () => {
    const { requests, layer, api } = restTracker();
    return Effect.gen(function* () {
      const page = yield* (yield* api).getComments({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        cursor: "a+b/c&d",
      });
      expect(page.nextCursor).toBe("next-token");
      expect(requests.at(-1)?.url.searchParams.get("continuationToken")).toBe("a+b/c&d");
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates and edits a work item with JSON Patch, assigning people by email", () => {
    const { writes, execute, layer, api } = restTracker((url) =>
      url.pathname === `${WEB_APP}/workitems/$Bug` || url.pathname === `${WEB_APP}/workitems/7`
        ? Response.json(WORK_ITEM)
        : undefined,
    );
    return Effect.gen(function* () {
      const tracker = yield* api;
      const own = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App" };
      const created = yield* tracker.create!({
        ...own,
        title: "@title",
        body: "- body",
        labels: ["bug", "ui"],
        assignees: ["klaus@acme.test"],
      });
      expect(created.key).toBe("7");
      yield* tracker.update!({ ...own, key: "7", title: "Renamed", assignees: ["Klaus"] });
      yield* tracker.update!({ ...own, key: "7", labels: [], assignees: [] });
      yield* tracker.setState!({ ...own, key: "7", state: "Active" });
      const ambiguous = yield* Effect.flip(
        tracker.update!({ ...own, key: "7", assignees: ["Sabine"] }),
      );
      expect(ambiguous.reason).toBe("failed");
      expect(ambiguous.detail).toContain(
        "Sabine Demo (sabinedemo@acme.test), Sabine Test (sabinetest@acme.test)",
      );

      const field = (path: string, value: string) => ({
        op: "add",
        path: `/fields/${path}`,
        value,
      });
      expect(
        writes()
          .filter((request) => request.url.pathname.startsWith(WEB_APP))
          .map((request) => [
            request.method,
            request.url.pathname,
            request.contentType,
            request.body,
          ]),
      ).toEqual([
        [
          "POST",
          `${WEB_APP}/workitems/$Bug`,
          "application/json-patch+json",
          [
            field("System.Title", "@title"),
            field("System.Description", "- body"),
            field("System.Tags", "bug; ui"),
            field("System.AssignedTo", "klaus@acme.test"),
          ],
        ],
        [
          "PATCH",
          `${WEB_APP}/workitems/7`,
          "application/json-patch+json",
          [field("System.Title", "Renamed"), field("System.AssignedTo", "klaus@acme.test")],
        ],
        [
          "PATCH",
          `${WEB_APP}/workitems/7`,
          "application/json-patch+json",
          [field("System.Tags", ""), field("System.AssignedTo", "")],
        ],
        [
          "PATCH",
          `${WEB_APP}/workitems/7`,
          "application/json-patch+json",
          [field("System.State", "Active")],
        ],
      ]);
      expect(execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("comments in markdown, reacts, and lists tags and team members", () => {
    const { writes, layer, api } = restTracker((url) => {
      if (url.pathname.startsWith(`${WEB_APP}/workItems/7/comments`)) return Response.json({});
      if (url.pathname === `${WEB_APP}/tags`) return Response.json({ value: [{ name: "bug" }] });
      if (url.pathname === "/acme/_apis/projects/Web%20App/teams") {
        return Response.json({ count: 1, value: [{ id: "team-1" }] });
      }
      if (url.pathname === "/acme/_apis/projects/Web%20App/teams/team-1/members") {
        return Response.json({
          count: 2,
          value: [
            { identity: { uniqueName: "klaus@acme.test", displayName: "Klaus Demo" } },
            { identity: { uniqueName: "[Web App]\\Readers", isContainer: true } },
          ],
        });
      }
      return undefined;
    });
    return Effect.gen(function* () {
      const tracker = yield* api;
      const item = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
      yield* tracker.comment!({ ...item, body: "**done**" });
      yield* tracker.setReaction!({ ...item, subjectId: "3", content: "heart", reacted: true });
      yield* tracker.setReaction!({ ...item, subjectId: "3", content: "heart", reacted: false });
      expect(
        writes().map((request) => [
          request.method,
          request.url.pathname,
          Object.fromEntries(request.url.searchParams),
          request.body,
        ]),
      ).toEqual([
        [
          "POST",
          `${WEB_APP}/workItems/7/comments`,
          { format: "markdown", "api-version": "7.1-preview.4" },
          { text: "**done**" },
        ],
        [
          "PUT",
          `${WEB_APP}/workItems/7/comments/3/reactions/heart`,
          { "api-version": "7.1-preview.1" },
          undefined,
        ],
        [
          "DELETE",
          `${WEB_APP}/workItems/7/comments/3/reactions/heart`,
          { "api-version": "7.1-preview.1" },
          undefined,
        ],
      ]);
      expect(yield* tracker.listCandidates!(item)).toEqual({
        labels: [{ name: "bug", color: null, description: null }],
        assignees: [
          { id: "klaus@acme.test", login: "klaus@acme.test", name: "Klaus Demo", avatarUrl: null },
        ],
        truncated: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { status: 401, message: "TF400813: not authorized", reason: "unauthenticated" },
    { status: 404, message: "TF401232: Work item 7 does not exist", reason: "not-found" },
    { status: 500, message: "boom", reason: "failed" },
  ] as const)("reports HTTP $status as $reason", ({ status, message, reason }) => {
    const { execute, layer, api } = restTracker((url) =>
      url.pathname === `${WEB_APP}/workitemtypes`
        ? Response.json({ message }, { status })
        : undefined,
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        (yield* api).getIssue({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
        }),
      );
      expect(error.reason).toBe(reason);
      expect(error.detail).toContain(message);
      expect(execute).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });
});
