import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasMobileCredentialsForm, hasVisibleHostFields } from "./sourceControlHostForm.logic";

const definition = (kind: string) =>
  sourceControlClients.find(SourceControlProviderKind.make(kind));

describe("mobile source control credentials form", () => {
  it.each([
    { kind: "github", form: true, visibleFields: false },
    { kind: "azure-devops", form: false, visibleFields: false },
    { kind: "gitcafe", form: true, visibleFields: true },
  ])("$kind: form $form, visible host fields $visibleFields", ({ kind, form, visibleFields }) => {
    expect(hasMobileCredentialsForm(definition(kind))).toBe(form);
    expect(hasVisibleHostFields(definition(kind)?.settings)).toBe(visibleFields);
  });
});
