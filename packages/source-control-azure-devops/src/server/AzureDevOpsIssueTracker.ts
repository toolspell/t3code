/**
 * Azure DevOps work items as an issue tracker, over `az`, or over REST for an organization with a
 * saved token. Work items belong to a project, so the scope is `organization/project` and every
 * call names the organization. Listing is a WIQL query paged by a `(changedDate, id)` keyset
 * cursor, because WIQL has no offset.
 */
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueEvent,
  type IssueInvolvement,
  type IssueLinkedPullRequest,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import type { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import { type AzureDevOpsIdentityError, resolveIdentity } from "./azureDevOpsIdentities.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";
import {
  azureDevOpsReactionType,
  closedStateNames,
  workItemStates,
  decodeCommentsJson,
  decodeUpdatesJson,
  decodeWorkItemJson,
  decodeWorkItemsJson,
  pullRequestNumberOf,
  type AzureDevOpsWorkItem,
  type ClosedStates,
} from "./azureDevOpsIssueJson.ts";
import { decodePullRequestJson } from "./azureDevOpsPullRequestJson.ts";

const KIND = IssueTrackerKind.make("azure-devops");

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  // On comments only; a work item itself takes none, and `setReaction` says so.
  reactions: true,
  // Azure has no issue templates. Its work item types are picked here, not by the reader.
  templates: false,
  linkedPullRequests: true,
  events: true,
  search: true,
};

/**
 * Everything granted. Azure states no permission anywhere `az boards` reaches: the answer lives
 * in the security namespaces, behind identity descriptors that would be several calls per work
 * item to resolve. Controls stay live and a viewer who may not use one is told so by Azure.
 */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const REST_API_VERSION = "7.1";
const PAGE_SIZE = 100;
const CLOSED_STATES_TTL = Duration.minutes(10);
/** Updates are read a page per `az` process, oldest first, so a long history is bounded. */
const UPDATE_PAGE_LIMIT = 5;
/** Linked pull requests are read one `az` process each, so a work item's links are bounded. */
const LINKED_PULL_REQUEST_LIMIT = 10;
/** Which work item type a new issue is filed as, in order of preference across the stock processes. */
const CREATE_TYPES = ["Issue", "Bug", "Task", "User Story", "Product Backlog Item"];

