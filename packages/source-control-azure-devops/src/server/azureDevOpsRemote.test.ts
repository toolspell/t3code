import { describe, expect, it } from "@effect/vitest";

import { primaryRemoteUrl } from "./azureDevOpsRemote.ts";

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
    [remotes(), null],
    [`origin\t${azure("origin")[1]} (fetch)`, null],
  ])("picks the scoping remote from %j", (output, url) => {
    expect(primaryRemoteUrl(output)).toBe(url);
  });
});
