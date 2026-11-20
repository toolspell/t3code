import { describe, expect, it } from "@effect/vitest";

import { primaryRemoteUrl, scopeFromRemoteUrl } from "./azureDevOpsRemote.ts";

describe("primaryRemoteUrl", () => {
  const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
    entries.map(([name, url]) => `${name}\t${url} (fetch)\n${name}\tpush-url (push)\n`).join("");
  const azure = (name: string) => [name, `https://dev.azure.com/${name}/P/_git/R`] as const;

  it.each([
    // Where T3 publishes the branch and creates its pull requests.
    [remotes(azure("upstream"), azure("origin")), azure("origin")[1]],
    [
      remotes(["github", "https://github.com/acme/repo"], azure("zebra"), azure("alpha")),
      azure("zebra")[1],
    ],
    // A non-Azure origin leaves detection to az rather than scoping another repository.
    [
      remotes(azure("upstream"), ["origin", "https://github.com/acme/repo"]),
      "https://github.com/acme/repo",
    ],
    [
      remotes(["origin", "https://ado.example/Second Collection/Web App/_git/My Repo"]),
      "https://ado.example/Second Collection/Web App/_git/My Repo",
    ],
    [remotes(), null],
    [`origin\t${azure("origin")[1]} (fetch)`, null],
  ])("picks the scoping remote from %j", (output, url) => {
    expect(primaryRemoteUrl(output)).toBe(url);
  });
});

describe("scopeFromRemoteUrl", () => {
  // git stores a server's space as written, `%20`, or `+`; a server can answer `%2520`.
  it.each([
    "https://ado.example/Second Collection/Web App/_git/My Repo",
    "https://ado.example/Second%20Collection/Web%20App/_git/My%20Repo",
    "https://ado.example/Second+Collection/Web+App/_git/My+Repo",
    "https://ado.example/Second%2520Collection/Web%2520App/_git/My%2520Repo",
    "ssh://ado.example:2222/second%20COLLECTION/Web%20App/_git/My%20Repo",
    "git@ado.example:Second Collection/Web App/_git/My Repo",
  ])("reads one collection, project and repository from %s", (remote) => {
    expect(scopeFromRemoteUrl(remote)).toMatchObject({
      organizationUrl: "https://ado.example/second%20collection",
      project: "Web App",
      repository: "My Repo",
    });
  });

  it("refuses a malformed escape", () => {
    expect(scopeFromRemoteUrl("https://ado.example/Coll/Web%XXApp/_git/repo")).toBeNull();
  });
});
