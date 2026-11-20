import { SourceControlProviderKind } from "@t3tools/contracts";
import type { ChangeRequestProjectIdentity } from "@t3tools/source-control-core/shared/definition";
import {
  makeSourceControlDefinitionRegistry,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { azureDevOpsOrganizationUrl, definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Azure DevOps change request URLs", () => {
  it("reads both hosted URL forms", () => {
    expect(parse("https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17")).toEqual({
      host: "dev.azure.com",
      repository: "acme/platform/_git/t3code",
      number: 17,
      repositoryUrl: "https://dev.azure.com/acme/platform/_git/t3code",
    });
    expect(
      parse("https://acme.visualstudio.com/platform/_git/t3code/pullrequest/17"),
    ).toMatchObject({
      host: "acme.visualstudio.com",
      repository: "platform/_git/t3code",
      number: 17,
    });
  });

  it("keeps Azure DevOps Server ports in the authority, on any hostname", () => {
    expect(
      parse("https://GIT.CAFE:8443/tfs/Collection/Project/_git/Repo/pullrequest/123?view=files"),
    ).toEqual({
      host: "git.cafe",
      authority: "git.cafe:8443",
      repository: "tfs/collection/project/_git/repo",
      number: 123,
      repositoryUrl: "https://git.cafe:8443/tfs/Collection/Project/_git/Repo",
    });
    expect(parse("https://scm.example.test/tfs/c/p/_git/r/pullrequest/1")).not.toHaveProperty(
      "authority",
    );
  });

  it("claims nothing without the _git route or a valid number", () => {
    for (const url of [
      "https://scm.example.test/tfs/Collection/Project/_git/Repo",
      "https://scm.example.test/tfs/Collection/Project/pullrequest/123",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/abc",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/0",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/9007199254740992",
    ]) {
      expect(parse(url), url).toBeNull();
    }
  });

  it.each([
    ["ssh.dev.azure.com", "v3/org/project/web"],
    ["org.visualstudio.com", "defaultcollection/project/_git/web"],
    ["dev.azure.com", "org/project/_git/web"],
  ])("builds a canonical browser URL from the remote %s/%s", (host, repository) => {
    expect(definition.changeRequestUrl({ host, repository, number: 42 })).toBe(
      "https://dev.azure.com/org/project/_git/web/pullrequest/42",
    );
  });

  it("keeps an Azure DevOps Server's HTTP origin and builds below a web URL", () => {
    expect(
      definition.changeRequestUrl({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 124,
        remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
      }),
    ).toBe("http://scm.example.test:8080/tfs/collection/project/_git/repo/pullrequest/124");
    expect(
      definition.changeRequestUrl({
        host: "dev.azure.com",
        repository: "acme/project/_git/web",
        number: 43,
        webUrl: "https://dev.azure.com/acme/project/_git/web",
      }),
    ).toBe("https://dev.azure.com/acme/project/_git/web/pullrequest/43");
  });

  it("builds Azure DevOps Server links on the web origin, never the SSH port", () => {
    const sha = "a".repeat(40);
    const ssh = "ssh://ado.example:2222/tfs/Second%20Collection/Project/_git/Repo";
    const https = "https://ado.example:8443/tfs/Second Collection/Project/_git/Repo";
    const repository = "tfs/second%20collection/project/_git/repo";
    const host = "ado.example";
    expect(definition.changeRequestUrl({ host, repository, number: 7, remoteUrl: ssh })).toBe(
      "https://ado.example/tfs/second%20collection/project/_git/repo/pullrequest/7",
    );
    expect(definition.commitUrl?.({ host, repository, sha, remoteUrl: ssh })).toBe(
      `https://ado.example/tfs/second%20collection/project/_git/repo/commit/${sha}`,
    );
    expect(definition.changeRequestUrl({ host, repository, number: 7, remoteUrl: https })).toBe(
      "https://ado.example:8443/tfs/second%20collection/project/_git/repo/pullrequest/7",
    );
  });

  it("takes pasted Azure DevOps Server pull request URLs as references", () => {
    for (const url of [
      "https://dev.azure.com/acme/web/_git/app/pullrequest/7",
      "https://acme.visualstudio.com/DefaultCollection/web/_git/app/pullrequest/7",
      "https://ado.example:8443/tfs/Second%20Collection/web/_git/app/pullrequest/7?_a=files",
      "http://ado.example/Coll/web/_git/app/pullrequest/7",
    ]) {
      expect(definition.isChangeRequestReference(url), url).toBe(true);
    }
    expect(definition.isChangeRequestReference("https://ado.example/_git/app/pullrequest/7")).toBe(
      false,
    );
  });

  // `az` refuses Azure DevOps Server, so a server's pull request is checked out with git.
  it.each([
    ["https://dev.azure.com/acme/web/_git/app", "feature/x", "az repos pr checkout --id 7"],
    [undefined, "feature/x", "az repos pr checkout --id 7"],
    [
      "https://ado.example/Second%20Collection/web/_git/app",
      "feature/x",
      "git fetch origin feature/x && git switch feature/x",
    ],
    ["https://ado.example/Coll/web/_git/app", "", null],
    ["https://ado.example/Coll/web/_git/app", "x;rm -rf ~", null],
    ["https://ado.example/Coll/web/_git/app", "--upload-pack=x", null],
  ])("checks out a pull request in %s from %j with %j", (repositoryUrl, headBranch, command) => {
    expect(definition.checkoutCommand({ number: 7, headBranch, repositoryUrl })).toBe(command);
  });

  it.each([
    ["ssh.dev.azure.com/v3/org-a/project/web", "git@ssh.dev.azure.com:v3/org-a/project/web"],
    [
      "vs-ssh.visualstudio.com/v3/org-a/project/web",
      "git@vs-ssh.visualstudio.com:v3/org-a/project/web",
    ],
    [
      "org-a.visualstudio.com/defaultcollection/project/_git/web",
      "https://org-a.visualstudio.com/DefaultCollection/Project/_git/Web",
    ],
    ["dev.azure.com/org-a/project/_git/web", "https://org-a@dev.azure.com/org-a/Project/_git/Web"],
  ])("matches browser references against the checkout %s", (canonicalKey, remoteUrl) => {
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey,
      displayName: canonicalKey.split("/").slice(1).join("/"),
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    };
    const link = parse("https://dev.azure.com/org-a/project/_git/web/pullrequest/42")!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    for (const repository of ["org-b/project/_git/web", "org-a/other-project/_git/web"]) {
      expect(definition.isChangeRequestInRepository(identity, { ...link, repository })).toBe(false);
    }
  });
});

