import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
  type VcsProcessExitFailureKind,
} from "@t3tools/contracts";

import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import type * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { AzureCliInstallLocation } from "./azureCliLauncher.ts";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  decodeAzureDevOpsPullRequestPageJson,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";
import { checkoutRemoteUrl, scopeFromRemoteUrl } from "./azureDevOpsRemote.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";
import * as AzureDevOpsClient from "../shared/definition.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

const DEFAULT_TIMEOUT_MS = 30_000;

const azureDevOpsCommandErrorFields = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("az"),
  cwd: Schema.String,
  argumentCount: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsCliUnavailableError extends Schema.TaggedError<AzureDevOpsCliUnavailableError>()(
  "AzureDevOpsCliUnavailableError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure CLI (`az`) with the Azure DevOps extension is required but not available on PATH.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCliAuthenticationError extends Schema.TaggedError<AzureDevOpsCliAuthenticationError>()(
  "AzureDevOpsCliAuthenticationError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps CLI is not authenticated. Run `az devops login` and retry.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCliRateLimitError extends Schema.TaggedError<AzureDevOpsCliRateLimitError>()(
  "AzureDevOpsCliRateLimitError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps API rate limit exceeded.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestNotFoundError extends Schema.TaggedError<AzureDevOpsPullRequestNotFoundError>()(
  "AzureDevOpsPullRequestNotFoundError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCommandFailedError extends Schema.TaggedError<AzureDevOpsCommandFailedError>()(
  "AzureDevOpsCommandFailedError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps CLI command failed.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "az";
      readonly cwd: string;
      readonly argumentCount: number;
    },
    cause: VcsError,
  ): AzureDevOpsCliError {
    const fields = { ...context, cause };

    if (
      cause._tag === "VcsProcessSpawnError" &&
      cause.cause instanceof PlatformError.PlatformError &&
      cause.cause.reason._tag === "NotFound" &&
      cause.cause.reason.pathOrDescriptor !== context.cwd &&
      cause.cause.reason.syscall !== "chdir"
    ) {
      return new AzureDevOpsCliUnavailableError(fields);
    }

    if (cause._tag === "VcsProcessExitError") {
      if (cause.failureKind === "authentication") {
        return new AzureDevOpsCliAuthenticationError(fields);
      }
      if (cause.failureKind === "rate-limited") {
        return new AzureDevOpsCliRateLimitError(fields);
      }
      if (cause.failureKind === "not-found") {
        return new AzureDevOpsPullRequestNotFoundError(fields);
      }
    }

    return new AzureDevOpsCommandFailedError(fields);
  }
}

