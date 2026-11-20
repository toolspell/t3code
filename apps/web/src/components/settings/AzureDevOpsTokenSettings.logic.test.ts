import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeAzureDevOpsOrganizationUrl,
  withAzureDevOpsPatAuth,
} from "./AzureDevOpsTokenSettings.logic";

describe("normalizeAzureDevOpsOrganizationUrl", () => {
  it.each([
    ["Contoso", "https://dev.azure.com/contoso"],
    ["https://dev.azure.com/Contoso", "https://dev.azure.com/contoso"],
    ["dev.azure.com/contoso/", "https://dev.azure.com/contoso"],
    ["https://dev.azure.com/contoso/ado-service-demo-1/_git/web", "https://dev.azure.com/contoso"],
    ["https://contoso.visualstudio.com/DefaultCollection", "https://dev.azure.com/contoso"],
  ])("%s", (input, expected) => {
    expect(normalizeAzureDevOpsOrganizationUrl(input)).toBe(expected);
  });

  it.each(["", "  ", "https://dev.azure.com", "https://github.com/contoso", "not a url"])(
    "rejects %j",
    (input) => {
      expect(normalizeAzureDevOpsOrganizationUrl(input)).toBeNull();
    },
  );
});

describe("withAzureDevOpsPatAuth", () => {
  const summary = (count: number) => `${count} tokens`;
  const signedOut = {
    status: "missing" as const,
    auth: {
      status: "unauthenticated" as const,
      account: Option.none(),
      host: Option.none(),
      detail: Option.none(),
    },
  };
  const signedIn = {
    status: "available" as const,
    auth: { ...signedOut.auth, status: "authenticated" as const, account: Option.some("az-user") },
  };

  it("keeps the az login when it is signed in", () => {
    expect(
      withAzureDevOpsPatAuth(signedIn, { "https://dev.azure.com/contoso": "pat" }, summary),
    ).toBe(signedIn);
  });

  it("is usable and authenticated with one working token", () => {
    const item = withAzureDevOpsPatAuth(
      signedOut,
      {
        "https://dev.azure.com/invalid-org": "pat",
        "https://dev.azure.com/contoso": "pat",
        "https://dev.azure.com/fabrikam": "pat",
      },
      summary,
    );
    expect(item.status).toBe("available");
    expect(item.auth.status).toBe("authenticated");
    expect(item.auth.detail).toEqual(Option.some("2 tokens"));
  });

  it.each([
    ["no tokens", {}],
    ["only removed tokens", { "https://dev.azure.com/contoso": "" }],
    [
      "only rejected or unchecked tokens",
      { "https://dev.azure.com/invalid-org": "pat", "https://dev.azure.com/offline-org": "pat" },
    ],
  ])("stays signed out with %s", (_, tokens) => {
    expect(withAzureDevOpsPatAuth(signedOut, tokens, summary)).toBe(signedOut);
  });
});