describe("Azure DevOps remotes", () => {
  it("recognises the SSH clone hosts as well as the web ones", () => {
    for (const remote of [
      "git@ssh.dev.azure.com:v3/org/project/repo",
      "ssh://git@ssh.dev.azure.com:22/v3/org/project/repo",
      "git@vs-ssh.visualstudio.com:v3/org/project/repo",
      "https://org@dev.azure.com/org/project/_git/repo",
    ]) {
      expect(recognizeRemoteWith(definition, remote)?.kind, remote).toBe("azure-devops");
    }
  });

  it.each([
    [
      "https://ado.example/DefaultCollection/Project/_git/Repo",
      "https://ado.example/defaultcollection",
    ],
    [
      "https://ADO.example:8443/tfs/Coll/Project/_git/Repo.git",
      "https://ado.example:8443/tfs/coll",
    ],
    [
      "https://ado.example/Second%20Collection/Project/_git/Repo",
      "https://ado.example/second%20collection",
    ],
    [
      "https://ado.example/Second Collection/Project/_git/Repo",
      "https://ado.example/second%20collection",
    ],
    ["http://ado.example:8080/Coll/Project/_git/Repo", "http://ado.example:8080/coll"],
    // The SSH port is not the web's.
    ["ssh://git@ado.example:2222/tfs/Coll/Project/_git/Repo", "https://ado.example/tfs/coll"],
    [
      "ssh://ado.example:2222/Second%20Collection/Project/_git/Repo",
      "https://ado.example/second%20collection",
    ],
    ["git@ado.github.example:Coll/Project/_git/Repo", "https://ado.github.example/coll"],
    ["https://ado.example/Coll/_git/Repo", "https://ado.example/coll"],
  ])("recognises the Azure DevOps Server remote %s", (remote, baseUrl) => {
    expect(recognizeRemoteWith(definition, remote)).toEqual({
      kind: "azure-devops",
      name: "Azure DevOps Server",
      baseUrl,
    });
  });

  it.each([
    "https://github.com/acme/repo",
    "https://gitea.example/acme/_git",
    "https://ado.example/_git/Repo",
    "https://ado.example/tfs/_git/Repo",
    "https://ado.example/Coll/Project/_git/Repo/extra",
    "https://ado.example/Coll/Project/Repo",
  ])("leaves %s to other hosts", (remote) => {
    expect(recognizeRemoteWith(definition, remote)).toBeNull();
  });
});