const azureDevOpsDecodeErrorFields = {
  command: Schema.Literal("az"),
  cwd: Schema.String,
  outputLength: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsPullRequestListDecodeError extends Schema.TaggedError<AzureDevOpsPullRequestListDecodeError>()(
  "AzureDevOpsPullRequestListDecodeError",
  {
    operation: Schema.Literal("listPullRequests"),
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestDecodeError extends Schema.TaggedError<AzureDevOpsPullRequestDecodeError>()(
  "AzureDevOpsPullRequestDecodeError",
  {
    operation: Schema.Literal("getPullRequest"),
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

const AzureDevOpsRepositoryDecodeOperation = Schema.Literals([
  "getRepositoryCloneUrls",
  "getDefaultBranch",
  "createRepository",
]);

export class AzureDevOpsRepositoryDecodeError extends Schema.TaggedError<AzureDevOpsRepositoryDecodeError>()(
  "AzureDevOpsRepositoryDecodeError",
  {
    operation: AzureDevOpsRepositoryDecodeOperation,
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export const AzureDevOpsCliError = Schema.Union([
  AzureDevOpsRouting.AzureDevOpsTokenRequiredError,
  AzureDevOpsCliUnavailableError,
  AzureDevOpsCliAuthenticationError,
  AzureDevOpsCliRateLimitError,
  AzureDevOpsPullRequestNotFoundError,
  AzureDevOpsCommandFailedError,
  AzureDevOpsPullRequestListDecodeError,
  AzureDevOpsPullRequestDecodeError,
  AzureDevOpsRepositoryDecodeError,
]);
export type AzureDevOpsCliError = typeof AzureDevOpsCliError.Type;

/** A call that an organization with a saved token sends over REST instead. */
export type AzureDevOpsRoutedError =
  | AzureDevOpsCliError
  | AzureDevOpsRest.AzureDevOpsRestError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | AzureDevOpsRouting.AzureDevOpsRouteError;

export interface AzureDevOpsRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class AzureDevOpsApi extends Context.Service<
  AzureDevOpsApi,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      /** The remote T3 selected; without one, the checkout's primary remote scopes the command. */
      readonly remoteUrl?: string;
      readonly stdin?: string;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
      readonly remoteUrl?: string;
    }) => Effect.Effect<
      ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>,
      AzureDevOpsRoutedError
    >;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<NormalizedAzureDevOpsPullRequestRecord, AzureDevOpsRoutedError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsRoutedError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsRoutedError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<void, AzureDevOpsRoutedError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<string | null, AzureDevOpsRoutedError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsApi") {}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pullrequest|pull-request|pull|_pulls?)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function toAzureStatus(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "active";
    case "closed":
      return "abandoned";
    case "merged":
      return "completed";
    case "all":
      return "all";
  }
}

const RawAzureDevOpsRepositorySchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  webUrl: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  project: Schema.optional(
    Schema.Struct({
      name: TrimmedNonEmptyString,
    }),
  ),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
});

const RestProjectSchema = Schema.Struct({ id: TrimmedNonEmptyString });

const qualifiedBranch = (name: string) => (name.startsWith("refs/") ? name : `refs/heads/${name}`);

function normalizeDefaultBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^refs\/heads\//, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Azure DevOps Server answers a space in a name literally, which git cannot clone from. */
function escapedUrl(url: string): string {
  return url.includes("://") ? (URL.parse(url)?.href ?? url) : url;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawAzureDevOpsRepositorySchema>,
): AzureDevOpsRepositoryCloneUrls {
  const projectName = raw.project?.name.trim();
  return {
    nameWithOwner: projectName ? `${projectName}/${raw.name}` : raw.name,
    url: escapedUrl(raw.remoteUrl),
    sshUrl: escapedUrl(raw.sshUrl),
  };
}

function parseRepositorySpecifier(repository: string): {
  readonly organization: string | null;
  readonly project: string | null;
  readonly name: string;
} {
  const parts: Array<string> = [];
  for (const part of repository.split("/")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  return {
    // A collection is named with its server: `{host}/[tfs/]{collection}/{project}/{name}`.
    organization: parts.length > 2 ? parts.slice(0, -2).join("/") : null,
    project: parts.length > 1 ? (parts.at(-2) ?? null) : null,
    name: parts.at(-1) ?? repository.trim(),
  };
}

function decodeAzureDevOpsJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: typeof AzureDevOpsRepositoryDecodeOperation.Type,
  cwd: string,
): Effect.Effect<S["Type"], AzureDevOpsRepositoryDecodeError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AzureDevOpsRepositoryDecodeError({
          operation,
          command: "az",
          cwd,
          outputLength: raw.length,
          cause,
        }),
    ),
  );
}

const remoteOf = (input: { readonly remoteUrl?: string }) =>
  input.remoteUrl === undefined ? {} : { remoteUrl: input.remoteUrl };

const hasOption = (args: ReadonlyArray<string>, pattern: RegExp) =>
  args.some((arg) => pattern.test(arg));

/** Whether `az` would run `--detect true`, which inspects the checkout from wherever `az` runs. */
const detectsScope = (args: ReadonlyArray<string>) => {
  const detect = args.indexOf("--detect");
  return (
    args[0] !== "account" &&
    detect !== -1 &&
    args[detect + 1] === "true" &&
    !hasOption(args, /^(?:--organization|--org)(?:=|$)/u)
  );
};

/** Replaces `--detect true` with the scope of an Azure remote. */
function organizationOption(args: ReadonlyArray<string>): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === "--organization" || arg === "--org") return args[index + 1];
    const joined = /^--(?:organization|org)=(.*)$/su.exec(arg);
    if (joined) return joined[1];
  }
  return undefined;
}

