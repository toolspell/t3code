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
  checkAzureDevOpsPat,
  fakeAzureDevOpsState,
  normalizeAzureDevOpsOrganizationUrl,
  savedAzureDevOpsOrganizations,
  type AzureDevOpsPatCheck,
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
  const savedTokens = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  ).tokens;
  // FAKE: screenshot states, revert before commit.
  const tokens = (fakeAzureDevOpsState()?.tokens ?? savedTokens) as typeof savedTokens;
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
  const organizationUrl = normalizeAzureDevOpsOrganizationUrl(organization);
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
                A token saved for an organization is used instead of the Azure CLI login. Each
                organization needs its own token. Give it read and write access to Code and Work
                Items.
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
                <T>Organization URL</T>
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
                ? gt("Enter an organization name or a dev.azure.com URL.")
                : isSaved
                  ? gt("Saving replaces the token for {organization}.", {
                      organization: organizationUrl.replace(/^https:\/\//u, ""),
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
                  {saved.replace(/^https:\/\//u, "")}
                </p>
                <PatCheckLine
                  check={checkAzureDevOpsPat(saved)}
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
                    setOrganization(saved.replace(/^https:\/\//u, ""));
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
  readonly check: AzureDevOpsPatCheck;
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
  if (check.status === "valid") {
    return (
      <div className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
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
    );
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
      {check.status === "rejected" ? (
        <T>Token rejected. Replace it with a new token.</T>
      ) : (
        <T>Could not check the token.</T>
      )}
      {source}
    </p>
  );
}