describe("azureDevOpsOrganizationUrl", () => {
  it.each([
    ["Contoso", "https://dev.azure.com/contoso"],
    ["https://dev.azure.com/Contoso", "https://dev.azure.com/contoso"],
    ["dev.azure.com/contoso/", "https://dev.azure.com/contoso"],
    ["https://dev.azure.com/contoso/ado-service-demo-1/_git/web", "https://dev.azure.com/contoso"],
    ["https://contoso.visualstudio.com/DefaultCollection", "https://dev.azure.com/contoso"],
    ["https://ado.example/DefaultCollection", "https://ado.example/defaultcollection"],
    ["ado.example/Second Collection/Project/_git/Repo", "https://ado.example/second%20collection"],
    ["https://ado.example/second%20collection/", "https://ado.example/second%20collection"],
    ["https://user@ADO.example:8443/TFS/Coll/Project", "https://ado.example:8443/tfs/coll"],
    ["https://ado.example:443/Coll", "https://ado.example/coll"],
  ])("%s", (input, expected) => {
    expect(azureDevOpsOrganizationUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "  ",
    "not a url",
    "https://dev.azure.com",
    "https://dev.azure.com/_apis",
    "https://vssps.dev.azure.com/contoso",
    "https://ado.example",
    "https://ado.example/tfs",
    "https://ado.example/_apis/connectionData",
    // A token must never travel in the clear.
    "http://ado.example/DefaultCollection",
    "http://dev.azure.com/contoso",
    "ssh://ado.example:2222/DefaultCollection",
  ])("refuses %j", (input) => {
    expect(azureDevOpsOrganizationUrl(input)).toBeNull();
  });
});

describe("Azure DevOps repository keys", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);

  it("gives a repository the same key over SSH as over HTTPS", () => {
    for (const remote of [
      "git@ssh.dev.azure.com:v3/T3Tools/Platform/T3Code",
      "ssh://git@ssh.dev.azure.com:22/v3/T3Tools/Platform/T3Code",
      "https://T3Tools@dev.azure.com/T3Tools/Platform/_git/T3Code",
    ]) {
      expect(registry.repositoryKeyFromRemote(remote), remote).toBe(
        "dev.azure.com/t3tools/platform/_git/t3code",
      );
    }
  });

  it.each([
    "git@ssh.dev.azure.com:v3/acme/platform/tool.git",
    "https://dev.azure.com/acme/platform/_git/tool.git",
  ])("preserves a literal .git in an Azure repository name: %s", (remoteUrl) => {
    const canonicalKey = registry.repositoryKeyFromRemote(remoteUrl);
    expect(canonicalKey).toBe("dev.azure.com/acme/platform/_git/tool.git");
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    };
    const link = parse("https://dev.azure.com/acme/platform/_git/tool.git/pullrequest/7")!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(identity, {
        ...link,
        repository: "acme/platform/_git/tool",
      }),
    ).toBe(false);
  });

  it("matches a repository however its name is percent-encoded", () => {
    const remoteUrl = "https://example@dev.azure.com/example/Sample%20(Beta)/_git/Sample%20(Beta)";
    const canonicalKey = registry.repositoryKeyFromRemote(remoteUrl);
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    };
    for (const url of [
      "https://dev.azure.com/example/Sample%20%28Beta%29/_git/Sample%20%28Beta%29/pullrequest/7",
      "https://dev.azure.com/example/Sample (Beta)/_git/Sample (Beta)/pullrequest/7",
    ]) {
      const link = parse(url)!;
      expect(link.repository, url).toBe("example/sample%20(beta)/_git/sample%20(beta)");
      expect(definition.isChangeRequestInRepository(identity, link), url).toBe(true);
      expect(
        definition.isChangeRequestInRepository(
          {
            ...identity,
            canonicalKey: "dev.azure.com/example/sample%20%28beta%29/_git/sample%20%28beta%29",
          },
          link,
        ),
        url,
      ).toBe(true);
    }
    // Links stored before keys had one spelling still resolve to their project.
    expect(
      registry.canonicalRepositoryKey(
        "dev.azure.com/example/sample%20%28beta%29/_git/sample%20%28beta%29",
      ),
    ).toBe(canonicalKey);
  });

  it("gives an Azure DevOps Server repository one key over SSH and HTTPS", () => {
    const keys = [
      "ssh://ado.example:2222/tfs/Second%20Collection/Project/_git/Repo.git",
      "https://ado.example:8443/tfs/Second Collection/Project/_git/Repo.git",
      "https://ado.example/TFS/second%20collection/project/_git/repo.git",
    ].map((remote) => registry.repositoryKeyFromRemote(remote));
    expect(new Set(keys)).toEqual(
      new Set(["ado.example/tfs/second%20collection/project/_git/repo.git"]),
    );
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey: keys[0]!,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "ssh://ado.example:2222/x",
      },
    };
    const link = parse(
      "https://ado.example:8443/tfs/Second%20Collection/Project/_git/Repo.git/pullrequest/3",
    )!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(identity, { ...link, host: "other.example" }),
    ).toBe(false);
    expect(registry.findByRepositoryKey(keys[0]!)).toBeUndefined();
  });

  it("still drops .git from other hosts' repository keys", () => {
    expect(registry.repositoryKeyFromRemote("git@github.com:acme/tool.git")).toBe(
      "github.com/acme/tool",
    );
  });

  it("keeps the organization in the host for the legacy visualstudio.com remotes", () => {
    for (const remote of [
      "T3Tools@vs-ssh.visualstudio.com:v3/T3Tools/Platform/T3Code",
      "https://T3Tools.visualstudio.com/Platform/_git/T3Code",
    ]) {
      expect(registry.repositoryKeyFromRemote(remote), remote).toBe(
        "t3tools.visualstudio.com/platform/_git/t3code",
      );
    }
  });

  it("compares every spelling on dev.azure.com", () => {
    for (const key of [
      "ssh.dev.azure.com/v3/org/project/repo",
      "vs-ssh.visualstudio.com/v3/org/project/repo",
      "org.visualstudio.com/project/_git/repo",
      "org.visualstudio.com/defaultcollection/project/_git/repo",
      "dev.azure.com/org/project/_git/repo",
    ]) {
      expect(registry.canonicalRepositoryKey(key), key).toBe("dev.azure.com/org/project/_git/repo");
      expect(registry.findByRepositoryKey(key), key).toBe(definition);
    }
    expect(registry.canonicalRepositoryKey("tfs.example/c/p/_git/r")).toBe(
      "tfs.example/c/p/_git/r",
    );
    expect(registry.findByRepositoryKey("tfs.example/c/p/_git/r")).toBeUndefined();
  });
});

