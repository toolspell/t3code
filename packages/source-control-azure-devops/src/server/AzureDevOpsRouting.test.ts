import { SecretProviderId, SecretProviderKind, type ServerSettingsPatch } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";

const tokens = (saved: NonNullable<ServerSettingsPatch["sourceControlHosts"]>[string]) =>
  TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
    settings.update({ sourceControlHosts: { "azure-devops": saved } }),
  );

function harness(remotes = "") {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(processOutput(remotes)),
  );
  const layer = AzureDevOpsRouting.layer.pipe(
    Layer.provideMerge(TestSourceControlHost.layer({ process: { run } })),
  );
  return { run, layer };
}

const resolve = (input: { readonly cwd: string; readonly remoteUrl?: string }) =>
  AzureDevOpsRouting.AzureDevOpsRouting.use((routing) => routing.resolve(input));

it.effect("keeps the Azure CLI without a saved token, and never asks git", () => {
  const { run, layer } = harness();
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* resolve({ cwd: "/repo" }), { _tag: "Cli" });
    yield* tokens({ tokens: { "https://dev.azure.com/other": "" } });
    assert.deepStrictEqual(yield* resolve({ cwd: "/repo" }), { _tag: "Cli" });
    expect(run).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer));
});

it.effect(
  "routes an organization with a saved token to REST, whatever form its remote takes",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* tokens({ tokens: { "https://dev.azure.com/contoso": " contoso-pat " } });
      for (const remoteUrl of [
        "https://Contoso@dev.azure.com/Contoso/Web%20Site/_git/app",
        "git@ssh.dev.azure.com:v3/contoso/Web%20Site/app",
        "https://contoso.visualstudio.com/DefaultCollection/Web%20Site/_git/app",
        "contoso@vs-ssh.visualstudio.com:v3/contoso/Web%20Site/app",
      ]) {
        const route = yield* resolve({ cwd: "/repo", remoteUrl });
        assert.strictEqual(route._tag, "Rest", remoteUrl);
        if (route._tag !== "Rest") continue;
        assert.strictEqual(route.organizationUrl, "https://dev.azure.com/contoso", remoteUrl);
        assert.strictEqual(Redacted.value(route.token), "contoso-pat");
        assert.strictEqual(route.project, "Web Site");
        assert.strictEqual(route.repository, "app");
      }
      for (const remoteUrl of [
        "https://dev.azure.com/fabrikam/web/_git/app",
        "https://github.com/contoso/app.git",
      ]) {
        assert.deepStrictEqual(yield* resolve({ cwd: "/repo", remoteUrl }), { _tag: "Cli" });
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("matches an Azure DevOps Server remote to its collection's https token", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* tokens({
      tokens: {
        "https://ado.example/Second%20Collection": "second-pat",
        "https://ado.example:8443/tfs/coll": "tfs-pat",
        "http://ado.example/defaultcollection": "clear-text-pat",
      },
    });
    for (const [remoteUrl, organizationUrl, token] of [
      [
        "https://ado.example/Second Collection/Web%20Site/_git/app",
        "https://ado.example/second%20collection",
        "second-pat",
      ],
      [
        "ssh://ado.example:2222/second%20collection/Web%20Site/_git/app",
        "https://ado.example/second%20collection",
        "second-pat",
      ],
      // Servers and git spell a space every way there is.
      ...[
        "https://ado.example/Second+Collection/Web+Site/_git/app",
        "https://ado.example/Second%2520Collection/Web%2520Site/_git/app",
        "git@ado.example:Second Collection/Web Site/_git/app",
        "ssh://ado.example:2222/SECOND%20COLLECTION/Web%20Site/_git/app",
      ].map(
        (remoteUrl) =>
          [remoteUrl, "https://ado.example/second%20collection", "second-pat"] as const,
      ),
      // The SSH port says nothing of the web's, so the one key for host and collection wins.
      [
        "ssh://ado.example:2222/TFS/Coll/Web%20Site/_git/app",
        "https://ado.example:8443/tfs/coll",
        "tfs-pat",
      ],
      [
        "http://ado.example:8080/tfs/coll/Web%20Site/_git/app",
        "https://ado.example:8443/tfs/coll",
        "tfs-pat",
      ],
    ] as const) {
      const route = yield* resolve({ cwd: "/repo", remoteUrl });
      assert.strictEqual(route._tag, "Rest", remoteUrl);
      if (route._tag !== "Rest") continue;
      assert.strictEqual(route.organizationUrl, organizationUrl, remoteUrl);
      assert.strictEqual(Redacted.value(route.token), token, remoteUrl);
      assert.strictEqual(route.project, "Web Site", remoteUrl);
      assert.strictEqual(route.repository, "app", remoteUrl);
    }
    // A server without a usable token is refused: `az` cannot reach one.
    for (const [remoteUrl, organizationUrl] of [
      // An https remote names its port, and none is saved for the default one.
      ["https://ado.example/tfs/coll/web/_git/app", "https://ado.example/tfs/coll"],
      // A token saved for an http URL is never sent.
      [
        "ssh://ado.example:2222/DefaultCollection/web/_git/app",
        "https://ado.example/defaultcollection",
      ],
      [
        "https://ado.example/DefaultCollection/web/_git/app",
        "https://ado.example/defaultcollection",
      ],
    ] as const) {
      const error = yield* Effect.flip(resolve({ cwd: "/repo", remoteUrl }));
      assert.strictEqual(error._tag, "AzureDevOpsTokenRequiredError", remoteUrl);
      assert.strictEqual(error.organizationUrl, organizationUrl, remoteUrl);
    }
    const organization = (url: string) =>
      AzureDevOpsRouting.AzureDevOpsRouting.use((routing) => routing.resolveOrganization(url));
    for (const url of [
      "https://ADO.example/Second Collection/Web Site",
      "https://ado.example/Second+Collection",
      "https://ado.example/second%2520collection",
      "ado.example/SECOND%20collection",
    ]) {
      const route = yield* organization(url);
      assert.strictEqual(route._tag, "Rest", url);
      if (route._tag === "Rest") assert.strictEqual(Redacted.value(route.token), "second-pat");
    }
    const refused = yield* Effect.flip(organization("http://ado.example/defaultcollection"));
    assert.strictEqual(refused._tag, "AzureDevOpsTokenRequiredError");
    expect(refused.detail).toBe(
      "Azure DevOps Server needs a personal access token for ado.example/defaultcollection; save one in Settings → Source control & issues.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "refuses a server's collection without any saved token, and keeps az for the cloud",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const organization = (url: string) =>
        AzureDevOpsRouting.AzureDevOpsRouting.use((routing) => routing.resolveOrganization(url));
      assert.deepStrictEqual(yield* organization("https://dev.azure.com/contoso"), { _tag: "Cli" });
      const error = yield* Effect.flip(organization("https://ado.example/Second Collection"));
      assert.strictEqual(error._tag, "AzureDevOpsTokenRequiredError");
      assert.strictEqual(error.organizationUrl, "https://ado.example/second%20collection");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("reads the checkout's primary remote when T3 selected none", () => {
  const { run, layer } = harness(
    "upstream\thttps://dev.azure.com/fabrikam/web/_git/app (fetch)\n" +
      "origin\thttps://dev.azure.com/contoso/web/_git/app (fetch)\n",
  );
  return Effect.gen(function* () {
    yield* tokens({ tokens: { "https://dev.azure.com/contoso": "contoso-pat" } });
    const route = yield* resolve({ cwd: "/repo" });
    assert.strictEqual(route._tag, "Rest");
    expect(run.mock.calls[0]?.[0]).toMatchObject({ command: "git", args: ["remote", "-v"] });
  }).pipe(Effect.provide(layer));
});

it.effect("fails instead of falling back to az when the saved token cannot be read", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    // getWithSecrets leaves a reference in place when its secret provider could not read it.
    yield* TestSourceControlHost.TestSourceControlHostSettings.use((settings) =>
      settings.update({
        secretProviders: {
          [SecretProviderId.make("vault")]: {
            kind: SecretProviderKind.make("one_password"),
            label: "Work vault",
            config: {},
          },
        },
      }),
    );
    yield* tokens({
      tokens: {
        "https://dev.azure.com/contoso": {
          provider: SecretProviderId.make("vault"),
          reference: "ado#pat",
        },
      },
    });
    const error = yield* Effect.flip(
      resolve({ cwd: "/repo", remoteUrl: "https://dev.azure.com/contoso/web/_git/app" }),
    );
    assert.strictEqual(error._tag, "AzureDevOpsTokenUnavailableError");
    assert.strictEqual(error.organizationUrl, "https://dev.azure.com/contoso");
    expect(error.detail).toContain('"Work vault"');
  }).pipe(Effect.provide(layer));
});
