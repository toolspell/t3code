import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListState,
  PullRequestMergeMethod,
} from "@t3tools/contracts";

import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import type * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as AzureDevOpsApi from "./AzureDevOpsApi.ts";
import { blobContent, readBlobZip } from "./azureDevOpsBlobZip.ts";
import { AzureDevOpsIdentityError, resolveIdentity } from "./azureDevOpsIdentities.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";
import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  decodeLabelsJson,
  decodePolicyChecksJson,
  decodePolicyChecksPageJson,
  decodePullRequestJson,
  decodePullRequestListJson,
  decodePullRequestPageJson,
  decodeThreadsJson,
  decodeViewerJson,
  type AzureDevOpsChangeEntry,
  type AzureDevOpsChangePage,
  type AzureDevOpsItemContent,
  type AzureDevOpsIteration,
  type AzureDevOpsPolicyCheckPage,
  type AzureDevOpsPullRequest,
  type AzureDevOpsPullRequestBatch,
  type AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";
import type { ProviderListCursor } from "@t3tools/source-control-core/server/PullRequestProvider";

export class AzureDevOpsPullRequestReadError extends Schema.TaggedError<AzureDevOpsPullRequestReadError>()(
  "AzureDevOpsPullRequestReadError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Azure DevOps returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Azure DevOps failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsViewerUnavailableError extends Schema.TaggedError<AzureDevOpsViewerUnavailableError>()(
  "AzureDevOpsViewerUnavailableError",
  {
    command: Schema.Literal("az"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "Azure CLI could not name the signed-in account. Run `az login` and retry.";
  }

  override get message(): string {
    return `Azure CLI failed in getViewer: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestIncompleteError extends Schema.TaggedError<AzureDevOpsPullRequestIncompleteError>()(
  "AzureDevOpsPullRequestIncompleteError",
  {
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  get detail(): string {
    return "Azure DevOps returned no branch or link for the pull request.";
  }

  override get message(): string {
    return `Azure DevOps failed in getPullRequest: ${this.detail}`;
  }
}

export class AzureDevOpsReviewerNameError extends Schema.TaggedError<AzureDevOpsReviewerNameError>()(
  "AzureDevOpsReviewerNameError",
  {
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "A reviewer is named by an email address or an identity id.";
  }

  override get message(): string {
    return `Azure DevOps failed in setPullRequestReviewers: ${this.detail}`;
  }
}

export type AzureDevOpsPullRequestApiError =
  | AzureDevOpsApi.AzureDevOpsCliError
  | AzureDevOpsPullRequestReadError
  | AzureDevOpsPullRequestIncompleteError
  | AzureDevOpsReviewerNameError
  | AzureDevOpsViewerUnavailableError
  | AzureDevOpsIdentityError
  | AzureDevOpsRest.AzureDevOpsRestError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | AzureDevOpsRouting.AzureDevOpsRouteError;

/** `properties.Account` is the sign-in name, which pull requests show as `uniqueName`. */
const RestViewerSchema = Schema.Struct({
  authenticatedUser: Schema.Struct({
    id: Schema.NonEmptyString,
    properties: Schema.Struct({
      Account: Schema.Struct({ $value: Schema.NonEmptyString }),
    }),
  }),
});

const RestViewerDomainSchema = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      properties: Schema.optional(
        Schema.Struct({
          Domain: Schema.optional(Schema.Struct({ $value: Schema.optional(Schema.String) })),
        }),
      ),
    }),
  ),
});

const RestViewerIdSchema = Schema.Struct({
  authenticatedUser: Schema.Struct({ id: Schema.NonEmptyString }),
});

const RestIdentitiesSchema = Schema.Struct({
  value: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
});

const RestPullRequestProjectSchema = Schema.Struct({
  repository: Schema.Struct({ project: Schema.Struct({ id: Schema.NonEmptyString }) }),
});

/** Where a pull request lives, and what a write needs to carry over from it. */
const RestPullRequestTargetSchema = Schema.Struct({
  repository: Schema.Struct({
    id: Schema.NonEmptyString,
    project: Schema.Struct({ id: Schema.NonEmptyString }),
  }),
  lastMergeSourceCommit: Schema.optional(Schema.Unknown),
  reviewers: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({ id: Schema.String, isRequired: Schema.optional(Schema.Boolean) }),
      ),
    ),
  ),
});

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

const EMPTY_PULL_REQUEST_BATCH: AzureDevOpsPullRequestBatch = {
  items: [],
  rawIndexes: [],
  rawCount: 0,
};

const REST_API_VERSION = "7.1";
const PULL_REQUEST_LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** A 2,000-file page exceeds the default 1 MiB output budget. */
const CHANGE_ENTRIES_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** JSON escaping and base64 can exceed the decoded file's size. */
const ITEM_CONTENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** A larger batch is left to per-file reads rather than held in memory at once. */
const BLOB_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
/** Matches what a per-file read could carry. */
const BLOB_MAX_BYTES = ITEM_CONTENT_MAX_OUTPUT_BYTES;
/** Blobs past this, together, are left to per-file reads, which hold a few at a time. */
const BLOB_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const BLOB_ID = /^[0-9a-f]{40}$/i;
/** Review history is unpaged and independent of diff size. */
const REVIEW_HISTORY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const POLICY_EVALUATIONS_PER_PAGE = 100;
const MAX_POLICY_EVALUATIONS = 1000;

/** Azure's iteration-change page limit. */
const CHANGE_ENTRIES_PER_PAGE = 2000;

/** Count raw entries, including folders and malformed rows. */
const MAX_CHANGE_ENTRIES = 10_000;

export interface AzureDevOpsIterationChanges {
  readonly changes: ReadonlyArray<AzureDevOpsChangeEntry>;
  readonly truncated: boolean;
}

export class AzureDevOpsPullRequestApi extends Context.Service<
  AzureDevOpsPullRequestApi,
  {
    readonly getViewer: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, AzureDevOpsPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Matched by `--creator`, which takes the email a row shows as its login. */
      readonly author?: string | undefined;
      /**
       * Where to carry on from. Azure has no date filter for a pull request listing, so the only
       * part of a cursor it can use is how many rows have already been handed over.
       */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<
      {
        readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
        readonly truncated: boolean;
        readonly cursorAdvance: number;
      },
      AzureDevOpsPullRequestApiError
    >;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsPullRequestApiError>;

    readonly listPolicyChecks: (input: {
      readonly cwd: string;
      readonly number: number;
      /** Azure holds builds back on a draft, which reads the same as a build about to start. */
      readonly isDraft: boolean;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, AzureDevOpsPullRequestApiError>;

    readonly listThreads: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestComment>, AzureDevOpsPullRequestApiError>;

    /** `az repos pr show` returns null labels, so the detail reads them here. */
    readonly listLabels: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestLabel>, AzureDevOpsPullRequestApiError>;

    readonly listIterations: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<AzureDevOpsIteration>, AzureDevOpsPullRequestApiError>;

    /** Changes cover the whole PR from its merge base. */
    readonly listIterationChanges: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly number: number;
      readonly iterationId: number;
    }) => Effect.Effect<AzureDevOpsIterationChanges, AzureDevOpsPullRequestApiError>;

    readonly readItemContent: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly path: string;
      readonly commit: string;
    }) => Effect.Effect<AzureDevOpsItemContent, AzureDevOpsPullRequestApiError>;

    /**
     * Many files in one `az` run, by blob id, keyed by lowercase id. A blob only Azure's item read
     * decodes faithfully, or one too large to carry, is left out.
     */
    readonly readBlobs: (input: {
      readonly cwd: string;
      readonly location: AzureDevOpsRepositoryLocation;
      readonly objectIds: ReadonlyArray<string>;
    }) => Effect.Effect<
      ReadonlyMap<string, AzureDevOpsItemContent>,
      AzureDevOpsPullRequestApiError
    >;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<AzureDevOpsPullRequest | void, AzureDevOpsPullRequestApiError>;

    readonly updatePullRequest: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, AzureDevOpsPullRequestApiError>;

    readonly setPullRequestReviewers: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<string>;
      readonly requested: boolean;
    }) => Effect.Effect<void, AzureDevOpsPullRequestApiError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestApi") {}

function azureStatus(state: PullRequestListState): string {
  switch (state) {
    case "open":
      return "active";
    case "merged":
      return "completed";
    case "closed":
      return "abandoned";
    case "all":
      return "all";
  }
}

function involvementArgs(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<string> {
  switch (input.involvement) {
    case "authored":
      return ["--creator", input.viewer];
    case "reviewing":
      return ["--reviewer", input.viewer];
    case "all":
      return [];
  }
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return ["--status", "completed", "--squash", mergeMethod === "squash" ? "true" : "false"];
    case "enable-auto-merge":
      return [
        "--auto-complete",
        "true",
        ...(mergeMethod === undefined
          ? []
          : ["--squash", mergeMethod === "squash" ? "true" : "false"]),
      ];
    case "disable-auto-merge":
      return ["--auto-complete", "false"];
    case "ready":
      return ["--draft", "false"];
    case "draft":
      return ["--draft", "true"];
    case "close":
      return ["--status", "abandoned"];
    case "update-branch":
      return [];
    case "reopen":
      return ["--status", "active"];
    case "revert":
    case "approve-workflows":
    case "delete-branch":
      throw new Error(`Azure DevOps pull request action ${action} is unsupported`);
  }
}

/** The PATCH body `az repos pr update` sends for `actionArgs`, or null for its no-op update. */
function restActionBody(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
  context: { readonly lastMergeSourceCommit: unknown; readonly viewerId: string },
): Record<string, unknown> | null {
  const completionOptions = (method: PullRequestMergeMethod | undefined) => ({
    mergeStrategy: method === "squash" ? "squash" : "noFastForward",
  });
  switch (action) {
    case "merge":
      return {
        status: "completed",
        lastMergeSourceCommit: context.lastMergeSourceCommit,
        completionOptions: completionOptions(mergeMethod),
      };
    case "enable-auto-merge":
      return {
        autoCompleteSetBy: { id: context.viewerId },
        ...(mergeMethod === undefined ? {} : { completionOptions: completionOptions(mergeMethod) }),
      };
    case "disable-auto-merge":
      return { autoCompleteSetBy: { id: NO_IDENTITY } };
    case "ready":
      return { isDraft: false };
    case "draft":
      return { isDraft: true };
    case "close":
      return { status: "abandoned" };
    case "reopen":
      return { status: "active" };
    case "update-branch":
      return null;
    case "revert":
    case "approve-workflows":
    case "delete-branch":
      throw new Error(`Azure DevOps pull request action ${action} is unsupported`);
  }
}

function isReviewerName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && !name.startsWith("-");
}

/** @public */
export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsApi.AzureDevOpsApi;
  const rest = yield* AzureDevOpsRest.AzureDevOpsRest;
  const routing = yield* AzureDevOpsRouting.AzureDevOpsRouting;
  const fileSystem = yield* FileSystem.FileSystem;

  const detectArgs = ["--detect", "true"] as const;

  const executeJson = (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly maxOutputBytes?: number;
  }) =>
    azure.execute({
      cwd: input.cwd,
      args: [...input.args, "--only-show-errors", "--output", "json"],
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    });

  /** Use the extension's credentials; `az rest` uses the default tenant. */
  const invoke = <A>(input: {
    readonly cwd: string;
    readonly operation: string;
    readonly resource: string;
    readonly routeParameters: ReadonlyArray<string>;
    readonly queryParameters?: ReadonlyArray<string>;
    readonly maxOutputBytes?: number;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, AzureDevOpsPullRequestApiError> =>
    executeJson({
      cwd: input.cwd,
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      args: [
        "devops",
        "invoke",
        ...detectArgs,
        "--area",
        "git",
        "--resource",
        input.resource,
        "--api-version",
        REST_API_VERSION,
        "--route-parameters",
        ...input.routeParameters,
        ...(input.queryParameters === undefined
          ? []
          : ["--query-parameters", ...input.queryParameters]),
      ],
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = input.decode(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new AzureDevOpsPullRequestReadError({
                cwd: input.cwd,
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  /** Azure's items route requires a leading slash. */
  const toItemPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

  const repositoryRoute = (location: AzureDevOpsRepositoryLocation): ReadonlyArray<string> => [
    `project=${location.project}`,
    `repositoryId=${location.repository}`,
  ];

  const pullRequestRoute = (input: {
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
  }): ReadonlyArray<string> => [
    ...repositoryRoute(input.location),
    `pullRequestId=${input.number}`,
  ];

  /** A REST read decoded by the same decoder as the matching `az` output. */
  const restRead = <A>(
    route: AzureDevOpsRouting.AzureDevOpsRestRoute,
    request: Omit<AzureDevOpsRest.AzureDevOpsRestRequest, "organizationUrl" | "token"> & {
      readonly operation: string;
    },
    decode: (raw: string) => Result.Result<A, unknown>,
  ) =>
    rest
      .request({ ...AzureDevOpsRouting.credentials(route), ...request })
      .pipe(Effect.flatMap(AzureDevOpsRest.decodeAnswer(request.operation, decode)));

  const restPullRequestPath = (input: {
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
  }) =>
    `${AzureDevOpsRest.repositoryPath(input.location.project, input.location.repository)}/pullRequests/${input.number}`;

  /** A pull request numbered in the organization, wherever its repository is, as `--id` finds it. */
  const restPullRequestTarget = (
    route: AzureDevOpsRouting.AzureDevOpsRestRoute,
    operation: string,
    number: number,
  ) =>
    rest
      .json(
        {
          ...AzureDevOpsRouting.credentials(route),
          operation,
          path: `_apis/git/pullrequests/${number}`,
        },
        RestPullRequestTargetSchema,
      )
      .pipe(
        Effect.map((pullRequest) => ({
          ...pullRequest,
          path: `${AzureDevOpsRest.repositoryPath(pullRequest.repository.project.id, pullRequest.repository.id)}/pullRequests/${number}`,
        })),
      );

  const restUpdatePullRequest = (
    route: AzureDevOpsRouting.AzureDevOpsRestRoute,
    operation: string,
    path: string,
    body: Record<string, unknown>,
  ) =>
    rest.request({
      ...AzureDevOpsRouting.credentials(route),
      operation,
      method: "PATCH",
      path,
      body,
    });

  type PullRequestListInput = Parameters<
    AzureDevOpsPullRequestApi["Service"]["listPullRequests"]
  >[0];

  /** Decoding can shorten a non-final page; advance by raw rows. */
  const collectPullRequests = (input: {
    readonly limit: number;
    readonly skip: number;
    readonly cursorAdvance: number;
    readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
    readonly page: (
      skip: number,
      top: number,
    ) => Effect.Effect<AzureDevOpsPullRequestBatch, AzureDevOpsPullRequestApiError>;
  }): Effect.Effect<
    {
      readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
      readonly truncated: boolean;
      readonly cursorAdvance: number;
    },
    AzureDevOpsPullRequestApiError
  > => {
    const remaining = input.limit - input.items.length;
    const top = remaining + 1;
    return input.page(input.skip, top).pipe(
      Effect.flatMap((batch) => {
        const lastItemIndex = batch.rawIndexes[remaining - 1];
        if (lastItemIndex !== undefined) {
          const consumed = lastItemIndex + 1;
          return Effect.succeed({
            items: [...input.items, ...batch.items.slice(0, remaining)],
            truncated: consumed < batch.rawCount || batch.rawCount === top,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }

        const items = [...input.items, ...batch.items];
        if (batch.rawCount < top) {
          return Effect.succeed({
            items,
            truncated: false,
            cursorAdvance: input.cursorAdvance + batch.rawCount,
          });
        }
        return collectPullRequests({
          ...input,
          skip: input.skip + batch.rawCount,
          cursorAdvance: input.cursorAdvance + batch.rawCount,
          items,
        });
      }),
    );
  };

  const cliPullRequestPage =
    (input: PullRequestListInput) =>
    (
      skip: number,
      top: number,
    ): Effect.Effect<AzureDevOpsPullRequestBatch, AzureDevOpsPullRequestApiError> =>
      executeJson({
        cwd: input.cwd,
        maxOutputBytes: PULL_REQUEST_LIST_MAX_OUTPUT_BYTES,
        args: [
          "repos",
          "pr",
          "list",
          ...detectArgs,
          "--repository",
          input.repository,
          "--status",
          azureStatus(input.state),
          ...involvementArgs(input),
          ...(input.author === undefined || input.involvement === "authored"
            ? []
            : ["--creator", input.author]),
          "--include-links",
          ...(skip === 0 ? [] : ["--skip", String(skip)]),
          "--top",
          String(top),
        ],
      }).pipe(
        Effect.flatMap((result) => {
          const raw = result.stdout.trim();
          if (raw.length === 0) return Effect.succeed(EMPTY_PULL_REQUEST_BATCH);
          const decoded = decodePullRequestListJson(raw);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new AzureDevOpsPullRequestReadError({
                  cwd: input.cwd,
                  operation: "listPullRequests",
                  cause: decoded.failure,
                }),
              );
        }),
      );

  /** Pages REST lists for the ids `--creator` and `--reviewer` would resolve the identities to. */
  const restPullRequestPager = Effect.fn("AzureDevOpsPullRequestApi.restPullRequestPager")(
    function* (route: AzureDevOpsRouting.AzureDevOpsRestRoute, input: PullRequestListInput) {
      const credentials = AzureDevOpsRouting.credentials(route);
      // The token's own user, as `--creator me` resolves it.
      const viewerId =
        input.involvement === "all"
          ? undefined
          : (yield* rest.json(
              {
                ...credentials,
                operation: "listPullRequests",
                path: "_apis/connectionData",
                apiVersion: "7.1-preview",
              },
              RestViewerIdSchema,
            )).authenticatedUser.id;
      const author =
        input.author === undefined || input.involvement === "authored" ? undefined : input.author;
      const authorId =
        author === undefined
          ? undefined
          : (yield* rest.json(
              {
                ...credentials,
                operation: "listPullRequests",
                area: "ims",
                path: "_apis/identities",
                query: { searchFilter: "General", filterValue: author, queryMembership: "None" },
              },
              RestIdentitiesSchema,
            )).value[0]?.id;
      if (author !== undefined && authorId === undefined) {
        return yield* new AzureDevOpsRest.AzureDevOpsRestError({
          operation: "listPullRequests",
          reason: "response",
          serverMessage: `Could not resolve identity: ${author}`,
        });
      }
      return (skip: number, top: number) =>
        restRead(
          route,
          {
            operation: "listPullRequests",
            path: `${AzureDevOpsRest.repositoryPath(route.project, input.repository)}/pullrequests`,
            query: {
              "searchCriteria.status": azureStatus(input.state),
              "searchCriteria.creatorId": input.involvement === "authored" ? viewerId : authorId,
              "searchCriteria.reviewerId": input.involvement === "reviewing" ? viewerId : undefined,
              "searchCriteria.includeLinks": true,
              $skip: skip === 0 ? undefined : skip,
              $top: top,
            },
            maxResponseBytes: PULL_REQUEST_LIST_MAX_OUTPUT_BYTES,
          },
          decodePullRequestPageJson,
        );
    },
  );

  const collectPolicyChecks = Effect.fn("AzureDevOpsPullRequestApi.collectPolicyChecks")(function* (
    cwd: string,
    page: (
      skip: number,
    ) => Effect.Effect<AzureDevOpsPolicyCheckPage, AzureDevOpsPullRequestApiError>,
  ) {
    const checks: PullRequestCheck[] = [];
    for (let skip = 0; skip < MAX_POLICY_EVALUATIONS; skip += POLICY_EVALUATIONS_PER_PAGE) {
      const answer = yield* page(skip);
      checks.push(...answer.checks);
      if (answer.rawCount < POLICY_EVALUATIONS_PER_PAGE) return sortChecks(checks);
    }
    return yield* new AzureDevOpsPullRequestReadError({
      cwd,
      operation: "listPolicyChecks",
      cause: "Policy evaluations exceeded the read limit",
    });
  });

  const collectIterationChanges = (
    page: (skip: number) => Effect.Effect<AzureDevOpsChangePage, AzureDevOpsPullRequestApiError>,
  ) => {
    const from = (
      skip: number,
      collected: ReadonlyArray<AzureDevOpsChangeEntry>,
    ): Effect.Effect<AzureDevOpsIterationChanges, AzureDevOpsPullRequestApiError> =>
      page(skip).pipe(
        Effect.flatMap((answer) => {
          const changes = [...collected, ...answer.changes];
          if (answer.nextSkip === null) return Effect.succeed({ changes, truncated: false });
          return answer.nextSkip <= skip || answer.nextSkip >= MAX_CHANGE_ENTRIES
            ? Effect.succeed({ changes, truncated: true })
            : from(answer.nextSkip, changes);
        }),
      );
    return from(0, []);
  };

  const cliViewer = (input: { readonly cwd: string }) =>
    executeJson({ cwd: input.cwd, args: ["account", "show", "--query", "user"] }).pipe(
      Effect.flatMap((result): Effect.Effect<string, AzureDevOpsPullRequestApiError> => {
        const decoded = decodeViewerJson(`{"user":${result.stdout.trim() || "null"}}`);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new AzureDevOpsPullRequestReadError({
              cwd: input.cwd,
              operation: "getViewer",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? Effect.fail(new AzureDevOpsViewerUnavailableError({ command: "az", cwd: input.cwd }))
          : Effect.succeed(decoded.success);
      }),
      // `az account show` cannot identify PAT logins; the extension resolves `--creator me`.
      Effect.catchIf(
        (error) => error._tag !== "AzureDevOpsCliUnavailableError",
        () =>
          executeJson({
            cwd: input.cwd,
            args: [
              "repos",
              "pr",
              "list",
              ...detectArgs,
              "--creator",
              "me",
              "--status",
              "all",
              "--top",
              "1",
            ],
          }).pipe(
            Effect.flatMap((result): Effect.Effect<string, AzureDevOpsPullRequestApiError> => {
              const decoded = decodePullRequestListJson(result.stdout.trim() || "[]");
              const login = Result.isSuccess(decoded)
                ? decoded.success.items[0]?.author?.login
                : undefined;
              return login === undefined
                ? Effect.fail(
                    new AzureDevOpsViewerUnavailableError({ command: "az", cwd: input.cwd }),
                  )
                : Effect.succeed(login);
            }),
          ),
      ),
    );

  return AzureDevOpsPullRequestApi.of({
    getViewer: Effect.fn("AzureDevOpsPullRequestApi.getViewer")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          rest
            .json(
              {
                organizationUrl: route.organizationUrl,
                token: route.token,
                operation: "getViewer",
                path: "_apis/connectionData",
                apiVersion: "7.1-preview",
              },
              RestViewerSchema,
            )
            .pipe(
              Effect.flatMap(({ authenticatedUser: user }) => {
                const account = user.properties.Account.$value.trim();
                // Azure DevOps Server names a Windows user by bare account, but pull requests
                // name them `DOMAIN\account`, which the identity's domain completes.
                if (/[@\\]/u.test(account)) return Effect.succeed(account);
                return rest
                  .json(
                    {
                      ...AzureDevOpsRouting.credentials(route),
                      operation: "getViewer",
                      area: "ims",
                      path: "_apis/identities",
                      query: { identityIds: user.id, queryMembership: "None" },
                    },
                    RestViewerDomainSchema,
                  )
                  .pipe(
                    Effect.map(({ value }) => {
                      const domain = value[0]?.properties?.Domain?.$value?.trim();
                      return domain ? `${domain}\\${account}` : account;
                    }),
                  );
              }),
            ),
        cli: () => cliViewer(input),
      });
    }),

    listPullRequests: Effect.fn("AzureDevOpsPullRequestApi.listPullRequests")(function (input) {
      const collect = (page: Parameters<typeof collectPullRequests>[0]["page"]) =>
        collectPullRequests({
          limit: input.limit,
          skip: input.cursor?.delivered ?? 0,
          cursorAdvance: 0,
          items: [],
          page,
        });
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) => restPullRequestPager(route, input).pipe(Effect.flatMap(collect)),
        cli: () => collect(cliPullRequestPage(input)),
      });
    }),

    getPullRequest: Effect.fn("AzureDevOpsPullRequestApi.getPullRequest")(function (input) {
      const complete = (
        pullRequest: AzureDevOpsPullRequest | null,
      ): Effect.Effect<AzureDevOpsPullRequest, AzureDevOpsPullRequestApiError> =>
        pullRequest === null
          ? Effect.fail(
              new AzureDevOpsPullRequestIncompleteError({
                cwd: input.cwd,
                number: input.number,
              }),
            )
          : Effect.succeed(pullRequest);
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restRead(
            route,
            { operation: "getPullRequest", path: `_apis/git/pullrequests/${input.number}` },
            decodePullRequestJson,
          ).pipe(Effect.flatMap(complete)),
        cli: () =>
          executeJson({
            cwd: input.cwd,
            args: ["repos", "pr", "show", ...detectArgs, "--id", String(input.number)],
          }).pipe(
            Effect.flatMap((result) => {
              const decoded = decodePullRequestJson(result.stdout.trim());
              return Result.isSuccess(decoded)
                ? complete(decoded.success)
                : Effect.fail(
                    new AzureDevOpsPullRequestReadError({
                      cwd: input.cwd,
                      operation: "getPullRequest",
                      cause: decoded.failure,
                    }),
                  );
            }),
          ),
      });
    }),

    listPolicyChecks: Effect.fn("AzureDevOpsPullRequestApi.listPolicyChecks")(function (input) {
      const unreadable = (cause: unknown) =>
        new AzureDevOpsPullRequestReadError({
          cwd: input.cwd,
          operation: "listPolicyChecks",
          cause,
        });
      return AzureDevOpsRouting.byRoute(routing, input, {
        // The artifact names the project by id, which only the pull request states.
        rest: (route) =>
          rest
            .json(
              {
                ...AzureDevOpsRouting.credentials(route),
                operation: "listPolicyChecks",
                path: `_apis/git/pullrequests/${input.number}`,
              },
              RestPullRequestProjectSchema,
            )
            .pipe(
              Effect.flatMap(({ repository: { project } }) =>
                collectPolicyChecks(input.cwd, (skip) =>
                  restRead(
                    route,
                    {
                      operation: "listPolicyChecks",
                      path: `${encodeURIComponent(project.id)}/_apis/policy/evaluations`,
                      apiVersion: "7.1-preview",
                      query: {
                        artifactId: `vstfs:///CodeReview/CodeReviewId/${project.id}/${input.number}`,
                        $top: POLICY_EVALUATIONS_PER_PAGE,
                        $skip: skip,
                      },
                    },
                    (raw) => decodePolicyChecksPageJson(raw, { isDraft: input.isDraft }),
                  ),
                ),
              ),
            ),
        cli: () =>
          collectPolicyChecks(input.cwd, (skip) =>
            executeJson({
              cwd: input.cwd,
              args: [
                "repos",
                "pr",
                "policy",
                "list",
                ...detectArgs,
                "--id",
                String(input.number),
                "--top",
                String(POLICY_EVALUATIONS_PER_PAGE),
                "--skip",
                String(skip),
              ],
            }).pipe(
              Effect.flatMap((result) => {
                if (result.stdoutTruncated) {
                  return Effect.fail(unreadable("Policy output was truncated"));
                }
                const page = decodePolicyChecksJson(result.stdout.trim(), {
                  isDraft: input.isDraft,
                });
                return Result.isSuccess(page)
                  ? Effect.succeed(page.success)
                  : Effect.fail(unreadable(page.failure));
              }),
            ),
          ),
      });
    }),

    listThreads: Effect.fn("AzureDevOpsPullRequestApi.listThreads")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restRead(
            route,
            {
              operation: "listThreads",
              path: `${restPullRequestPath(input)}/threads`,
              maxResponseBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
            },
            decodeThreadsJson,
          ),
        cli: () =>
          invoke({
            cwd: input.cwd,
            operation: "listThreads",
            resource: "pullRequestThreads",
            routeParameters: pullRequestRoute(input),
            maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
            decode: decodeThreadsJson,
          }),
      });
    }),

    listLabels: Effect.fn("AzureDevOpsPullRequestApi.listLabels")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restRead(
            route,
            { operation: "listLabels", path: `${restPullRequestPath(input)}/labels` },
            decodeLabelsJson,
          ),
        cli: () =>
          invoke({
            cwd: input.cwd,
            operation: "listLabels",
            resource: "pullRequestLabels",
            routeParameters: pullRequestRoute(input),
            decode: decodeLabelsJson,
          }),
      });
    }),

    listIterations: Effect.fn("AzureDevOpsPullRequestApi.listIterations")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restRead(
            route,
            {
              operation: "listIterations",
              path: `${restPullRequestPath(input)}/iterations`,
              maxResponseBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
            },
            decodeIterationsJson,
          ),
        cli: () =>
          invoke({
            cwd: input.cwd,
            operation: "listIterations",
            resource: "pullRequestIterations",
            routeParameters: pullRequestRoute(input),
            maxOutputBytes: REVIEW_HISTORY_MAX_OUTPUT_BYTES,
            decode: decodeIterationsJson,
          }),
      });
    }),

    listIterationChanges: Effect.fn("AzureDevOpsPullRequestApi.listIterationChanges")(
      function (input) {
        return AzureDevOpsRouting.byRoute(routing, input, {
          rest: (route) =>
            collectIterationChanges((skip) =>
              restRead(
                route,
                {
                  operation: "listIterationChanges",
                  path: `${restPullRequestPath(input)}/iterations/${input.iterationId}/changes`,
                  query: { $top: CHANGE_ENTRIES_PER_PAGE, $skip: skip },
                  maxResponseBytes: CHANGE_ENTRIES_MAX_OUTPUT_BYTES,
                },
                decodeIterationChangesJson,
              ),
            ),
          cli: () =>
            collectIterationChanges((skip) =>
              invoke({
                cwd: input.cwd,
                operation: "listIterationChanges",
                resource: "pullRequestIterationChanges",
                routeParameters: [...pullRequestRoute(input), `iterationId=${input.iterationId}`],
                queryParameters: [`$top=${CHANGE_ENTRIES_PER_PAGE}`, `$skip=${skip}`],
                maxOutputBytes: CHANGE_ENTRIES_MAX_OUTPUT_BYTES,
                decode: decodeIterationChangesJson,
              }),
            ),
        });
      },
    ),

    readBlobs: Effect.fn("AzureDevOpsPullRequestApi.readBlobs")(function* (input) {
      const requested = new Map<string, string>();
      // Azure states ids in uppercase and names entries in lowercase.
      for (const id of input.objectIds) {
        const key = id.toLowerCase();
        if (BLOB_ID.test(id) && !requested.has(key)) requested.set(key, id);
      }
      if (requested.size === 0) return new Map<string, AzureDevOpsItemContent>();
      const readFailure = (cause: unknown) =>
        new AzureDevOpsPullRequestReadError({
          cwd: input.cwd,
          operation: "readBlobs",
          cause,
        });
      const unpack = (zip: Uint8Array) => {
        const entries = readBlobZip(zip, BLOB_MAX_BYTES, BLOB_BATCH_MAX_BYTES);
        if (entries === null) {
          return Effect.fail(readFailure("Azure returned an unreadable archive."));
        }
        const contents = new Map<string, AzureDevOpsItemContent>();
        for (const [id, bytes] of entries) {
          const content = requested.has(id) ? blobContent(bytes) : null;
          if (content !== null) contents.set(id, content);
        }
        return Effect.succeed(contents);
      };
      return yield* AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          rest
            .request({
              ...AzureDevOpsRouting.credentials(route),
              operation: "readBlobs",
              method: "POST",
              path: `${AzureDevOpsRest.repositoryPath(input.location.project, input.location.repository)}/blobs`,
              body: [...requested.values()],
              accept: "application/zip",
              maxResponseBytes: BLOB_ARCHIVE_MAX_BYTES,
            })
            .pipe(
              Effect.flatMap((answer) =>
                answer.truncated
                  ? Effect.succeed(new Map<string, AzureDevOpsItemContent>())
                  : unpack(answer.bytes),
              ),
            ),
        cli: () =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fileSystem
                .makeTempDirectoryScoped({ prefix: "t3-azure-blobs-" })
                .pipe(Effect.mapError(readFailure));
              const request = `${directory}/ids.json`;
              // invoke refuses to overwrite its output, so the archive gets a name nothing holds yet.
              const archive = `${directory}/blobs.zip`;
              yield* fileSystem
                .writeFileString(
                  request,
                  `[${[...requested.values()].map((id) => `"${id}"`).join(",")}]`,
                )
                .pipe(Effect.mapError(readFailure));
              yield* azure.execute({
                cwd: input.cwd,
                args: [
                  "devops",
                  "invoke",
                  ...detectArgs,
                  "--area",
                  "git",
                  "--resource",
                  "blobs",
                  "--api-version",
                  REST_API_VERSION,
                  "--route-parameters",
                  ...repositoryRoute(input.location),
                  "--http-method",
                  "POST",
                  "--in-file",
                  request,
                  "--accept-media-type",
                  "application/zip",
                  "--out-file",
                  archive,
                  "--only-show-errors",
                ],
              });
              const size = yield* fileSystem.stat(archive).pipe(
                Effect.map((info) => Number(info.size)),
                Effect.mapError(readFailure),
              );
              if (size > BLOB_ARCHIVE_MAX_BYTES) return new Map<string, AzureDevOpsItemContent>();
              const zip = yield* fileSystem.readFile(archive).pipe(Effect.mapError(readFailure));
              return yield* unpack(zip);
            }),
          ),
      });
    }),

    readItemContent: Effect.fn("AzureDevOpsPullRequestApi.readItemContent")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restRead(
            route,
            {
              operation: "readItemContent",
              path: `${AzureDevOpsRest.repositoryPath(input.location.project, input.location.repository)}/items`,
              query: {
                path: toItemPath(input.path),
                "versionDescriptor.versionType": "commit",
                "versionDescriptor.version": input.commit,
                includeContent: true,
                includeContentMetadata: true,
                $format: "json",
              },
              maxResponseBytes: ITEM_CONTENT_MAX_OUTPUT_BYTES,
            },
            decodeItemContentJson,
          ),
        cli: () =>
          invoke({
            cwd: input.cwd,
            operation: "readItemContent",
            resource: "items",
            routeParameters: repositoryRoute(input.location),
            queryParameters: [
              // `az devops invoke` does not escape query values, so `#` or `&` in a path would truncate it.
              `path=${encodeURIComponent(toItemPath(input.path))}`,
              "versionDescriptor.versionType=commit",
              `versionDescriptor.version=${input.commit}`,
              "includeContent=true",
              // Encoded content cannot identify binaries; request Azure's binary flag.
              "includeContentMetadata=true",
              // `az devops invoke` requires JSON; otherwise Azure returns raw file bytes.
              "$format=json",
            ],
            maxOutputBytes: ITEM_CONTENT_MAX_OUTPUT_BYTES,
            decode: decodeItemContentJson,
          }),
      });
    }),

    setPullRequestReviewers: Effect.fn("AzureDevOpsPullRequestApi.setPullRequestReviewers")(
      function* (input) {
        if (input.reviewers.some((reviewer) => !isReviewerName(reviewer))) {
          return yield* new AzureDevOpsReviewerNameError({ cwd: input.cwd });
        }
        return yield* AzureDevOpsRouting.byRoute(routing, input, {
          rest: Effect.fn("AzureDevOpsPullRequestApi.restSetPullRequestReviewers")(
            function* (route) {
              const operation = "setPullRequestReviewers";
              const request = { ...AzureDevOpsRouting.credentials(route), operation };
              const identities = yield* Effect.forEach(input.reviewers, (reviewer) =>
                resolveIdentity(rest, request, reviewer),
              );
              const pullRequest = yield* restPullRequestTarget(route, operation, input.number);
              const current = new Map(
                (pullRequest.reviewers ?? []).map((reviewer) => [
                  reviewer.id.toLowerCase(),
                  reviewer,
                ]),
              );
              yield* Effect.forEach(
                identities,
                (identity) =>
                  rest.request({
                    ...request,
                    method: input.requested ? "PUT" : "DELETE",
                    path: `${pullRequest.path}/reviewers/${encodeURIComponent(identity.id)}`,
                    // PUT replaces the entry, so a required reviewer stays required.
                    ...(input.requested
                      ? {
                          body: {
                            vote: 0,
                            isRequired: current.get(identity.id.toLowerCase())?.isRequired ?? false,
                          },
                        }
                      : {}),
                  }),
                { discard: true },
              );
            },
          ),
          cli: () =>
            azure
              .execute({
                cwd: input.cwd,
                args: [
                  "repos",
                  "pr",
                  "reviewer",
                  input.requested ? "add" : "remove",
                  ...detectArgs,
                  "--id",
                  String(input.number),
                  // Repeating `--reviewers` replaces the earlier list.
                  "--reviewers",
                  ...input.reviewers,
                  "--only-show-errors",
                  "--output",
                  "json",
                ],
              })
              .pipe(Effect.asVoid),
        });
      },
    ),

    runPullRequestAction: Effect.fn("AzureDevOpsPullRequestApi.runPullRequestAction")(
      function (input) {
        const decodeUpdated = (raw: string) => {
          const decoded = decodePullRequestJson(raw);
          return Result.isSuccess(decoded) ? (decoded.success ?? undefined) : undefined;
        };
        return AzureDevOpsRouting.byRoute(routing, input, {
          rest: Effect.fn("AzureDevOpsPullRequestApi.restRunPullRequestAction")(function* (route) {
            const operation = "runPullRequestAction";
            const pullRequest = yield* restPullRequestTarget(route, operation, input.number);
            const viewerId =
              input.action === "enable-auto-merge"
                ? (yield* rest.json(
                    {
                      ...AzureDevOpsRouting.credentials(route),
                      operation,
                      path: "_apis/connectionData",
                      apiVersion: "7.1-preview",
                    },
                    RestViewerIdSchema,
                  )).authenticatedUser.id
                : NO_IDENTITY;
            const body = restActionBody(input.action, input.mergeMethod, {
              lastMergeSourceCommit: pullRequest.lastMergeSourceCommit,
              viewerId,
            });
            const answer =
              body === null
                ? yield* rest.request({
                    ...AzureDevOpsRouting.credentials(route),
                    operation,
                    path: pullRequest.path,
                  })
                : yield* restUpdatePullRequest(route, operation, pullRequest.path, body);
            return decodeUpdated(new TextDecoder().decode(answer.bytes));
          }),
          cli: () =>
            azure
              .execute({
                cwd: input.cwd,
                args: [
                  "repos",
                  "pr",
                  "update",
                  ...detectArgs,
                  "--id",
                  String(input.number),
                  ...actionArgs(input.action, input.mergeMethod),
                  "--only-show-errors",
                  "--output",
                  "json",
                ],
              })
              // `pr update` prints the pull request it left, in the shape `pr show` prints.
              .pipe(Effect.map((result) => decodeUpdated(result.stdout.trim()))),
        });
      },
    ),

    updatePullRequest: Effect.fn("AzureDevOpsPullRequestApi.updatePullRequest")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restPullRequestTarget(route, "updatePullRequest", input.number).pipe(
            Effect.flatMap((pullRequest) =>
              restUpdatePullRequest(route, "updatePullRequest", pullRequest.path, {
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.body === undefined ? {} : { description: input.body }),
              }),
            ),
            Effect.asVoid,
          ),
        cli: () => {
          // One argv entry preserves leading dashes and multi-string descriptions.
          const fields = [
            ...(input.title === undefined
              ? []
              : [AzureDevOpsApi.textOption("--title", input.title)]),
            ...(input.body === undefined
              ? []
              : [AzureDevOpsApi.textOption("--description", input.body)]),
          ];
          // az has one stdin, so each value read from it needs its own call.
          const batches =
            fields.filter((field) => field.stdin !== undefined).length > 1
              ? fields.map((field) => [field])
              : [fields];
          return Effect.forEach(
            batches,
            (batch) => {
              const stdin = batch.find((field) => field.stdin !== undefined)?.stdin;
              return azure.execute({
                cwd: input.cwd,
                args: [
                  "repos",
                  "pr",
                  "update",
                  ...detectArgs,
                  "--id",
                  String(input.number),
                  ...batch.map((field) => field.arg),
                  "--only-show-errors",
                  "--output",
                  "json",
                ],
                ...(stdin === undefined ? {} : { stdin }),
              });
            },
            { discard: true },
          );
        },
      });
    }),
  });
});

export const layer = Layer.effect(AzureDevOpsPullRequestApi, make);