describe("Azure DevOps repository selector", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);

  it("names a repository by its own name, not its project path", () => {
    // `az repos pr list --repository` takes a name and detects the organisation and project from
    // the checkout; the recorded `org/project/_git/repo` path is refused.
    expect(
      registry.repositorySelector({
        provider: SourceControlProviderKind.make("azure-devops"),
        displayName: "contoso/payments/_git/checkout",
        owner: "contoso",
        name: "checkout",
      }),
    ).toBe("checkout");
  });

  it("decodes a name the remote URL percent-encodes", () => {
    expect(
      registry.repositorySelector({
        provider: SourceControlProviderKind.make("azure-devops"),
        displayName: "contoso/payments%20(eu)/_git/checkout%20(eu)",
        owner: "contoso",
        name: "checkout%20(eu)",
      }),
    ).toBe("checkout (eu)");
  });
});

describe("Azure DevOps issue scope", () => {
  it("places work items in the project rather than the repository", () => {
    const kind = SourceControlProviderKind.make("azure-devops");
    expect(
      definition.issueScope?.({ provider: kind, displayName: "acme/Web%20App/_git/web" }),
    ).toBe("acme/Web App");
    expect(definition.issueScope?.({ provider: kind, displayName: "web" })).toBeNull();
    // One segment before `_git` is a different thing on each kind of host, so it needs the host.
    expect(definition.issueScope?.({ provider: kind, displayName: "acme/_git/web" })).toBeNull();
    const scopeOn = (canonicalKey: string, displayName: string) =>
      definition.issueScope?.({ provider: kind, canonicalKey, displayName });
    expect(scopeOn("dev.azure.com/acme/_git/web", "acme/_git/Web")).toBe("acme/Web");
    expect(scopeOn("acme.visualstudio.com/web/_git/web", "Web%20App/_git/web")).toBe("Web App");
    expect(scopeOn("acme.visualstudio.com/_git/web", "_git/Web")).toBe("Web");
    // Its work items are at `acme.visualstudio.com/Web/_workitems/...`, without the collection.
    expect(
      scopeOn("acme.visualstudio.com/defaultcollection/_git/web", "DefaultCollection/_git/Web"),
    ).toBe("Web");
    expect(scopeOn("dev.azure.com/_git/web", "_git/web")).toBeNull();
    // A legacy host keeps the organization in its name, and so does its work item URL.
    expect(
      definition.parseIssueUrl?.(
        new URL("https://acme.visualstudio.com/Web%20App/_workitems/edit/9"),
      ),
    ).toEqual({
      host: "acme.visualstudio.com",
      scope: "web app",
      scopeAlias: "defaultcollection/web app",
      key: "9",
    });
    expect(
      definition.parseIssueUrl?.(
        new URL("https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/9"),
      ),
    ).toEqual({
      host: "acme.visualstudio.com",
      scope: "defaultcollection/web app",
      scopeAlias: "web app",
      key: "9",
    });
    expect(
      definition.parseIssueUrl?.(new URL("https://dev.azure.com/acme/_workitems/edit/9")),
    ).toBeNull();
  });

  it("places Azure DevOps Server work items in the collection's project", () => {
    const kind = SourceControlProviderKind.make("azure-devops");
    const scopeOn = (displayName: string) =>
      definition.issueScope?.({
        provider: kind,
        canonicalKey: `ado.example/${displayName.toLowerCase()}`,
        displayName,
      });
    expect(scopeOn("Second%20Collection/Web%20App/_git/web")).toBe("Second Collection/Web App");
    expect(scopeOn("tfs/Coll/Web/_git/web")).toBe("tfs/Coll/Web");
    expect(scopeOn("tfs/Coll/_git/Web")).toBe("tfs/Coll/Web");
    expect(scopeOn("Coll/_git/Web")).toBe("Coll/Web");
    expect(scopeOn("tfs/_git/Web")).toBeNull();
    // On dev.azure.com, `tfs` is an organization like any other.
    expect(
      definition.issueScope?.({
        provider: kind,
        canonicalKey: "dev.azure.com/tfs/web/_git/web",
        displayName: "tfs/Web/_git/web",
      }),
    ).toBe("tfs/Web");
    const issue = (url: string) => definition.parseIssueUrl?.(new URL(url));
    expect(issue("https://ado.example:8443/tfs/Coll/Web%20App/_workitems/edit/9")).toEqual({
      host: "ado.example",
      scope: "tfs/coll/web app",
      key: "9",
    });
    expect(issue("https://ado.example/Second%20Collection/Web/_workitems/edit/9")).toEqual({
      host: "ado.example",
      scope: "second collection/web",
      key: "9",
    });
    expect(issue("https://ado.example/tfs/Coll/_workitems/edit/9")).toBeNull();
  });
});

