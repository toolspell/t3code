import {
  isSecretReference,
  type EnvironmentId,
  type SecretReference,
  type SettingsSecretValue,
  type SourceControlProviderAuth,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { T, useGT } from "gt-react";
import { ExternalLinkIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  azureDevOpsOrganizationUrl,
  readHostCredentialSettings,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  azureDevOpsNewTokenUrl,
  azureDevOpsOrganizationLabel,
  AZURE_DEVOPS_SCOPE_NAMES,
  azureDevOpsTokenCheck,
  savedAzureDevOpsOrganizations,
  type AzureDevOpsTokenCheck,
} from "./AzureDevOpsTokenSettings.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { RedactedLogin } from "./SourceControlAccountSettings";

export function AzureDevOpsTokenSettings({
  environmentId,
  definition,
  auth,
  cliVersion,
  cliInstalled,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly auth: SourceControlProviderAuth;
  /** The first line of `az --version`, as `azure-cli 2.93.0`. */
  readonly cliVersion: string | null;
  readonly cliInstalled: boolean;
  readonly onSaved: () => void;
}) {
  const gt = useGT();
  const { tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} token`,
  });
  const secretSources = useSecretSources(environmentId);
  const [organization, setOrganization] = useState("");
  const [pending, setPending] = useState<{
    readonly key: string;
    readonly draft: string | SecretReference;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const cliAccount = auth.status === "authenticated" ? Option.getOrNull(auth.account) : null;
  const organizationUrl = azureDevOpsOrganizationUrl(organization);
  const savedOrganizations = savedAzureDevOpsOrganizations(tokens);
  const isSaved = organizationUrl !== null && savedOrganizations.includes(organizationUrl);
  const savedToken = isSaved ? tokens[organizationUrl] : undefined;
  // A draft belongs to the organization it was typed for, like the GitHub token form.
  const sourceKey = JSON.stringify([organizationUrl, savedToken ?? ""]);
  const draft =
    pending?.key === sourceKey ? pending.draft : isSecretReference(savedToken) ? savedToken : "";
  const submission = typeof draft === "string" ? draft.trim() : draft;
  const tokenInputId = `${definition.kind}-token-${environmentId}`;

  const save = async (target: string, token: SettingsSecretValue) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      // Send the whole map; other tokens' redaction markers preserve their values.
      input: {
        patch: {
          sourceControlHosts: { [definition.kind]: { tokens: { ...tokens, [target]: token } } },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setOrganization("");
      setPending(null);
      onSaved();
    }
  };

  return (
    <div className="grid gap-4">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">
            <T>Azure CLI</T>
          </span>
          {!cliInstalled ? (
            <span className="text-2xs text-muted-foreground">{gt("Not installed")}</span>
          ) : cliVersion !== null ? (
            <code className="text-2xs text-muted-foreground">{cliVersion}</code>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          <T>
            Used for every organization at Azure DevOps Services that has no personal access token.
          </T>
        </p>
        {cliAccount !== null ? (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span>
              <T>Signed in as</T>
            </span>
            <RedactedLogin revealed={revealed} account={cliAccount} />
            <Button
              size="icon-xs"
              variant="ghost-muted"
              onClick={() => setRevealed((current) => !current)}
              aria-label={revealed ? gt("Hide Azure CLI account") : gt("Reveal Azure CLI account")}
              aria-pressed={revealed}
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </div>
        ) : !cliInstalled ? (
          <p className="text-xs text-muted-foreground">
            {gt(
              "Install the Azure command-line tools ({cli}), then enable Azure DevOps support with {command}.",
              { cli: "`az`", command: "`az extension add --name azure-devops`" },
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            <T>
              Not signed in. Run{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs">az login</code> on the server
              host.
            </T>
          </p>
        )}
      </div>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (organizationUrl !== null && submission !== "") {
            void save(organizationUrl, submission);
          }
        }}
      >
        {/* Locked while saving: a successful save clears the draft, which would drop edits made mid-request. */}
        <fieldset disabled={saving} className="contents">
          <div className="space-y-0.5">
            <span className="text-xs font-medium text-foreground">
              <T>Personal access tokens</T>
            </span>
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
              <T>
                A token saved for an organization is used instead of the Azure CLI login. Azure
                DevOps Server collections always need one. Each organization or collection needs its
                own token. Give it Code (Read &amp; write), Work Items (Read &amp; write), Identity
                (Read), and Project and Team (Read). Publishing a new repository also needs Code
                (Read, write, &amp; manage).
              </T>{" "}
              {organizationUrl !== null ? (
                <InlineButton
                  render={
                    <a
                      href={azureDevOpsNewTokenUrl(organizationUrl)}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  }
                >
                  <T>Create a token</T>
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              ) : null}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(12rem,20rem)_1fr]">
            <div className="grid gap-1.5">
              <Label htmlFor={`${definition.kind}-organization-${environmentId}`}>
                <T>Organization or collection URL</T>
              </Label>
              <Input
                id={`${definition.kind}-organization-${environmentId}`}
                autoComplete="off"
                size="sm"
                placeholder="https://dev.azure.com/organization"
                value={organization}
                aria-invalid={organization.trim() !== "" && organizationUrl === null}
                onChange={(event) => setOrganization(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={tokenInputId}>
                <T>Personal access token</T>
              </Label>
              <SecretSourceInput
                id={tokenInputId}
                size="sm"
                aria-label={gt("{host} personal access token", { host: definition.label })}
                environmentId={environmentId}
                configured={isSaved && !isSecretReference(savedToken)}
                value={draft}
                sources={secretSources}
                onChange={(event) => setPending({ key: sourceKey, draft: event.target.value })}
                onSecretChange={(secret) => setPending({ key: sourceKey, draft: secret ?? "" })}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {organization.trim() !== "" && organizationUrl === null
                ? /^http:\/\//iu.test(organization.trim())
                  ? gt("Tokens are only sent over HTTPS. Enter an https:// URL.")
                  : gt(
                      "Enter an organization name, a dev.azure.com URL, or an Azure DevOps Server collection URL.",
                    )
                : isSaved
                  ? gt("Saving replaces the token for {organization}.", {
                      organization: azureDevOpsOrganizationLabel(organizationUrl),
                    })
                  : savedOrganizations.length === 0 && cliAccount !== null
                    ? gt("No token saved; the server uses the Azure CLI login.")
                    : null}
            </p>
            <Button
              type="submit"
              size="xs"
              className="shrink-0"
              disabled={organizationUrl === null || submission === "" || saving}
            >
              <T>Save</T>
            </Button>
          </div>
        </fieldset>
      </form>
      {savedOrganizations.length > 0 ? (
        <ul className="grid gap-1">
          {savedOrganizations.map((saved) => (
            <li key={saved} className="flex items-center justify-between gap-3 py-1">
              <div className="min-w-0">
                <p className="truncate font-mono text-2xs text-foreground">
                  {azureDevOpsOrganizationLabel(saved)}
                </p>
                <PatCheckLine
                  check={azureDevOpsTokenCheck(auth, saved)}
                  fromSecretProvider={isSecretReference(tokens[saved])}
                  revealed={revealed}
                  onToggleRevealed={() => setRevealed((current) => !current)}
                />
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setOrganization(azureDevOpsOrganizationLabel(saved));
                    document.getElementById(tokenInputId)?.focus();
                  }}
                >
                  <T>Replace</T>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void save(saved, "")}
                >
                  <T>Remove</T>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PatCheckLine({
  check,
  fromSecretProvider,
  revealed,
  onToggleRevealed,
}: {
  readonly check: AzureDevOpsTokenCheck;
  readonly fromSecretProvider: boolean;
  readonly revealed: boolean;
  readonly onToggleRevealed: () => void;
}) {
  const gt = useGT();
  const source = fromSecretProvider ? (
    <span>
      · <T>From a secret provider</T>
    </span>
  ) : null;
  const scopeNames = (scopes: ReadonlyArray<string>) =>
    scopes.map((scope) => AZURE_DEVOPS_SCOPE_NAMES[scope] ?? scope).join(", ");
  if (check.status === "valid") {
    return (
      <div className="grid min-w-0 gap-0.5 text-2xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1">
          <span>
            <T>Signed in as</T>
          </span>
          <RedactedLogin revealed={revealed} account={check.account} />
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={onToggleRevealed}
            aria-label={
              revealed
                ? gt("Hide {label} accounts", { label: "Azure DevOps" })
                : gt("Reveal {label} accounts", { label: "Azure DevOps" })
            }
            aria-pressed={revealed}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          {source}
        </div>
        {check.missingScopes.length > 0 ? (
          <p>
            {gt("Missing scopes: {scopes}. Features that need them won't work.", {
              scopes: scopeNames(check.missingScopes),
            })}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
      <span>
        {check.status === "rejected"
          ? gt("Token rejected. Replace it with a new token.")
          : check.status === "organization-not-found"
            ? gt("Organization not found. Check the organization URL.")
            : check.status === "missing-scopes"
              ? gt("Missing scopes: {scopes}. Replace the token with one that has them.", {
                  scopes: scopeNames(check.scopes),
                })
              : check.status === "unsupported-version"
                ? gt(
                    "This server offers REST API {version}; T3 Code needs 7.1 (Azure DevOps Server 2022.1 or newer).",
                    { version: check.version },
                  )
                : check.status === "secret-unresolved"
                  ? gt("Could not read the token from its secret provider.")
                  : check.status === "not-checked"
                    ? gt("Not checked yet.")
                    : gt("Could not check the token.")}
      </span>
      {source}
    </p>
  );
}
