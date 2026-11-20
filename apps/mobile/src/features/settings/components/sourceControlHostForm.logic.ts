import type { SourceControlDefinition } from "@t3tools/client-runtime/source-control-clients";
import * as Schema from "effect/Schema";

export type HostSettings = NonNullable<SourceControlDefinition["settings"]>;

/** The fields a host declares, in its own order, with what its schema says about each. */
export function hostSettingsFields(settings: HostSettings) {
  const order = Schema.resolveAnnotations(settings)?.providerSettingsFormSchema?.order ?? [];
  const position = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return Object.keys(settings.fields)
    .sort((left, right) => position(left) - position(right))
    .flatMap((key) => {
      const field = settings.fields[key]!;
      const annotations = Schema.resolveAnnotationsKey(field) ?? Schema.resolveAnnotations(field);
      const form = annotations?.providerSettingsForm ?? {};
      if (form.hidden) return [];
      return [
        {
          key,
          label: typeof annotations?.title === "string" ? annotations.title : key,
          description:
            typeof annotations?.description === "string" ? annotations.description : undefined,
          placeholder: form.placeholder,
          secret: form.control === "password",
        },
      ];
    });
}

export const hasVisibleHostFields = (settings: HostSettings | undefined) =>
  settings !== undefined && hostSettingsFields(settings).length > 0;

/** Whether the app has a form to save this host's credentials. */
export const hasMobileCredentialsForm = (
  definition: Pick<SourceControlDefinition, "credentials" | "settings"> | undefined,
) => definition?.credentials !== undefined || hasVisibleHostFields(definition?.settings);
