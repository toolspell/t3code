import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { AzureCliInstallLocation, type AzureCliInstall } from "./azureCliLauncher.ts";
import * as AzureDevOpsApi from "./AzureDevOpsApi.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";
import { scopeAzureCliArgs } from "./AzureDevOpsApi.ts";

const processOutput = (stdout: string): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();

// The CLI layer is exercised on a host that spawns `az` itself, so the launcher upgrade stays out of these assertions.
const layerSupport = Layer.mergeAll(
  TestSourceControlHost.layer({
    // No remotes: these cases leave `--detect true` to az.
    process: {
      run: (input) =>
        input.command === "git" ? Effect.succeed(processOutput("")) : mockRun(input),
    },
  }),
  NodeServices.layer,
  Layer.succeed(HostProcess.Platform, "linux"),
);
// No saved token: every call takes the Azure CLI, and REST must not be reached.
const layer = Layer.mergeAll(
  AzureDevOpsApi.layer.pipe(
    Layer.provide(AzureDevOpsRouting.layer),
    Layer.provide(Layer.mock(AzureDevOpsRest.AzureDevOpsRest)({})),
    Layer.provide(layerSupport),
  ),
  layerSupport,
);

afterEach(() => {
  mockRun.mockReset();
});

describe("AzureDevOpsApi.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add Azure provider",
              sourceRefName: "refs/heads/feature/source-control",
              targetRefName: "refs/heads/main",
              lastMergeSourceCommit: { commitId: "a".repeat(40) },
              status: "active",
              creationDate: "2026-01-02T00:00:00.000Z",
              closedDate: null,
              _links: {
                web: {
                  href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
                },
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "#42",
        // The selected remote numbers the pull request, whatever the checkout's primary remote.
        remoteUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.url, "https://dev.azure.com/acme/project/_git/repo/pullrequest/42");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.headSha, "a".repeat(40));
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      const { classifyFailure, ...call } = mockRun.mock.calls.at(-1)?.[0] ?? {};
      assert.strictEqual(
        classifyFailure?.("Please run az login to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("Please run 'az login' to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("TF401180: The requested pull request was not found."),
        "not-found",
      );
      assert.strictEqual(
        classifyFailure?.(
          "ERROR: TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource 'Global' in namespace 'User'.",
        ),
        "rate-limited",
      );
      assert.deepStrictEqual(call, {
        operation: "AzureDevOpsApi.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "false",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
          "--organization",
          "https://dev.azure.com/acme",
        ],
        cwd: "/repo",
        notFoundDetail: "Pull request not found.",
        timeoutMs: 30_000,
      });
      assert.strictEqual(result.isCrossRepository, false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks a pull request from a fork as cross-repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 43,
              title: "From a fork",
              sourceRefName: "refs/heads/main",
              targetRefName: "refs/heads/main",
              status: "active",
              forkSource: { name: "refs/heads/main", repository: { name: "repo-fork" } },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      const result = yield* az.getPullRequest({ cwd: "/repo", reference: "43" });

      assert.strictEqual(result.isCrossRepository, true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("builds a web URL when Azure returns only the pull request REST URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 863,
              title: "Fix Azure link",
              url: "https://dev.azure.com/saplyai/a8fe4088-ad76-4eda-aaaa-e3329713a097/_apis/git/repositories/16108a25-93a3-4eff-b77d-85e894ee0fe4/pullRequests/863",
              repository: {
                name: "CV-engine",
                project: {
                  name: "CV-engine",
                },
              },
              sourceRefName: "refs/heads/feature/azure-pr-link",
              targetRefName: "refs/heads/main",
              status: "active",
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "863",
      });

      assert.strictEqual(
        result.url,
        "https://dev.azure.com/saplyai/CV-engine/_git/CV-engine/pullrequest/863",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      const result = yield* az.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "repo",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("looks up a project/repository path as that project's repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: { name: "project" },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      yield* az.getRepositoryCloneUrls({ cwd: "/somewhere", repository: "project/repo" });

      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0].args, [
        "repos",
        "show",
        "--detect",
        "true",
        "--repository",
        "repo",
        "--project",
        "project",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("percent-encodes the source branch while preserving recognized ref prefixes", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      yield* az.listPullRequests({
        cwd: "/somewhere",
        headSelector: "user/feat/1-(#2)-slug",
        state: "open",
      });

      const args = mockRun.mock.calls.at(-1)?.[0].args ?? [];
      assert.strictEqual(args[args.indexOf("--source-branch") + 1], "user%2Ffeat%2F1-(%232)-slug");

      for (const prefix of ["refs/heads/", "refs/pull/", "refs/tags/"]) {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
        yield* az.listPullRequests({
          cwd: "/somewhere",
          headSelector: "fallback",
          source: { refName: `${prefix}user/feat/1-(#2)-slug` },
          state: "open",
        });

        const refArgs = mockRun.mock.calls.at(-1)?.[0].args ?? [];
        assert.strictEqual(
          refArgs[refArgs.indexOf("--source-branch") + 1],
          `${prefix}user%2Ffeat%2F1-(%232)-slug`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sends a title that looks like `@path` as text, not as a file for az to read", () =>
    Effect.gen(function* () {
      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      for (const title of ["@notes.txt", "a=@notes.txt"]) {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
        yield* az.createPullRequest({
          cwd: "/somewhere",
          baseBranch: "main",
          headSelector: "feature",
          title,
          bodyFile: "/tmp/body.md",
        });

        // az replaces an argument that starts with `@`, or whose text after the first `=` does, with that file's contents.
        const fileReads = (mockRun.mock.calls.at(-1)?.[0].args ?? []).flatMap((arg) => {
          const value = arg.startsWith("@") ? arg : arg.slice(arg.indexOf("=") + 1);
          return (arg.startsWith("@") || arg.includes("=")) && value.startsWith("@")
            ? [value.slice(1)]
            : [];
        });
        expect(fileReads).not.toContain("notes.txt");
        expect(mockRun.mock.calls.at(-1)?.[0].stdin).toBe(
          title.startsWith("@") ? title : undefined,
        );
        // az expands a separate `@file` value a second time, so a body of `@notes.txt` read notes.txt.
        expect(mockRun.mock.calls.at(-1)?.[0].args).toContain("--description=@/tmp/body.md");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves VCS causes without copying upstream details into messages", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsApi.execute",
        command: "az repos list --organization sensitive-upstream-detail",
        cwd: "/repo",
        exitCode: 1,
        detail: "sensitive-upstream-detail",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsApi.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.operation, "execute");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.argumentCount, 2);
      assert.strictEqual(error.detail, "Azure DevOps CLI command failed.");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes("sensitive-upstream-detail"), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not report a missing working directory as a missing Azure CLI", () =>
    Effect.gen(function* () {
      const cwd = "/missing/repo";
      const platformCause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        syscall: "chdir",
        pathOrDescriptor: cwd,
      });
      const cause = new VcsProcessSpawnError({
        operation: "AzureDevOpsApi.execute",
        command: "az",
        cwd,
        argumentCount: 2,
        cause: platformCause,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      const error = yield* az.execute({ cwd, args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsApi.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.cwd, cwd);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsApi.execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 2,
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsApi.AzureDevOpsApi;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsApi.AzureDevOpsCliRateLimitError);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );
});

describe("AzureDevOpsApi over REST", () => {
  /** `saveToken(false)` runs a call through `az`, `saveToken(true)` through `respond`. */
  function routed(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const az = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
      Effect.die("An organization with a saved token must not reach az."),
    );
    const support = Layer.mergeAll(
      TestSourceControlHost.layer({
        process: {
          run: (input) =>
            input.command === "git"
              ? Effect.succeed(
                  processOutput(
                    "origin\thttps://dev.azure.com/contoso/Web%20Site/_git/web%20app (fetch)\n",
                  ),
                )
              : az(input),
        },
      }),
      NodeServices.layer,
      Layer.succeed(HostProcess.Platform, "linux"),
    );
    const layer = AzureDevOpsApi.layer.pipe(
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
      Layer.provideMerge(support),
    );
    const saveToken = TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
      settings.update({
        sourceControlHosts: {
          "azure-devops": { tokens: { "https://dev.azure.com/contoso": "contoso-pat" } },
        },
      }),
    );
    return { requests, az, layer, saveToken };
  }

  const pullRequest = {
    pullRequestId: 42,
    title: "Add the page",
    sourceRefName: "refs/heads/user/feat#1",
    targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: "a".repeat(40) },
    status: "active",
    creationDate: "2026-07-01T00:00:00.1234567Z",
    repository: {
      name: "web app",
      webUrl: "https://dev.azure.com/contoso/Web%20Site/_git/web%20app",
      project: { name: "Web Site" },
    },
  };
  const repository = {
    name: "repo",
    webUrl: "https://dev.azure.com/contoso/Other%20Project/_git/repo",
    remoteUrl: "https://contoso@dev.azure.com/contoso/Other%20Project/_git/repo",
    sshUrl: "git@ssh.dev.azure.com:v3/contoso/Other%20Project/repo",
    project: { name: "Other Project" },
    defaultBranch: "refs/heads/trunk",
  };
  type Az = AzureDevOpsApi.AzureDevOpsApi["Service"];

  it.effect.each([
    {
      read: "a branch's pull requests",
      call: (az: Az) =>
        az.listPullRequests({ cwd: "/w", headSelector: "user/feat#1", state: "open", limit: 5 }),
      body: { count: 1, value: [pullRequest] },
      azOutput: [pullRequest],
      path: "/contoso/Web%20Site/_apis/git/repositories/web%20app/pullrequests",
      query: {
        "searchCriteria.sourceRefName": "refs/heads/user/feat#1",
        "searchCriteria.status": "active",
        $top: "5",
      },
    },
    {
      read: "a fully named source ref's pull requests",
      call: (az: Az) =>
        az.listPullRequests({
          cwd: "/w",
          headSelector: "fallback",
          source: { refName: "refs/pull/7/merge" },
          state: "all",
        }),
      body: { count: 0, value: [] },
      azOutput: [],
      path: "/contoso/Web%20Site/_apis/git/repositories/web%20app/pullrequests",
      query: {
        "searchCriteria.sourceRefName": "refs/pull/7/merge",
        "searchCriteria.status": "all",
        $top: "20",
      },
    },
    {
      read: "a pull request by its URL",
      call: (az: Az) =>
        az.getPullRequest({
          cwd: "/w",
          reference: "https://dev.azure.com/contoso/Web%20Site/_git/web%20app/pullrequest/42",
        }),
      body: pullRequest,
      azOutput: pullRequest,
      path: "/contoso/_apis/git/pullrequests/42",
      query: {},
    },
    {
      read: "another project's clone URLs",
      call: (az: Az) => az.getRepositoryCloneUrls({ cwd: "/w", repository: "Other Project/repo" }),
      body: repository,
      azOutput: repository,
      path: "/contoso/Other%20Project/_apis/git/repositories/repo",
      query: {},
    },
    {
      read: "the remote's default branch",
      call: (az: Az) => az.getDefaultBranch({ cwd: "/w", repository: "web app" }),
      body: repository,
      azOutput: repository,
      path: "/contoso/Web%20Site/_apis/git/repositories/web%20app",
      query: {},
    },
  ])("reads $read over REST as az reads it", ({ call, body, azOutput, path, query }) => {
    const { requests, az, layer, saveToken } = routed(() => Response.json(body));
    return Effect.gen(function* () {
      const cli = yield* AzureDevOpsApi.AzureDevOpsApi;
      az.mockReturnValue(Effect.succeed(processOutput(JSON.stringify(azOutput))));
      const viaCli = yield* call(cli);
      az.mockClear();
      yield* saveToken;

      assert.deepStrictEqual(yield* call(cli), viaCli);
      expect(az).not.toHaveBeenCalled();
      const [request] = requests;
      assert.isDefined(request);
      const url = new URL(request.url);
      assert.strictEqual(url.pathname, path);
      assert.strictEqual(url.searchParams.get("api-version"), "7.1");
      for (const [name, value] of Object.entries(query)) {
        assert.strictEqual(url.searchParams.get(name), value, name);
      }
    }).pipe(Effect.provide(layer));
  });

  const bodyOf = (request: HttpClientRequest.HttpClientRequest | undefined): unknown => {
    assert.isDefined(request);
    return request.body._tag === "Uint8Array"
      ? JSON.parse(new TextDecoder().decode(request.body.body))
      : undefined;
  };

  it.effect.each([
    { source: "user/feat", target: undefined, sourceRef: "refs/heads/user/feat" },
    { source: "@scratch", target: undefined, sourceRef: "refs/heads/@scratch" },
    { source: "refs/heads/done", target: "refs/heads/release", sourceRef: "refs/heads/done" },
  ])(
    "posts a pull request from $source over REST with the body file's text",
    ({ source, target, sourceRef }) => {
      const { requests, az, layer, saveToken } = routed(() => Response.json(pullRequest));
      return Effect.gen(function* () {
        yield* saveToken;
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const bodyFile = `${directory}/body.md`;
        yield* fileSystem.writeFileString(bodyFile, "@notes.txt\n- from the file");
        const cli = yield* AzureDevOpsApi.AzureDevOpsApi;

        yield* cli.createPullRequest({
          cwd: "/w",
          baseBranch: "main",
          headSelector: source,
          ...(target === undefined ? {} : { target: { refName: target } }),
          title: "@title",
          bodyFile,
        });

        expect(az).not.toHaveBeenCalled();
        const [request] = requests;
        assert.isDefined(request);
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(
          new URL(request.url).pathname,
          "/contoso/Web%20Site/_apis/git/repositories/web%20app/pullrequests",
        );
        expect(bodyOf(request)).toEqual({
          sourceRefName: sourceRef,
          targetRefName: target ?? "refs/heads/main",
          title: "@title",
          description: "@notes.txt\n- from the file",
        });
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("creates a repository over REST in the project id its name resolves to", () => {
    const { requests, az, layer, saveToken } = routed((request) =>
      request.method === "GET" ? Response.json({ id: "project-id" }) : Response.json(repository),
    );
    return Effect.gen(function* () {
      yield* saveToken;
      const cli = yield* AzureDevOpsApi.AzureDevOpsApi;

      const urls = yield* cli.createRepository({
        cwd: "/w",
        repository: "Other Project/repo",
        visibility: "public",
      });

      expect(az).not.toHaveBeenCalled();
      assert.strictEqual(urls.nameWithOwner, "Other Project/repo");
      assert.deepStrictEqual(
        requests.map((request) => [request.method, new URL(request.url).pathname]),
        [
          ["GET", "/contoso/_apis/projects/Other%20Project"],
          ["POST", "/contoso/Other%20Project/_apis/git/repositories"],
        ],
      );
      // `az repos create` has no visibility flag, so the project's settings decide it here too.
      expect(bodyOf(requests[1])).toEqual({ name: "repo", project: { id: "project-id" } });
    }).pipe(Effect.provide(layer));
  });
});

describe("azureCliInvocation", () => {
  const launcher = "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd";
  const msi: AzureCliInstall = {
    interpreter: "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe",
    installer: "MSI",
  };

  const invocationFor = (install: AzureCliInstall | undefined) =>
    AzureDevOpsApi.azureCliInvocation().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, { PATH: "C:\\tools" }),
      Effect.provideService(SpawnExecutableResolution, () => launcher),
      Effect.provideService(AzureCliInstallLocation, () => install),
    );

  it.effect("runs the install's interpreter in UTF-8 mode", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* invocationFor(msi), {
        command: msi.interpreter,
        args: ["-X", "utf8", "-IBm", "azure.cli"],
        env: { AZ_INSTALLER: "MSI" },
      });
    }),
  );

  it.effect("keeps the launcher when the install is not recognized", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* invocationFor(undefined), {
        command: "az",
        args: [],
      });
    }),
  );

  it.effect("spawns az directly off Windows", () =>
    Effect.gen(function* () {
      const invocation = yield* AzureDevOpsApi.azureCliInvocation().pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );

      assert.deepStrictEqual(invocation, { command: "az", args: [] });
    }),
  );
});

