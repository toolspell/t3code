import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type * as AzureDevOpsRest from "./AzureDevOpsRest.ts";

/** No user, or more than one, answers to a name given for a reviewer or an assignee. */
export class AzureDevOpsIdentityError extends Schema.TaggedError<AzureDevOpsIdentityError>()(
  "AzureDevOpsIdentityError",
  {
    operation: Schema.String,
    query: Schema.String,
    /** `Name (email)` of each user the name matched; empty when none did. */
    candidates: Schema.Array(Schema.String),
  },
) {
  get detail(): string {
    return this.candidates.length === 0
      ? `No Azure DevOps user matches "${this.query}".`
      : `Several Azure DevOps users match "${this.query}": ${this.candidates.join(", ")}. Name one by email.`;
  }

  override get message(): string {
    return `Azure DevOps failed in ${this.operation}: ${this.detail}`;
  }
}

export interface AzureDevOpsIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly mail: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const IDENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const IdentitiesSchema = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      providerDisplayName: Schema.optional(Schema.String),
      properties: Schema.optional(
        Schema.Struct({
          Mail: Schema.optional(Schema.Struct({ $value: Schema.optional(Schema.String) })),
        }),
      ),
    }),
  ),
});

const IdentityPickerSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      identities: Schema.Array(
        Schema.Struct({
          // Directory users never added to the organization have none, and cannot be named.
          localId: Schema.NullishOr(Schema.String),
          displayName: Schema.NullishOr(Schema.String),
          mail: Schema.NullishOr(Schema.String),
        }),
      ),
    }),
  ),
});

/**
 * The organization's user an email names exactly, or the only one whose name starts with `name`,
 * which the IdentityPicker matches by prefix. An identity id is taken as it is.
 */
export const resolveIdentity = Effect.fn("AzureDevOpsIdentities.resolveIdentity")(function* (
  rest: AzureDevOpsRest.AzureDevOpsRest["Service"],
  request: {
    readonly organizationUrl: string;
    readonly token: Redacted.Redacted<string>;
    readonly operation: string;
  },
  name: string,
) {
  const query = name.trim();
  if (IDENTITY_ID.test(query)) {
    return { id: query, displayName: query, mail: null } satisfies AzureDevOpsIdentity;
  }
  const matches: ReadonlyArray<AzureDevOpsIdentity> = EMAIL.test(query)
    ? (yield* rest.json(
        {
          ...request,
          area: "ims",
          path: "_apis/identities",
          query: { searchFilter: "General", filterValue: query, queryMembership: "None" },
        },
        IdentitiesSchema,
      )).value.map((identity) => ({
        id: identity.id,
        displayName: identity.providerDisplayName ?? query,
        mail: identity.properties?.Mail?.$value || query,
      }))
    : (yield* rest.json(
        {
          ...request,
          method: "POST",
          path: "_apis/IdentityPicker/Identities",
          apiVersion: "7.1-preview.1",
          body: {
            query,
            identityTypes: ["user"],
            operationScopes: ["ims", "source"],
            options: { MinResults: 5, MaxResults: 20 },
            properties: ["DisplayName", "Mail"],
          },
        },
        IdentityPickerSchema,
      )).results.flatMap((result) =>
        result.identities.flatMap((identity) =>
          identity.localId
            ? [
                {
                  id: identity.localId,
                  displayName: identity.displayName ?? identity.localId,
                  mail: identity.mail || null,
                },
              ]
            : [],
        ),
      );
  const unique = [...new Map(matches.map((match) => [match.id.toLowerCase(), match])).values()];
  const [only] = unique;
  if (only !== undefined && unique.length === 1) return only;
  return yield* new AzureDevOpsIdentityError({
    operation: request.operation,
    query,
    candidates: unique.map((match) =>
      match.mail === null ? match.displayName : `${match.displayName} (${match.mail})`,
    ),
  });
});