const LIST_FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.CreatedDate",
  "System.ChangedDate",
  "System.CreatedBy",
  "System.AssignedTo",
  "System.CommentCount",
  "System.Tags",
  "System.TeamProject",
  "Microsoft.VSTS.Common.ClosedDate",
];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWiql = Schema.decodeUnknownResult(
  Schema.Struct({
    workItems: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.Int })))),
  }),
);
const decodeTypes = Schema.decodeUnknownResult(
  Schema.Struct({
    value: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        isDisabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
        states: Schema.optional(
          Schema.NullOr(
            Schema.Array(Schema.Struct({ name: Schema.String, category: Schema.String })),
          ),
        ),
      }),
    ),
  }),
);
const decodeTags = Schema.decodeUnknownResult(
  Schema.Struct({ value: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);
const Teams = Schema.Array(Schema.Struct({ id: Schema.String }));
const Members = Schema.Array(
  Schema.Struct({
    identity: Schema.Struct({
      uniqueName: Schema.String,
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
      imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
      // `az devops team list-member` prints null for a user.
      isContainer: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  }),
);
// `az devops team` prints the bare list REST wraps in `value`.
const decodeTeams = Schema.decodeUnknownResult(Teams);
const decodeTeamPage = Schema.decodeUnknownResult(Schema.Struct({ value: Teams }));
const decodeMembers = Schema.decodeUnknownResult(Members);
const decodeMemberPage = Schema.decodeUnknownResult(Schema.Struct({ value: Members }));
const decodeUnknown = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** The parts of an `organization/project` scope, as the organization URL and the project name. */
function parseScope(
  host: string,
  scope: string,
): { readonly organization: string; readonly project: string } | null {
  const parts = scope.split("/").flatMap((part) => part.trim() || []);
  // `az` replaces a value starting with `@` by the contents of that local file.
  if (parts.some((part) => part.startsWith("@"))) return null;
  // A legacy organization is its hostname, so its scope may be the project alone.
  if (host.toLowerCase().endsWith(".visualstudio.com")) {
    const project = parts.length === 1 || parts.length === 2 ? parts.at(-1) : undefined;
    return project === undefined ? null : { organization: `https://${host}`, project };
  }
  if (parts.length !== 2) return null;
  const [organization, project] = parts as [string, string];
  return { organization: `https://${host}/${encodeURIComponent(organization)}`, project };
}

function parseNumber(key: string): number | null {
  return /^[1-9]\d{0,9}$/.test(key) ? Number(key) : null;
}

/** WIQL string literals are single-quoted and escape a quote by doubling it. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function involvementClause(involvement: IssueInvolvement): string {
  switch (involvement) {
    case "assigned":
      return " AND [System.AssignedTo] = @Me";
    case "authored":
      return " AND [System.CreatedBy] = @Me";
    // WIQL over REST has no way to ask who was mentioned (`@RecentMentions` is a web portal
    // macro), so a mention filter has nothing to narrow by.
    case "mentioned":
    case "all":
      return "";
  }
}

function stateClause(state: "all" | "open" | "closed", closedStates: ClosedStates): string {
  const closed = `(${[...closedStates].map(quoted).join(", ")})`;
  switch (state) {
    case "open":
      return ` AND [System.State] NOT IN ${closed}`;
    case "closed":
      return ` AND [System.State] IN ${closed}`;
    case "all":
      return "";
  }
}

/** `<iso date the list is sorted by>|<id>` of the last row handed over, where the next page starts. */
function parseCursor(cursor: string): { readonly date: string; readonly id: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|([1-9]\d{0,9})$/.exec(cursor);
  return match === null ? null : { date: match[1]!, id: Number(match[2]) };
}

type RestFailure =
  | AzureDevOpsRest.AzureDevOpsRestError
  | SourceControlRateLimitPausedError
  | AzureDevOpsIdentityError
  | AzureDevOpsRouting.AzureDevOpsTokenUnavailableError;

/** A token Azure rejects, or one without the work item scope, disables the tracker like `az` signed out. */
function restReasonFor(error: RestFailure): {
  readonly reason: IssueTrackerError["reason"];
  readonly retryAt?: number;
} {
  switch (error._tag) {
    case "AzureDevOpsTokenUnavailableError":
      return { reason: "unauthenticated" };
    case "SourceControlRateLimitPausedError":
      return { reason: "rate-limited", retryAt: error.retryAt };
    case "AzureDevOpsIdentityError":
      return { reason: "failed" };
    case "AzureDevOpsRestError":
      switch (error.reason) {
        case "authentication":
        case "scope":
          return { reason: "unauthenticated" };
        case "not-found":
          return { reason: "not-found" };
        case "rate-limited":
          return error.retryAt === undefined
            ? { reason: "rate-limited" }
            : { reason: "rate-limited", retryAt: error.retryAt };
        default:
          return { reason: "failed" };
      }
  }
}

function reasonFor(error: AzureDevOpsCli.AzureDevOpsCliError): IssueTrackerError["reason"] {
  switch (error._tag) {
    case "AzureDevOpsCliUnavailableError":
      return "missing-tool";
    case "AzureDevOpsCliAuthenticationError":
      return "unauthenticated";
    case "AzureDevOpsCliRateLimitError":
      return "rate-limited";
    case "AzureDevOpsPullRequestNotFoundError":
      return "not-found";
    default:
      return "failed";
  }
}

type OrganizationRoute = AzureDevOpsRouting.AzureDevOpsOrganizationRoute;
type RestRoute = Extract<OrganizationRoute, { readonly _tag: "Rest" }>;

interface Scope {
  readonly organization: string;
  readonly project: string;
  readonly route: OrganizationRoute;
}

type RestInput = Omit<
  AzureDevOpsRest.AzureDevOpsRestRequest,
  "organizationUrl" | "token" | "operation"
>;

type Field = readonly [name: string, value: string];

const JSON_PATCH = "application/json-patch+json";
const ignored = (): Result.Result<void, unknown> => Result.succeed(undefined);

/** `{project}/_apis/wit/{rest}`; `rest` holds only numeric ids or already escaped segments. */
const witPath = (project: string, rest: string) =>
  `${encodeURIComponent(project)}/_apis/wit/${rest}`;

const fieldPatch = (fields: ReadonlyArray<Field>) =>
  fields.map(([name, value]) => ({ op: "add", path: `/fields/${name}`, value }));

export const make: Effect.Effect<
  IssueTrackerApi,
  never,
  | AzureDevOpsCli.AzureDevOpsCli
  | AzureDevOpsRest.AzureDevOpsRest
  | AzureDevOpsRouting.AzureDevOpsRouting
  | FileSystem.FileSystem
> = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const rest = yield* AzureDevOpsRest.AzureDevOpsRest;
  const routing = yield* AzureDevOpsRouting.AzureDevOpsRouting;
  const fs = yield* FileSystem.FileSystem;

  const fail = (operation: string) => (error: AzureDevOpsCli.AzureDevOpsCliError) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: reasonFor(error),
      detail: error.detail,
      cause: error,
    });

  const failRest = (operation: string) => (error: RestFailure) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      ...restReasonFor(error),
      detail: error.detail,
      cause: error,
    });

  const refused = (operation: string, detail: string, cause?: unknown) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const unreadable = (operation: string, cause: unknown) =>
    refused(operation, `Azure DevOps returned an unreadable ${operation} response.`, cause);

  const notFound = (operation: string) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "not-found",
      detail: "Azure DevOps could not find the requested work item.",
    });

  /** The organization's saved token, if any, decides the route; the checkout's remote does not. */
  const routed = (
    operation: string,
    parsed: { readonly organization: string; readonly project: string },
  ): Effect.Effect<Scope, IssueTrackerError> =>
    routing.resolveOrganization(parsed.organization).pipe(
      Effect.mapError(failRest(operation)),
      Effect.map((route) => ({ ...parsed, route })),
    );

  const scoped = (
    operation: string,
    input: { readonly host: string; readonly scope: string },
  ): Effect.Effect<Scope, IssueTrackerError> => {
    const parsed = parseScope(input.host, input.scope);
    return parsed === null
      ? Effect.fail(refused(operation, "An Azure DevOps scope is named `organization/project`."))
      : routed(operation, parsed);
  };

  const run = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string | undefined;
  }) =>
    azure
      .execute({
        cwd: input.cwd,
        args: [...input.args, "--only-show-errors", "--output", "json"],
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError(fail(input.operation)),
      );

  const decoded = <A>(
    operation: string,
    decode: (raw: string) => Result.Result<A, unknown>,
    raw: string,
  ): Effect.Effect<A, IssueTrackerError> => {
    const result = decode(raw);
    return Result.isSuccess(result)
      ? Effect.succeed(result.success)
      : Effect.fail(unreadable(operation, result.failure));
  };

  const read = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string | undefined;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, IssueTrackerError> =>
    run(input).pipe(Effect.flatMap((raw) => decoded(input.operation, input.decode, raw)));

  /** One REST request, decoded by the decoder that also reads the `az` answer. */
  const restRead = <A>(
    route: RestRoute,
    operation: string,
    request: RestInput,
    decode: (raw: string) => Result.Result<A, unknown>,
  ): Effect.Effect<A, IssueTrackerError> =>
    rest.request({ ...AzureDevOpsRouting.credentials(route), operation, ...request }).pipe(
      Effect.mapError(failRest(operation)),
      Effect.flatMap((answer) =>
        answer.truncated
          ? Effect.fail(unreadable(operation, "The answer exceeded its size limit."))
          : decoded(operation, decode, new TextDecoder().decode(answer.bytes)),
      ),
    );

  const decodeAs =
    <A>(schema: (value: unknown) => Result.Result<A, unknown>) =>
    (raw: string): Result.Result<A, unknown> =>
      Result.flatMap(decodeUnknown(raw), schema);

  /** A `wit` REST route, addressed by resource and route parameters rather than by URL. */
  const invokeArgs = (input: {
    readonly organization: string;
    readonly project: string;
    readonly resource: string;
    readonly routeParameters?: ReadonlyArray<string>;
    readonly query?: ReadonlyArray<string>;
    readonly method?: string;
    readonly apiVersion?: string;
  }) => [
    "devops",
    "invoke",
    "--detect",
    "false",
    "--organization",
    input.organization,
    "--area",
    "wit",
    "--resource",
    input.resource,
    "--api-version",
    input.apiVersion ?? REST_API_VERSION,
    "--route-parameters",
    `project=${input.project}`,
    ...(input.routeParameters ?? []),
    ...(input.query === undefined || input.query.length === 0
      ? []
      : ["--query-parameters", ...input.query]),
    ...(input.method === undefined ? [] : ["--http-method", input.method]),
  ];

  /** A request with a body, which `az devops invoke` only takes from a file. */
  const invokeWithBody = Effect.fn("AzureDevOpsIssueTracker.invokeWithBody")(function* (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly body: unknown;
  }) {
    const unwritable = (cause: unknown) =>
      refused(input.operation, "Could not write the Azure DevOps request body.", cause);
    const file = yield* fs
      .makeTempFileScoped({ prefix: "t3-azure-issue-" })
      .pipe(Effect.mapError(unwritable));
    yield* fs.writeFileString(file, encodeJson(input.body)).pipe(Effect.mapError(unwritable));
    return yield* run({
      cwd: input.cwd,
      operation: input.operation,
      args: [...input.args, "--in-file", file, "--media-type", "application/json"],
    });
  }, Effect.scoped);

  /** One call on the scope's route: `az` arguments without a token, the REST request with one. */
  const call = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly scope: Scope;
    readonly cli: { readonly args: ReadonlyArray<string>; readonly body?: unknown };
    readonly rest: RestInput;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, IssueTrackerError> => {
    if (input.scope.route._tag === "Rest") {
      return restRead(input.scope.route, input.operation, input.rest, input.decode);
    }
    if (input.cli.body === undefined) {
      return read({
        cwd: input.cwd,
        operation: input.operation,
        args: input.cli.args,
        decode: input.decode,
      });
    }
    return invokeWithBody({
      cwd: input.cwd,
      operation: input.operation,
      args: input.cli.args,
      body: input.cli.body,
    }).pipe(Effect.flatMap((raw) => decoded(input.operation, input.decode, raw)));
  };

  const workItemTypes = (input: Scope & { readonly cwd: string; readonly operation: string }) =>
    call({
      cwd: input.cwd,
      operation: input.operation,
      scope: input,
      cli: {
        // Form layouts can exceed the CLI output cap; only workflow metadata is needed.
        args: [
          ...invokeArgs({ ...input, resource: "workitemtypes" }),
          "--query",
          "{value: value[].{name: name, isDisabled: isDisabled || `false`, states: (states || `[]`)[].{name: name, category: category}}}",
        ],
      },
      rest: { path: witPath(input.project, "workitemtypes") },
      decode: decodeAs(decodeTypes),
    }).pipe(
      // The shape the CLI's `--query` trims an answer to, so both routes hand over the same.
      Effect.map((types) =>
        types.value.map((type) => ({
          name: type.name,
          isDisabled: type.isDisabled ?? false,
          states: (type.states ?? []).map((state) => ({
            name: state.name,
            category: state.category,
          })),
        })),
      ),
    );

  // Shares one in-flight workflow read per project; only a success replaces the cached states.
  const workflowReads = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, organization, project] = JSON.parse(key) as [string, string, string];
      return routed("listIssues", { organization, project }).pipe(
        Effect.flatMap((scope) => workItemTypes({ ...scope, cwd, operation: "listIssues" })),
        Effect.map(closedStateNames),
        Effect.tap((closed) => Cache.set(listClosedStates, key, closed)),
      );
    },
    { capacity: Infinity, timeToLive: () => Duration.zero },
  );
  // Each `az` call costs seconds of startup, and a project's states rarely change.
  const listClosedStates: Cache.Cache<string, ClosedStates, IssueTrackerError> =
    yield* Cache.makeWith((key: string) => Cache.get(workflowReads, key), {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? CLOSED_STATES_TTL : Duration.zero),
    });

  const workItem = (
    input: Scope & {
      readonly cwd: string;
      readonly operation: string;
      readonly number: number;
      readonly closed: ClosedStates;
    },
  ): Effect.Effect<AzureDevOpsWorkItem, IssueTrackerError> =>
    call({
      cwd: input.cwd,
      operation: input.operation,
      scope: input,
      cli: {
        args: [
          "boards",
          "work-item",
          "show",
          "--detect",
          "false",
          "--organization",
          input.organization,
          "--id",
          String(input.number),
          "--expand",
          "relations",
        ],
      },
      rest: {
        path: witPath(input.project, `workitems/${input.number}`),
        query: { $expand: "relations" },
      },
      decode: (raw) => decodeWorkItemJson(raw, input.closed),
    }).pipe(
      Effect.filterOrFail(
        (item) => item !== null,
        () => notFound(input.operation),
      ),
      // A work item is addressed by organization and id alone, so one from another project
      // answers too; the scope names a project, and an item outside it is not this scope's.
      Effect.filterOrFail(
        (item) => item.project?.toLowerCase() === input.project.toLowerCase(),
        () => notFound(input.operation),
      ),
    );

  /** The work item as Azure addresses it, or a not-found for a key that names no id. */
  const target = (
    operation: string,
    input: { readonly host: string; readonly scope: string; readonly key: string },
  ) =>
    scoped(operation, input).pipe(
      Effect.flatMap((scope) => {
        const number = parseNumber(input.key);
        return number === null
          ? Effect.fail(notFound(operation))
          : Effect.succeed({ ...scope, number });
      }),
    );

  /** Newest first, so the first page is the current discussion and a cursor leads to older ones. */
  const comments = (
    input: Scope & {
      readonly cwd: string;
      readonly operation: string;
      readonly number: number;
      readonly cursor?: string | undefined;
    },
  ) =>
    call({
      cwd: input.cwd,
      operation: input.operation,
      scope: input,
      cli: {
        args: invokeArgs({
          ...input,
          resource: "comments",
          routeParameters: [`workItemId=${input.number}`],
          apiVersion: "7.1-preview",
          query: [
            `$top=${PAGE_SIZE}`,
            "order=desc",
            "$expand=reactions",
            "api-version=7.1-preview.4",
            ...(input.cursor === undefined ? [] : [`continuationToken=${input.cursor}`]),
          ],
        }),
      },
      rest: {
        path: witPath(input.project, `workItems/${input.number}/comments`),
        apiVersion: "7.1-preview.4",
        query: {
          $top: PAGE_SIZE,
          order: "desc",
          $expand: "reactions",
          continuationToken: input.cursor,
        },
      },
      decode: decodeCommentsJson,
    }).pipe(Effect.map((page) => ({ ...page, comments: page.comments.toReversed() })));

  const updates = Effect.fn("AzureDevOpsIssueTracker.updates")(function* (
    input: Scope & { readonly cwd: string; readonly number: number; readonly closed: ClosedStates },
  ) {
    const events: IssueEvent[] = [];
    for (let page = 0; page < UPDATE_PAGE_LIMIT; page += 1) {
      const answer = yield* call({
        cwd: input.cwd,
        operation: "getIssue",
        scope: input,
        cli: {
          args: invokeArgs({
            ...input,
            resource: "updates",
            routeParameters: [`id=${input.number}`],
            query: [`$top=${PAGE_SIZE}`, ...(page === 0 ? [] : [`$skip=${page * PAGE_SIZE}`])],
          }),
        },
        rest: {
          path: witPath(input.project, `workItems/${input.number}/updates`),
          query: { $top: PAGE_SIZE, $skip: page === 0 ? undefined : page * PAGE_SIZE },
        },
        decode: (raw) => decodeUpdatesJson(raw, input.closed),
      });
      events.push(...answer.events);
      if (answer.count < PAGE_SIZE) break;
    }
    return events;
  });

  const linkedPullRequests = (input: {
    readonly cwd: string;
    readonly scope: Scope;
    readonly item: AzureDevOpsWorkItem;
  }): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, IssueTrackerError> => {
    const numbers = [
      ...new Set(input.item.relations.flatMap((relation) => pullRequestNumberOf(relation) ?? [])),
    ].slice(0, LINKED_PULL_REQUEST_LIMIT);
    return Effect.forEach(
      numbers,
      (number) =>
        call({
          cwd: input.cwd,
          operation: "getIssue",
          scope: input.scope,
          cli: {
            args: [
              "repos",
              "pr",
              "show",
              "--detect",
              "false",
              "--organization",
              input.scope.organization,
              "--id",
              String(number),
            ],
          },
          // Addressed by id alone, as `az repos pr show` does: a link may lead to any project.
          rest: { path: `_apis/git/pullrequests/${number}` },
          decode: decodePullRequestJson,
        }).pipe(
          Effect.map((pullRequest) =>
            pullRequest === null || pullRequest.location === null
              ? []
              : [
                  {
                    repository: `${pullRequest.location.project}/${pullRequest.location.repository}`,
                    number: pullRequest.number,
                    title: pullRequest.title,
                    url: pullRequest.url,
                    state: pullRequest.state,
                    isDraft: pullRequest.isDraft,
                    // Azure links a pull request to a work item but never says whether completing
                    // it resolves the item; that lives in a completion option nothing reports.
                    closesIssue: false,
                  },
                ],
          ),
          // A link to a pull request this account cannot see is left out, not a failed detail.
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.succeed([]),
          ),
        ),
      { concurrency: 2 },
    ).pipe(Effect.map((links) => links.flat()));
  };

  const update = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly organization: string;
    readonly number: number;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string | undefined;
  }) =>
    run({
      cwd: input.cwd,
      operation: input.operation,
      args: [
        "boards",
        "work-item",
        "update",
        "--detect",
        "false",
        "--organization",
        input.organization,
        "--id",
        String(input.number),
        ...input.args,
      ],
      stdin: input.stdin,
    }).pipe(Effect.asVoid);

  /** Changes fields with one JSON Patch; nothing is sent when nothing changes. */
  const patch = (input: {
    readonly route: RestRoute;
    readonly operation: string;
    readonly project: string;
    readonly number: number;
    readonly fields: ReadonlyArray<Field>;
  }) =>
    input.fields.length === 0
      ? Effect.void
      : restRead(
          input.route,
          input.operation,
          {
            method: "PATCH",
            path: witPath(input.project, `workitems/${input.number}`),
            body: fieldPatch(input.fields),
            contentType: JSON_PATCH,
          },
          ignored,
        );

  /** A write names its work item by id alone, so the item is first read to be the scope's own. */
  const owned = (operation: string, cwd: string, scope: Scope & { readonly number: number }) =>
    workItem({ ...scope, cwd, operation, closed: new Set() }).pipe(Effect.as(scope));

  /** Azure keeps tags as one `; `-joined field and takes exactly one assignee. */
  const fieldValues = (
    operation: string,
    input: {
      readonly labels?: ReadonlyArray<string> | undefined;
      readonly assignees?: ReadonlyArray<string> | undefined;
    },
  ): Effect.Effect<ReadonlyArray<Field>, IssueTrackerError> =>
    (input.assignees?.length ?? 0) > 1
      ? Effect.fail(refused(operation, "An Azure DevOps work item has one assignee at most."))
      : Effect.succeed([
          ...(input.labels === undefined
            ? []
            : [["System.Tags", input.labels.join("; ")] as const]),
          ...(input.assignees === undefined
            ? []
            : [["System.AssignedTo", input.assignees[0] ?? ""] as const]),
        ]);

  const fieldArgs = (
    operation: string,
    fields: ReadonlyArray<Field>,
  ): Effect.Effect<ReadonlyArray<string>, IssueTrackerError> =>
    // `az` reads `field=@path` as that local file, and a field value has no stdin to go through.
    fields.some(([, value]) => value.startsWith("@"))
      ? Effect.fail(
          refused(operation, "Azure DevOps takes no label or assignee that starts with `@`."),
        )
      : Effect.succeed(
          fields.length === 0
            ? []
            : ["--fields", ...fields.map(([name, value]) => `${name}=${value}`)],
        );

  /** Azure rejects a display name as an unknown identity, so a named assignee becomes their email. */
  const restFields = (
    route: RestRoute,
    operation: string,
    fields: ReadonlyArray<Field>,
  ): Effect.Effect<ReadonlyArray<Field>, IssueTrackerError> =>
    Effect.forEach(fields, ([name, value]) =>
      name !== "System.AssignedTo" || value.trim() === ""
        ? Effect.succeed([name, value] as const)
        : resolveIdentity(
            rest,
            { ...AzureDevOpsRouting.credentials(route), operation },
            value,
          ).pipe(
            Effect.mapError(failRest(operation)),
            Effect.flatMap((identity) =>
              identity.mail === null
                ? Effect.fail(
                    refused(operation, `Azure DevOps names no email to assign "${value}" by.`),
                  )
                : Effect.succeed([name, identity.mail] as const),
            ),
          ),
    );

  /** `az boards work-item create`, with a description from stdin sent in a call of its own. */
  const cliCreate = (args: {
    readonly cwd: string;
    readonly scope: Scope;
    readonly type: string;
    readonly closed: ClosedStates;
    readonly fields: ReadonlyArray<Field>;
    readonly input: { readonly title: string; readonly body: string };
  }): Effect.Effect<AzureDevOpsWorkItem | null, IssueTrackerError> => {
    const { cwd, scope, input } = args;
    const title = AzureDevOpsCli.textOption("--title", input.title);
    const body =
      input.body.length === 0 ? undefined : AzureDevOpsCli.textOption("--description", input.body);
    // az has one stdin, so a second value read from it goes in a call of its own.
    const bodyFollows = title.stdin !== undefined && body?.stdin !== undefined;
    return fieldArgs("create", args.fields).pipe(
      Effect.flatMap((fields) =>
        read({
          cwd,
          operation: "create",
          args: [
            "boards",
            "work-item",
            "create",
            "--detect",
            "false",
            "--organization",
            scope.organization,
            "--project",
            scope.project,
            "--type",
            args.type,
            title.arg,
            ...(body === undefined || bodyFollows ? [] : [body.arg]),
            ...fields,
          ],
          stdin: title.stdin ?? body?.stdin,
          decode: (raw) => decodeWorkItemJson(raw, args.closed),
        }),
      ),
      Effect.tap((item) =>
        item === null || body === undefined || !bodyFollows
          ? Effect.void
          : update({
              cwd,
              operation: "create",
              organization: scope.organization,
              number: Number(item.key),
              args: [body.arg],
              stdin: body.stdin,
            }),
      ),
    );
  };

  return {
    kind: KIND,
    capabilities: CAPABILITIES,

    // Listing filters with WIQL's `@Me`, so nothing compares against a name. Looking one up
    // needs a profile host that a PAT saved for one organization cannot reach.
    getViewer: () => Effect.succeed("@Me"),

    listIssues: Effect.fn("AzureDevOpsIssueTracker.listIssues")(function* (input) {
      const cursor = input.cursor === undefined ? undefined : parseCursor(input.cursor);
      if (cursor === null) {
        return yield* refused("listIssues", "The cursor was not one Azure DevOps handed out.");
      }
      const limit = Math.min(Math.max(input.limit, 1), PAGE_SIZE);
      const text = input.query?.trim() ?? "";
      const created = input.sort === "created";
      const dateField = created ? "[System.CreatedDate]" : "[System.ChangedDate]";
      const scope = yield* scoped("listIssues", input);
      const key = encodeJson([input.cwd, scope.organization, scope.project]);
      const refresh = cursor === undefined && input.refresh === true;
      const closed = yield* refresh
        ? Cache.get(workflowReads, key)
        : Cache.get(listClosedStates, key);
      const wiql = {
        query:
          `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${quoted(scope.project)}` +
          stateClause(input.state, closed) +
          involvementClause(input.involvement) +
          (text.length === 0 ? "" : ` AND [System.Title] CONTAINS ${quoted(text)}`) +
          (input.labels ?? [])
            .map((label) => ` AND [System.Tags] CONTAINS ${quoted(label)}`)
            .join("") +
          (input.assignee === undefined
            ? ""
            : ` AND [System.AssignedTo] = ${quoted(input.assignee)}`) +
          (cursor === undefined
            ? ""
            : ` AND (${dateField} < ${quoted(cursor.date)} OR (${dateField} = ${quoted(cursor.date)} AND [System.Id] < ${cursor.id}))`) +
          ` ORDER BY ${dateField} DESC, [System.Id] DESC`,
      };
      const ids = yield* call({
        cwd: input.cwd,
        operation: "listIssues",
        scope,
        cli: {
          args: invokeArgs({
            ...scope,
            resource: "wiql",
            method: "POST",
            // One more than the page, which is how a next page reveals itself.
            query: ["timePrecision=true", `$top=${limit + 1}`],
          }),
          body: wiql,
        },
        rest: {
          method: "POST",
          path: witPath(scope.project, "wiql"),
          query: { timePrecision: true, $top: limit + 1 },
          body: wiql,
        },
        decode: decodeAs(decodeWiql),
      }).pipe(Effect.map((answer) => answer.workItems ?? []));
      if (ids.length === 0) return { items: [], nextCursor: null };
      const batch = { ids: ids.slice(0, limit).map((row) => row.id), fields: LIST_FIELDS };
      const hydrated = yield* call({
        cwd: input.cwd,
        operation: "listIssues",
        scope,
        cli: {
          // az resolves `wit/workitems` to the create route (`workitems/${type}`) and fails
          // before sending; `workitemsbatch` has a single route.
          args: invokeArgs({ ...scope, resource: "workitemsbatch", method: "POST" }),
          body: batch,
        },
        rest: { method: "POST", path: witPath(scope.project, "workitemsbatch"), body: batch },
        decode: (raw) => decodeWorkItemsJson(raw, closed),
      });
      // The cursor is the last row WIQL sorted, so its order is restored.
      const position = new Map(ids.map((row, index) => [String(row.id), index]));
      const items = hydrated.toSorted(
        (left, right) => (position.get(left.key) ?? 0) - (position.get(right.key) ?? 0),
      );
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          ids.length > limit && last !== undefined
            ? `${created ? last.createdAt : last.updatedAt}|${last.key}`
            : null,
      };
    }),

    getIssue: (input) =>
      target("getIssue", input).pipe(
        Effect.flatMap((scope) =>
          workItemTypes({ ...scope, cwd: input.cwd, operation: "getIssue" }).pipe(
            Effect.flatMap((types) => {
              const closed = closedStateNames(types);
              return workItem({ ...scope, cwd: input.cwd, operation: "getIssue", closed }).pipe(
                Effect.map((item) => ({ item, closed, states: workItemStates(types, item) })),
              );
            }),
            Effect.flatMap(({ item, closed, states }) =>
              Effect.all(
                [
                  comments({ ...scope, cwd: input.cwd, operation: "getIssue" }),
                  updates({ ...scope, cwd: input.cwd, closed }),
                  linkedPullRequests({ cwd: input.cwd, scope, item }),
                ],
                { concurrency: 3 },
              ).pipe(
                Effect.map(([conversation, events, links]) => ({
                  ...item,
                  // Its type's own entry, so the category is the one that type gives the name.
                  state: states.find((state) => state.name === item.state.name) ?? item.state,
                  states,
                  // Nothing cheap names the viewer here; the service already read it per host.
                  viewer: null,
                  viewerPermissions: VIEWER_PERMISSIONS,
                  comments: conversation.comments,
                  commentsCursor: conversation.nextCursor,
                  events,
                  linkedPullRequests: links,
                })),
              ),
            ),
          ),
        ),
      ),

    getComments: (input) =>
      target("getComments", input).pipe(
        // `az` would read a `continuationToken=@path` as that local file.
        Effect.filterOrFail(
          () => !input.cursor.startsWith("@"),
          () => refused("getComments", "The cursor was not one Azure DevOps handed out."),
        ),
        Effect.flatMap((scope) =>
          comments({ ...scope, cwd: input.cwd, operation: "getComments", cursor: input.cursor }),
        ),
      ),

    create: Effect.fn("AzureDevOpsIssueTracker.create")(function* (input) {
      const scope = yield* scoped("create", input);
      const types = yield* workItemTypes({ ...scope, cwd: input.cwd, operation: "create" });
      const names = types.flatMap((type) => (type.isDisabled ? [] : [type.name]));
      const type = CREATE_TYPES.find((name) => names.includes(name)) ?? names[0];
      if (type === undefined) {
        return yield* refused("create", "The project offers no work item type to file.");
      }
      const closed = closedStateNames(types);
      const fields = yield* fieldValues("create", {
        ...(input.labels.length === 0 ? {} : { labels: input.labels }),
        ...(input.assignees.length === 0 ? {} : { assignees: input.assignees }),
      });
      const item =
        scope.route._tag === "Rest"
          ? yield* restRead(
              scope.route,
              "create",
              {
                method: "POST",
                path: witPath(scope.project, `workitems/$${encodeURIComponent(type)}`),
                body: fieldPatch([
                  ["System.Title", input.title],
                  ...(input.body.length === 0 ? [] : [["System.Description", input.body] as const]),
                  ...(yield* restFields(scope.route, "create", fields)),
                ]),
                contentType: JSON_PATCH,
              },
              (raw) => decodeWorkItemJson(raw, closed),
            )
          : yield* cliCreate({ cwd: input.cwd, scope, type, closed, fields, input });
      if (item === null) return yield* unreadable("create", "incomplete-response");
      return { key: item.key, displayKey: item.displayKey, url: item.url };
    }),

    comment: (input) =>
      target("comment", input).pipe(
        Effect.flatMap((scope) =>
          call({
            cwd: input.cwd,
            operation: "comment",
            scope,
            cli: {
              args: invokeArgs({
                ...scope,
                resource: "comments",
                routeParameters: [`workItemId=${scope.number}`],
                method: "POST",
                apiVersion: "7.1-preview",
                query: ["format=markdown", "api-version=7.1-preview.4"],
              }),
              body: { text: input.body },
            },
            rest: {
              method: "POST",
              path: witPath(scope.project, `workItems/${scope.number}/comments`),
              apiVersion: "7.1-preview.4",
              query: { format: "markdown" },
              body: { text: input.body },
            },
            decode: ignored,
          }),
        ),
      ),

    update: Effect.fn("AzureDevOpsIssueTracker.update")(function* (input) {
      const scope = yield* target("update", input);
      const fields = yield* fieldValues("update", input);
      if (scope.route._tag === "Rest") {
        const route = scope.route;
        yield* owned("update", input.cwd, scope);
        return yield* patch({
          route,
          operation: "update",
          project: scope.project,
          number: scope.number,
          fields: [
            ...(input.title === undefined ? [] : [["System.Title", input.title] as const]),
            ...(input.body === undefined ? [] : [["System.Description", input.body] as const]),
            ...(yield* restFields(route, "update", fields)),
          ],
        });
      }
      const args = yield* fieldArgs("update", fields);
      yield* owned("update", input.cwd, scope);
      const texts = [
        ...(input.title === undefined ? [] : [AzureDevOpsCli.textOption("--title", input.title)]),
        ...(input.body === undefined
          ? []
          : [AzureDevOpsCli.textOption("--description", input.body)]),
      ];
      // az has one stdin, so each value read from it needs its own call.
      const batches =
        texts.filter((text) => text.stdin !== undefined).length > 1
          ? texts.map((text) => [text])
          : [texts];
      yield* Effect.forEach(
        batches,
        (batch, index) =>
          update({
            ...scope,
            cwd: input.cwd,
            operation: "update",
            args: [...batch.map((text) => text.arg), ...(index === 0 ? args : [])],
            stdin: batch.find((text) => text.stdin !== undefined)?.stdin,
          }),
        { discard: true },
      );
    }),

    setState: (input) =>
      target("setState", input).pipe(
        // The read also proves the item is the scope's own, as `owned` does for other writes.
        Effect.flatMap((scope) =>
          workItem({ ...scope, cwd: input.cwd, operation: "setState", closed: new Set() }).pipe(
            Effect.flatMap((item) =>
              workItemTypes({ ...scope, cwd: input.cwd, operation: "setState" }).pipe(
                Effect.map((types) => workItemStates(types, item)),
              ),
            ),
            Effect.filterOrFail(
              (states) => states.some((state) => state.name === input.state),
              () => refused("setState", `This work item has no "${input.state}" state.`),
            ),
            Effect.flatMap(() =>
              scope.route._tag === "Rest"
                ? patch({
                    route: scope.route,
                    operation: "setState",
                    project: scope.project,
                    number: scope.number,
                    fields: [["System.State", input.state]],
                  })
                : update({
                    ...scope,
                    cwd: input.cwd,
                    operation: "setState",
                    args: ["--state", input.state],
                  }),
            ),
          ),
        ),
      ),

    setReaction: (input) =>
      target("setReaction", input).pipe(
        Effect.flatMap((scope) => {
          const type = azureDevOpsReactionType(input.content);
          if (input.subjectId === undefined) {
            return Effect.fail(
              refused("setReaction", "Azure DevOps reactions go on comments only."),
            );
          }
          if (!/^[1-9]\d{0,9}$/.test(input.subjectId)) {
            return Effect.fail(
              refused("setReaction", "The comment id names no Azure DevOps comment."),
            );
          }
          if (type === null) {
            return Effect.fail(refused("setReaction", "Azure DevOps has no such reaction."));
          }
          const method = input.reacted ? "PUT" : "DELETE";
          return call({
            cwd: input.cwd,
            operation: "setReaction",
            scope,
            cli: {
              args: invokeArgs({
                ...scope,
                resource: "commentsReactions",
                routeParameters: [
                  `workItemId=${scope.number}`,
                  `commentId=${input.subjectId}`,
                  `reactionType=${type}`,
                ],
                method,
                apiVersion: "7.1-preview",
                query: ["api-version=7.1-preview.1"],
              }),
            },
            rest: {
              method,
              path: witPath(
                scope.project,
                `workItems/${scope.number}/comments/${input.subjectId}/reactions/${type}`,
              ),
              apiVersion: "7.1-preview.1",
            },
            decode: ignored,
          });
        }),
      ),

    listCandidates: (input) =>
      scoped("listCandidates", input).pipe(
        Effect.flatMap((scope) => {
          const teams = `_apis/projects/${encodeURIComponent(scope.project)}/teams`;
          return Effect.all(
            [
              call({
                cwd: input.cwd,
                operation: "listCandidates",
                scope,
                cli: { args: invokeArgs({ ...scope, resource: "tags" }) },
                rest: { path: witPath(scope.project, "tags") },
                decode: decodeAs(decodeTags),
              }).pipe(
                Effect.map((tags) =>
                  tags.value.map((tag) => ({ name: tag.name, color: null, description: null })),
                ),
              ),
              // Nothing in `az boards` lists who a work item may go to; the project's teams are
              // the nearest thing, read a handful at a time.
              call({
                cwd: input.cwd,
                operation: "listCandidates",
                scope,
                cli: {
                  args: [
                    "devops",
                    "team",
                    "list",
                    "--detect",
                    "false",
                    "--organization",
                    scope.organization,
                    "--project",
                    scope.project,
                    "--top",
                    "10",
                  ],
                },
                rest: { path: teams, query: { $top: 10 } },
                decode:
                  scope.route._tag === "Rest"
                    ? decodeAs((value) => Result.map(decodeTeamPage(value), (page) => page.value))
                    : decodeAs(decodeTeams),
              }).pipe(
                Effect.flatMap((list) =>
                  Effect.forEach(
                    list,
                    (team) =>
                      call({
                        cwd: input.cwd,
                        operation: "listCandidates",
                        scope,
                        cli: {
                          args: [
                            "devops",
                            "team",
                            "list-member",
                            "--detect",
                            "false",
                            "--organization",
                            scope.organization,
                            "--project",
                            scope.project,
                            "--team",
                            team.id,
                            "--top",
                            String(PAGE_SIZE),
                          ],
                        },
                        rest: {
                          path: `${teams}/${encodeURIComponent(team.id)}/members`,
                          query: { $top: PAGE_SIZE },
                        },
                        decode:
                          scope.route._tag === "Rest"
                            ? decodeAs((value) =>
                                Result.map(decodeMemberPage(value), (page) => page.value),
                              )
                            : decodeAs(decodeMembers),
                      }),
                    { concurrency: 3 },
                  ),
                ),
                Effect.map((members) => {
                  const byLogin = new Map<
                    string,
                    { id: string; login: string; name: string | null; avatarUrl: string | null }
                  >();
                  for (const { identity } of members.flat()) {
                    const login = identity.uniqueName.trim();
                    if (
                      identity.isContainer ||
                      login.length === 0 ||
                      byLogin.has(login.toLowerCase())
                    ) {
                      continue;
                    }
                    byLogin.set(login.toLowerCase(), {
                      id: login,
                      login,
                      name: identity.displayName?.trim() || null,
                      avatarUrl: identity.imageUrl?.trim() || null,
                    });
                  }
                  return [...byLogin.values()];
                }),
              ),
            ],
            { concurrency: 2 },
          );
        }),
        // Teams are a sample of who can be assigned, so somebody missing is not ineligible.
        Effect.map(([labels, assignees]) => ({ labels, assignees, truncated: true })),
      ),
  };
});