describe("scopeAzureCliArgs", () => {
  const origin = "https://dev.azure.com/acme/Project/_git/Repo";
  const show = ["repos", "show", "--detect", "true"];

  it.each([
    [
      ["repos", "show"],
      ["--project=Project", "--repository=Repo"],
    ],
    [["repos", "create", "--name", "New"], ["--project=Project"]],
    [
      ["repos", "pr", "list"],
      ["--project=Project", "--repository=Repo"],
    ],
    [
      ["repos", "pr", "create"],
      ["--project=Project", "--repository=Repo"],
    ],
    [["repos", "pr", "show", "--id", "42"], []],
    [["devops", "invoke", "--area", "git"], []],
  ])("scopes %j to the commands' supported arguments", (command, scope) => {
    expect(scopeAzureCliArgs([...command, "--detect", "true"], origin)).toEqual([
      ...command,
      "--detect",
      "false",
      "--organization",
      "https://dev.azure.com/acme",
      ...scope,
    ]);
  });

  it.each([
    ["https://dev.azure.com/acme/My%20Project/_git/My%20Repo", "https://dev.azure.com/acme"],
    ["https://user@dev.azure.com/acme/My%20Project/_git/My%20Repo", "https://dev.azure.com/acme"],
    [
      "https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/My%20Repo",
      "https://acme.visualstudio.com",
    ],
    ["https://acme.visualstudio.com/My%20Project/_git/My%20Repo", "https://acme.visualstudio.com"],
    ["git@ssh.dev.azure.com:v3/acme/My%20Project/My%20Repo", "https://dev.azure.com/acme"],
    ["ssh://git@ssh.dev.azure.com:22/v3/acme/My%20Project/My%20Repo", "https://dev.azure.com/acme"],
    ["git@vs-ssh.visualstudio.com:v3/acme/My%20Project/My%20Repo", "https://acme.visualstudio.com"],
  ])("reads the organization of %s", (url, organization) => {
    expect(scopeAzureCliArgs(show, url)).toEqual([
      "repos",
      "show",
      "--detect",
      "false",
      "--organization",
      organization,
      "--project=My Project",
      "--repository=My Repo",
    ]);
  });

  it("joins names starting with `-` to their options", () => {
    expect(
      scopeAzureCliArgs(
        ["repos", "pr", "list", "--detect", "true"],
        "https://dev.azure.com/acme/-Project/_git/-Repo",
      ),
    ).toEqual(expect.arrayContaining(["--project=-Project", "--repository=-Repo"]));
  });

  it("keeps the caller's project and repository", () => {
    for (const selection of [
      ["--project", "Chosen", "--repository", "Chosen"],
      ["-p", "Chosen", "-r", "Chosen"],
      ["--repository=Chosen", "--project", "Chosen"],
    ]) {
      expect(
        scopeAzureCliArgs(["repos", "show", ...selection, "--detect", "true"], origin),
      ).toEqual([
        "repos",
        "show",
        ...selection,
        "--detect",
        "false",
        "--organization",
        "https://dev.azure.com/acme",
      ]);
    }
  });

  it.each([
    [["account", "show", "--detect", "true"], origin],
    [["repos", "show"], origin],
    [["repos", "show", "--detect", "false"], origin],
    [["repos", "show", "--detect", "true", "--org", "https://dev.azure.com/explicit"], origin],
    [show, "https://github.com/acme/repo"],
    [show, "https://dev.azure.com/acme"],
    [show, "https://dev.azure.com/acme/%XX/_git/Repo"],
    [show, "git@ssh.dev.azure.com:v4/acme/Project/Repo"],
    [show, "git@vs-ssh.visualstudio.com:v3/acme.invalid/Project/Repo"],
    // az would replace the value with the contents of a local file.
    [show, "https://dev.azure.com/acme/Project/_git/%40.env"],
  ])("leaves %j to az when %s gives no scope", (args, url) => {
    expect(scopeAzureCliArgs(args, url)).toEqual(args);
  });
});
