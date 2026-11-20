import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  azureDevOpsTokenCheck,
  normalizeAzureDevOpsOrganizationUrl,
  withAzureDevOpsTokenDetail,
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

const ORGANIZATION = "https://dev.azure.com/contoso";
const account = (fields: { readonly authenticated: boolean; readonly error?: string }) => ({
  host: ORGANIZATION,
  account: "Sabine Test",
  active: false,
  ...fields,
});
const auth = (
  status: "authenticated" | "unauthenticated",
  accounts: ReadonlyArray<ReturnType<typeof account>>,
  signedInAs?: string,
) => ({
  status,
  account: signedInAs === undefined ? Option.none<string>() : Option.some(signedInAs),
  host: Option.none<string>(),
  detail: Option.none<string>(),
  accounts,
});

describe("azureDevOpsTokenCheck", () => {
  it.each([
    [
      account({ authenticated: true }),
      { status: "valid", account: "Sabine Test", missingScopes: [] },
    ],
    [
      account({ authenticated: true, error: "missing-scopes:work-items,identity" }),
      { status: "valid", account: "Sabine Test", missingScopes: ["work-items", "identity"] },
    ],
    [
      account({ authenticated: false, error: "missing-scopes:code" }),
      { status: "missing-scopes", scopes: ["code"] },
    ],
    [
      account({ authenticated: false, error: "unsupported-version:7.0" }),
      { status: "unsupported-version", version: "7.0" },
    ],
    [account({ authenticated: false, error: "rejected" }), { status: "rejected" }],
    [
      account({ authenticated: false, error: "organization-not-found" }),
      { status: "organization-not-found" },
    ],
    [
      account({ authenticated: false, error: "secret-unresolved" }),
      { status: "secret-unresolved" },
    ],
    [account({ authenticated: false, error: "unreachable" }), { status: "unreachable" }],
  ])("reads %j", (entry, expected) => {
    expect(
      azureDevOpsTokenCheck(auth("unauthenticated", [entry]), "https://dev.azure.com/Contoso"),
    ).toEqual(expected);
  });

  it("reports an organization the server has not checked yet", () => {
    expect(
      azureDevOpsTokenCheck(auth("unauthenticated", []), "https://dev.azure.com/fabrikam"),
    ).toEqual({
      status: "not-checked",
    });
  });
});

describe("withAzureDevOpsTokenDetail", () => {
  const describeTokens = (count: number) => `${count} tokens`;

  it("names the tokens when they, not az, sign in", () => {
    const item = {
      auth: auth("authenticated", [
        account({ authenticated: true }),
        {
          ...account({ authenticated: false, error: "rejected" }),
          host: "https://dev.azure.com/other",
        },
      ]),
    };
    expect(withAzureDevOpsTokenDetail(item, describeTokens).auth.detail).toEqual(
      Option.some("1 tokens"),
    );
  });

  it("keeps the az account and a signed-out state as they are", () => {
    const signedIn = { auth: auth("authenticated", [account({ authenticated: true })], "az user") };
    const signedOut = {
      auth: auth("unauthenticated", [account({ authenticated: false, error: "rejected" })]),
    };
    expect(withAzureDevOpsTokenDetail(signedIn, describeTokens)).toBe(signedIn);
    expect(withAzureDevOpsTokenDetail(signedOut, describeTokens)).toBe(signedOut);
  });
});