describe("Azure DevOps publish namespaces", () => {
  it("offers each organization with a saved token, whatever its check said", () => {
    const entry = { account: "Max", active: false };
    expect(
      definition.publishNamespaces?.({
        status: "authenticated",
        account: Option.none(),
        host: Option.none(),
        detail: Option.none(),
        accounts: [
          { ...entry, host: "https://dev.azure.com/toolspell", authenticated: true },
          { ...entry, host: "https://dev.azure.com/my%20org", authenticated: true },
          { ...entry, host: "https://ado.example/Second%20Collection", authenticated: true },
          { ...entry, host: "https://ado.example:8443/tfs/coll", authenticated: true },
          { ...entry, host: "https://ado.example/locked", authenticated: false },
          {
            ...entry,
            host: "https://dev.azure.com/contoso-demo",
            authenticated: false,
            error: "rejected",
          },
        ],
      }),
      // An organization name cannot hold a space, so no token is saved under one.
    ).toEqual(["toolspell", "ado.example/second collection", "ado.example:8443/tfs/coll"]);
  });

  it("names the host only for an organization, whose namespace leaves it out", () => {
    expect(definition.publishHost(null, "toolspell")).toBe("dev.azure.com");
    expect(definition.publishHost(null, null)).toBe("dev.azure.com");
    expect(definition.publishHost(null, "ado.example/second collection")).toBeNull();
  });
});