export function scopeAzureCliArgs(
  args: ReadonlyArray<string>,
  remoteUrl: string,
): ReadonlyArray<string> {
  const scope = detectsScope(args) ? scopeFromRemoteUrl(remoteUrl) : null;
  if (!scope) return args;
  const scoped = [...args, "--organization", scope.organization];
  scoped[args.indexOf("--detect") + 1] = "false";
  // PR-ID commands and devops invoke accept only organization scope.
  const acceptsProject =
    args[0] === "repos" &&
    (args[1] === "show" ||
      args[1] === "create" ||
      (args[1] === "pr" && (args[2] === "list" || args[2] === "create")));
  if (!acceptsProject) return scoped;
  // Joined so a name starting with `-` stays the option's value.
  if (!hasOption(args, /^(?:--project|-p)(?:=|$)/u)) scoped.push(`--project=${scope.project}`);
  if (args[1] !== "create" && !hasOption(args, /^(?:--repository|-r)(?:=|$)/u)) {
    scoped.push(`--repository=${scope.repository}`);
  }
  return scoped;
}

const classifyAzFailure = (stderr: string): VcsProcessExitFailureKind | null => {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("az devops login") || /please run '?az login'?/.test(normalized)) {
    return "authentication";
  }
  // Azure DevOps reports usage-limit throttling as TF400733, often without an HTTP status.
  if (normalized.includes("tf400733")) return "rate-limited";
  return normalized.includes("pull request") &&
    (normalized.includes("not found") || normalized.includes("does not exist"))
    ? "not-found"
    : null;
};

export interface AzureCliInvocation {
  readonly command: string;
  /** Arguments `az` needs before the caller's, to run the CLI in UTF-8 mode. */
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * `-X utf8` is the only way in: the launcher's `-I` implies `-E`, so `PYTHONUTF8` and
 * `PYTHONIOENCODING` are ignored, and the ANSI code page loses text `az` cannot encode.
 * Resolved once when the service is built: installing `az` later needs a restart.
 */
export const azureCliInvocation = Effect.fn("AzureDevOpsApi.invocation")(function* () {
  if ((yield* HostProcess.Platform) !== "win32") {
    return { command: "az", args: [] } satisfies AzureCliInvocation;
  }
  const resolveExecutable = yield* SpawnExecutableResolution;
  const launcher = resolveExecutable("az", "win32", yield* HostProcess.Environment);
  const installFor = yield* AzureCliInstallLocation;
  const install = launcher === undefined ? undefined : installFor(launcher);
  // Unrecognized installs (pipx's Scripts\az.exe) keep the launcher and today's decode.
  return install === undefined
    ? ({ command: "az", args: [] } satisfies AzureCliInvocation)
    : ({
        command: install.interpreter,
        args: ["-X", "utf8", "-IBm", "azure.cli"],
        // What the launcher sets before running this same interpreter.
        env: { AZ_INSTALLER: install.installer },
      } satisfies AzureCliInvocation);
});

/**
 * `--option=value` for free text. az replaces a value starting with `@` by that file's
 * contents; `@-` reads it from stdin instead, which reaches az wherever it runs (WSL included).
 */
export const textOption = (option: string, value: string) =>
  value.startsWith("@")
    ? { arg: `${option}=@-`, stdin: value }
    : { arg: `${option}=${value}`, stdin: undefined };

/** @public */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const rest = yield* AzureDevOpsRest.AzureDevOpsRest;
  const routing = yield* AzureDevOpsRouting.AzureDevOpsRouting;
  const fileSystem = yield* FileSystem.FileSystem;
  const invocation = yield* azureCliInvocation();

  const execute: AzureDevOpsApi["Service"]["execute"] = Effect.fn("AzureDevOpsApi.execute")(
    function* (input) {
      let args = input.args;
      // `az` refuses Azure DevOps Server, which only a saved token reaches. A command naming no
      // organization, such as `account show`, answers for whichever one the checkout is in.
      let organization = organizationOption(args);
      if (detectsScope(args) || organization === undefined) {
        // Windows az running in WSL cannot inspect the server's Linux checkout.
        const remoteUrl =
          input.remoteUrl ?? (yield* checkoutRemoteUrl(process, input.cwd, input.timeoutMs));
        if (remoteUrl !== null) {
          args = scopeAzureCliArgs(args, remoteUrl);
          organization ??= scopeFromRemoteUrl(remoteUrl)?.organizationUrl;
        }
      }
      const organizationUrl =
        organization === undefined
          ? null
          : AzureDevOpsClient.azureDevOpsOrganizationUrl(
              organization.replace(/^http:/iu, "https:"),
            );
      if (
        organizationUrl !== null &&
        !AzureDevOpsClient.isAzureDevOpsServicesUrl(organizationUrl)
      ) {
        return yield* new AzureDevOpsRouting.AzureDevOpsTokenRequiredError({ organizationUrl });
      }
      return yield* process
        .run({
          operation: "AzureDevOpsApi.execute",
          command: invocation.command,
          args: [...invocation.args, ...args],
          cwd: input.cwd,
          ...(invocation.env === undefined ? {} : { env: invocation.env }),
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          classifyFailure: classifyAzFailure,
          notFoundDetail: "Pull request not found.",
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
        })
        .pipe(
          Effect.mapError((error) =>
            AzureDevOpsCommandFailedError.fromVcsError(
              {
                operation: "execute",
                command: "az",
                cwd: input.cwd,
                argumentCount: input.args.length,
              },
              error,
            ),
          ),
        );
    },
  );