// Azure DevOps Server answers and git remotes spell one name every way: a literal space, `+`,
// `%20`, a double-escaped `%2520`, and escapes in either case.
const SPACE_SPELLINGS = [
  ["Second Collection", "Web (EU)", "My Repo"],
  ["Second%20Collection", "Web%20%28EU%29", "My%20Repo"],
  ["Second+Collection", "Web+(EU)", "My+Repo"],
  ["Second%2520Collection", "Web%2520%2528EU%2529", "My%2520Repo"],
  ["SECOND%20collection", "web%20%28eu%29", "my%20repo"],
] as const;

describe("Azure DevOps Server names however a space is spelled", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);
  const kind = SourceControlProviderKind.make("azure-devops");
  const canonicalKey = "ado.example/second%20collection/web%20(eu)/_git/my%20repo";

  it.each(SPACE_SPELLINGS)("%s / %s / %s", (collection, project, repository) => {
    const path = `${collection}/${project}/_git/${repository}`;
    for (const remote of [`https://ado.example/${path}`, `ssh://ado.example:2222/${path}`]) {
      expect(registry.repositoryKeyFromRemote(remote), remote).toBe(canonicalKey);
      expect(recognizeRemoteWith(definition, remote)?.baseUrl, remote).toBe(
        "https://ado.example/second%20collection",
      );
    }
    expect(azureDevOpsOrganizationUrl(`https://ado.example/${collection}`)).toBe(
      "https://ado.example/second%20collection",
    );
    expect(
      definition.issueScope?.({ provider: kind, canonicalKey, displayName: path })?.toLowerCase(),
    ).toBe("second collection/web (eu)");
    const web = `https://ado.example/${path}`;
    const link = parse(`${web}/pullrequest/3`);
    expect(link?.repository).toBe("second%20collection/web%20(eu)/_git/my%20repo");
    expect(
      definition.parseCommitUrl?.(new URL(`${web}/commit/${"a".repeat(40)}`))?.repository,
    ).toBe("second%20collection/web%20(eu)/_git/my%20repo");
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: web },
    };
    expect(definition.isChangeRequestInRepository(identity, link!)).toBe(true);
    expect(
      definition.parseIssueUrl?.(
        new URL(`https://ado.example/${collection}/${project}/_workitems/edit/9`),
      ),
    ).toEqual({ host: "ado.example", scope: "second collection/web (eu)", key: "9" });
  });
});