  const executeJson = (input: Parameters<AzureDevOpsApi["Service"]["execute"]>[0]) =>
    execute({
      ...input,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  type ListInput = Parameters<AzureDevOpsApi["Service"]["listPullRequests"]>[0];
  const cliListPullRequests = (input: ListInput, branch: string, refPrefix: string) =>
    executeJson({
      cwd: input.cwd,
      ...remoteOf(input),
      args: [
        "repos",
        "pr",
        "list",
        "--detect",
        "true",
        "--source-branch",
        // az puts this in the query string unescaped; a `#` would cut the request.
        refPrefix + encodeURIComponent(branch.slice(refPrefix.length)),
        "--status",
        toAzureStatus(input.state),
        "--top",
        String(input.limit ?? 20),
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        raw.length === 0
          ? Effect.succeed([])
          : Effect.sync(() => decodeAzureDevOpsPullRequestListJson(raw)).pipe(
              Effect.flatMap((decoded) => {
                if (!Result.isSuccess(decoded)) {
                  return Effect.fail(
                    new AzureDevOpsPullRequestListDecodeError({
                      operation: "listPullRequests",
                      command: "az",
                      cwd: input.cwd,
                      outputLength: raw.length,
                      cause: decoded.failure,
                    }),
                  );
                }

                return Effect.succeed(decoded.success);
              }),
            ),
      ),
    );

  const cliGetPullRequest = (input: Parameters<AzureDevOpsApi["Service"]["getPullRequest"]>[0]) =>
    executeJson({
      cwd: input.cwd,
      ...remoteOf(input),
      args: [
        "repos",
        "pr",
        "show",
        "--detect",
        "true",
        "--id",
        normalizeChangeRequestId(input.reference),
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        Effect.sync(() => decodeAzureDevOpsPullRequestJson(raw)).pipe(
          Effect.flatMap((decoded) => {
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                new AzureDevOpsPullRequestDecodeError({
                  operation: "getPullRequest",
                  command: "az",
                  cwd: input.cwd,
                  outputLength: raw.length,
                  cause: decoded.failure,
                }),
              );
            }

            return Effect.succeed(decoded.success);
          }),
        ),
      ),
    );

  type RepositoryInput = Parameters<AzureDevOpsApi["Service"]["getRepositoryCloneUrls"]>[0];
  /** A named project wins, as for `az repos show --project`; otherwise the remote's. */
  const restRepository = (
    route: AzureDevOpsRouting.AzureDevOpsRestRoute,
    specifier: string,
    operation: typeof AzureDevOpsRepositoryDecodeOperation.Type,
  ) => {
    const repository = parseRepositorySpecifier(specifier);
    return rest.json(
      {
        ...AzureDevOpsRouting.credentials(route),
        operation,
        path: AzureDevOpsRest.repositoryPath(repository.project ?? route.project, repository.name),
      },
      RawAzureDevOpsRepositorySchema,
    );
  };

  const cliGetRepositoryCloneUrls = (input: RepositoryInput) => {
    const repository = parseRepositorySpecifier(input.repository);
    return executeJson({
      cwd: input.cwd,
      ...remoteOf(input),
      args: [
        "repos",
        "show",
        "--detect",
        "true",
        "--repository",
        repository.name,
        ...(repository.project ? ["--project", repository.project] : []),
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        decodeAzureDevOpsJson(
          raw,
          RawAzureDevOpsRepositorySchema,
          "getRepositoryCloneUrls",
          input.cwd,
        ),
      ),
      Effect.map(normalizeRepositoryCloneUrls),
    );
  };

  const cliGetDefaultBranch = (input: RepositoryInput) => {
    const repository = parseRepositorySpecifier(input.repository);
    return executeJson({
      cwd: input.cwd,
      ...remoteOf(input),
      args: [
        "repos",
        "show",
        "--detect",
        "true",
        // Joined so a name starting with `-` stays the option's value.
        `--repository=${repository.name}`,
        ...(repository.project ? ["--project", repository.project] : []),
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "getDefaultBranch", input.cwd),
      ),
      Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
    );
  };

  return AzureDevOpsApi.of({
    execute,
    listPullRequests: Effect.fn("AzureDevOpsApi.listPullRequests")(function (input) {
      const branch = SourceControlProvider.sourceBranch(input);
      // az checks literal ref prefixes before constructing the request URL.
      const refPrefix =
        ["refs/heads/", "refs/pull/", "refs/tags/"].find((prefix) => branch.startsWith(prefix)) ??
        "";
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          rest
            .request({
              ...AzureDevOpsRouting.credentials(route),
              operation: "listPullRequests",
              path: `${AzureDevOpsRest.repositoryPath(route.project, route.repository)}/pullrequests`,
              query: {
                // az qualifies a bare branch name the same way.
                "searchCriteria.sourceRefName": refPrefix === "" ? `refs/heads/${branch}` : branch,
                "searchCriteria.status": toAzureStatus(input.state),
                $top: input.limit ?? 20,
              },
            })
            .pipe(
              Effect.flatMap(
                AzureDevOpsRest.decodeAnswer(
                  "listPullRequests",
                  decodeAzureDevOpsPullRequestPageJson,
                ),
              ),
            ),
        cli: () => cliListPullRequests(input, branch, refPrefix),
      });
    }),
    getPullRequest: Effect.fn("AzureDevOpsApi.getPullRequest")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          rest
            .request({
              ...AzureDevOpsRouting.credentials(route),
              operation: "getPullRequest",
              path: `_apis/git/pullrequests/${encodeURIComponent(normalizeChangeRequestId(input.reference))}`,
            })
            .pipe(
              Effect.flatMap(
                AzureDevOpsRest.decodeAnswer("getPullRequest", decodeAzureDevOpsPullRequestJson),
              ),
            ),
        cli: () => cliGetPullRequest(input),
      });
    }),
    getRepositoryCloneUrls: Effect.fn("AzureDevOpsApi.getRepositoryCloneUrls")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restRepository(route, input.repository, "getRepositoryCloneUrls").pipe(
            Effect.map(normalizeRepositoryCloneUrls),
          ),
        cli: () => cliGetRepositoryCloneUrls(input),
      });
    }),
    getDefaultBranch: Effect.fn("AzureDevOpsApi.getDefaultBranch")(function (input) {
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          restRepository(route, input.repository, "getDefaultBranch").pipe(
            Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
          ),
        cli: () => cliGetDefaultBranch(input),
      });
    }),

    createRepository: Effect.fn("AzureDevOpsApi.createRepository")(function* (input) {
      const repository = parseRepositorySpecifier(input.repository);
      // Project/organization permissions control visibility; `az repos create` has no flag.
      const restCreate = (
        route: Pick<AzureDevOpsRouting.AzureDevOpsRestRoute, "organizationUrl" | "token">,
        project: string,
      ) => {
        const credentials = {
          ...AzureDevOpsRouting.credentials(route),
          operation: "createRepository",
        };
        return rest
          .json(
            { ...credentials, path: `_apis/projects/${encodeURIComponent(project)}` },
            RestProjectSchema,
          )
          .pipe(
            Effect.flatMap(({ id }) =>
              rest.json(
                {
                  ...credentials,
                  method: "POST",
                  path: `${encodeURIComponent(project)}/_apis/git/repositories`,
                  body: { name: repository.name, project: { id } },
                },
                RawAzureDevOpsRepositorySchema,
              ),
            ),
            Effect.map(normalizeRepositoryCloneUrls),
          );
      };
      const cliCreate = (organizationUrl: string | null) =>
        executeJson({
          cwd: input.cwd,
          args: [
            "repos",
            "create",
            ...(organizationUrl === null
              ? ["--detect", "true"]
              : ["--detect", "false", "--organization", organizationUrl]),
            "--name",
            repository.name,
            ...(repository.project ? ["--project", repository.project] : []),
          ],
        }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.flatMap((raw) =>
            decodeAzureDevOpsJson(
              raw,
              RawAzureDevOpsRepositorySchema,
              "createRepository",
              input.cwd,
            ),
          ),
          Effect.map(normalizeRepositoryCloneUrls),
        );

      // `organization/project/repository` names the organization; it wins over the checkout's.
      const { organization, project } = repository;
      if (organization !== null && project !== null) {
        const route = yield* routing.resolveOrganization(organization);
        return route._tag === "Rest"
          ? yield* restCreate(route, project)
          : yield* cliCreate(`https://dev.azure.com/${encodeURIComponent(organization)}`);
      }
      return yield* AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) => restCreate(route, project ?? route.project),
        cli: () => cliCreate(null),
      });
    }),
    createPullRequest: Effect.fn("AzureDevOpsApi.createPullRequest")(function (input) {
      const target = input.target?.refName ?? input.baseBranch;
      const source = SourceControlProvider.sourceBranch(input);
      return AzureDevOpsRouting.byRoute(routing, input, {
        rest: (route) =>
          fileSystem.readFileString(input.bodyFile).pipe(
            Effect.mapError(
              (cause) =>
                new AzureDevOpsRest.AzureDevOpsRestError({
                  operation: "createPullRequest",
                  reason: "request",
                  cause,
                }),
            ),
            Effect.flatMap((description) =>
              rest.request({
                ...AzureDevOpsRouting.credentials(route),
                operation: "createPullRequest",
                method: "POST",
                path: `${AzureDevOpsRest.repositoryPath(route.project, route.repository)}/pullrequests`,
                // az qualifies a bare branch name the same way.
                body: {
                  sourceRefName: qualifiedBranch(source),
                  targetRefName: qualifiedBranch(target),
                  title: input.title,
                  description,
                },
              }),
            ),
            Effect.asVoid,
          ),
        cli: () => {
          // A full ref keeps a branch named `@...` from reading as a file; az accepts either form.
          const branch = (name: string) => (name.startsWith("@") ? `refs/heads/${name}` : name);
          const title = textOption("--title", input.title);
          return execute({
            cwd: input.cwd,
            ...remoteOf(input),
            args: [
              "repos",
              "pr",
              "create",
              "--only-show-errors",
              "--detect",
              "true",
              `--target-branch=${branch(target)}`,
              `--source-branch=${branch(source)}`,
              title.arg,
              // Joined: az expands a separate `@file` value again, so a body of `@path` read that file.
              `--description=@${input.bodyFile}`,
            ],
            ...(title.stdin === undefined ? {} : { stdin: title.stdin }),
          }).pipe(Effect.asVoid);
        },
      });
    }),
  });
});

export const layer = Layer.effect(AzureDevOpsApi, make);
