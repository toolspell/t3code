import { SourceControlProviderKind } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

const DEFAULT_API_VERSION = "7.1";
// Azure DevOps holds an over-budget request for up to 30 seconds before answering it.
const REQUEST_TIMEOUT = Duration.seconds(60);
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RESOURCE_AREAS_API_VERSION = "7.1-preview";
const KIND = SourceControlProviderKind.make("azure-devops");

export const AzureDevOpsRestErrorReason = Schema.Literals([
  "request",
  "authentication",
  "permission",
  "scope",
  "not-found",
  "rate-limited",
  "response",
]);
export type AzureDevOpsRestErrorReason = typeof AzureDevOpsRestErrorReason.Type;

const REASON_TEXT: Record<AzureDevOpsRestErrorReason, string> = {
  request: "the request did not complete",
  authentication: "the personal access token was rejected",
  permission: "the personal access token lacks permission",
  scope: "the personal access token lacks the scope this needs",
  "not-found": "not found",
  "rate-limited": "Azure DevOps is throttling requests",
  response: "Azure DevOps returned an error",
};

export class AzureDevOpsRestError extends Schema.TaggedError<AzureDevOpsRestError>()(
  "AzureDevOpsRestError",
  {
    operation: Schema.String,
    reason: AzureDevOpsRestErrorReason,
    status: Schema.optional(Schema.Number),
    /** Azure's own `message`, such as a `TF401019` explanation. Never contains the token. */
    serverMessage: Schema.optional(Schema.String),
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get detail(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    const reason = `${REASON_TEXT[this.reason]}${status}`;
    return this.serverMessage === undefined ? reason : `${reason}: ${this.serverMessage}`;
  }

  override get message(): string {
    return `Azure DevOps REST failed in ${this.operation}: ${this.detail}`;
  }
}

export interface AzureDevOpsRestRequest {
  /** `https://dev.azure.com/{org}`, `https://{org}.visualstudio.com`, or `{server}/{collection}`. */
  readonly organizationUrl: string;
  readonly token: Redacted.Redacted<string>;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  /**
   * A resource area Azure DevOps Services may serve from another host, such as `ims` on
   * `vssps.dev.azure.com`. Areas the organization does not list resolve to the organization URL.
   */
  readonly area?: string;
  /** Relative to the area's host, with each segment already URL-encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly apiVersion?: string;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly accept?: string;
  readonly maxResponseBytes?: number;
}

export interface AzureDevOpsRestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

type AzureDevOpsRestFailure =
  | AzureDevOpsRestError
  | SourceControlRateLimit.SourceControlRateLimitPausedError;

export class AzureDevOpsRest extends Context.Service<
  AzureDevOpsRest,
  {
    readonly request: (
      input: AzureDevOpsRestRequest,
    ) => Effect.Effect<AzureDevOpsRestResponse, AzureDevOpsRestFailure>;
    readonly json: <S extends Schema.Top>(
      input: AzureDevOpsRestRequest,
      schema: S,
    ) => Effect.Effect<S["Type"], AzureDevOpsRestFailure, S["DecodingServices"]>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsRest") {}

const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.optional(Schema.String) })),
);

const decodeResourceAreas = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      value: Schema.Array(Schema.Struct({ name: Schema.String, locationUrl: Schema.String })),
    }),
  ),
);

const encodeJsonBody = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const trimSlashes = (url: string) => url.trim().replace(/\/+$/u, "");

function organizationKey(organizationUrl: string): string {
  return trimSlashes(organizationUrl).toLowerCase();
}

/** The full request URL; `base` is the organization URL or an area's host. */
function requestUrl(base: string, input: AzureDevOpsRestRequest): string {
  const url = new URL(`${trimSlashes(base)}/${input.path.replace(/^\/+/u, "")}`);
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  url.searchParams.set("api-version", input.apiVersion ?? DEFAULT_API_VERSION);
  return url.toString();
}

/** Null for a usable answer. `body` only matters for failures. */
function classifyStatus(input: {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
}): AzureDevOpsRestErrorReason | null {
  // A rejected credential without `X-TFS-FedAuthRedirect: Suppress` gets a 203 sign-in page.
  if (input.status === 203 || (input.contentType ?? "").includes("text/html")) {
    return "authentication";
  }
  if (input.status === 429 || input.body.includes("TF400733")) return "rate-limited";
  if (input.status === 401) return "authentication";
  if (input.status === 403) return "permission";
  if (input.status === 404) return "not-found";
  return input.status >= 400 ? "response" : null;
}

const collectBytes = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  stream.pipe(
    Stream.runFold(
      () => ({ chunks: [] as Array<Uint8Array>, bytes: 0, truncated: false }),
      (state, chunk) => {
        if (state.truncated) return state;
        const room = maxBytes - state.bytes;
        const kept = chunk.byteLength > room ? chunk.slice(0, room) : chunk;
        state.chunks.push(kept);
        return {
          chunks: state.chunks,
          bytes: state.bytes + kept.byteLength,
          truncated: chunk.byteLength > room,
        };
      },
    ),
    Effect.map(({ chunks, bytes, truncated }) => {
      const joined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes: joined, truncated };
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const areaHosts = yield* Ref.make<ReadonlyMap<string, ReadonlyMap<string, string>>>(new Map());

  /**
   * Background reads fail at once while the organization is paused; a write or an interactive
   * read has someone waiting on it, so it still goes out, as for the other hosts.
   */
  const send = Effect.fn("AzureDevOpsRest.send")(function* (
    base: string,
    input: AzureDevOpsRestRequest,
  ) {
    const method = input.method ?? "GET";
    const rateLimitKey = { provider: KIND, host: organizationKey(input.organizationUrl) };
    const interactive = yield* SourceControlRateLimit.Interactive;
    const lease = yield* limits.check(
      rateLimitKey,
      interactive || method !== "GET" ? { allowPaused: true } : undefined,
    );
    const url = requestUrl(base, input);
    // The query can carry branch names and file paths.
    yield* Effect.annotateCurrentSpan({
      "http.request.method": method,
      "url.path": new URL(url).pathname,
    });
    const unsent = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.basicAuth("", Redacted.value(input.token)),
      HttpClientRequest.setHeaders({
        accept: input.accept ?? "application/json",
        "x-tfs-fedauthredirect": "Suppress",
      }),
    );
    const failure = (fields: {
      readonly reason: AzureDevOpsRestErrorReason;
      readonly status?: number;
      readonly serverMessage?: string | undefined;
      readonly retryAt?: number | undefined;
      readonly cause?: unknown;
    }) => new AzureDevOpsRestError({ operation: input.operation, ...fields });
    const bodyText =
      input.body === undefined
        ? undefined
        : typeof input.body === "string"
          ? input.body
          : yield* encodeJsonBody(input.body).pipe(
              Effect.mapError((cause) => failure({ reason: "request", cause })),
            );
    const request =
      bodyText === undefined
        ? unsent
        : unsent.pipe(
            HttpClientRequest.bodyText(bodyText, input.contentType ?? "application/json"),
          );

    const response: HttpClientResponse.HttpClientResponse = yield* httpClient.execute(request).pipe(
      // Client spans would expose the query through url.full.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => failure({ reason: "request", cause })),
    );
    const collected = yield* collectBytes(
      response.stream,
      input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    ).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "EmptyBodyError",
        () => Effect.succeed({ bytes: new Uint8Array(0), truncated: false }),
      ),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => failure({ reason: "request", status: response.status, cause })),
    );
    const now = yield* Clock.currentTimeMillis;
    const retryAt = SourceControlRateLimit.retryAtFromHeader(response.headers["retry-after"], now);
    const body = textOf(collected.bytes);
    const reason = classifyStatus({
      status: response.status,
      contentType: response.headers["content-type"],
      body: response.status >= 400 ? body : "",
    });
    if (reason === "rate-limited" || retryAt !== undefined) {
      // Microsoft asks clients to wait out `Retry-After` even on a successful answer.
      yield* limits.recordRateLimit({ ...rateLimitKey, lease, retryAt });
    } else {
      yield* limits.recordSuccess({ ...rateLimitKey, lease });
    }
    if (reason !== null) {
      return yield* failure({
        reason,
        status: response.status,
        serverMessage: Option.getOrUndefined(
          Option.flatMap(decodeServerMessage(body), (decoded) =>
            Option.fromNullishOr(decoded.message),
          ),
        ),
        retryAt,
      });
    }
    return {
      status: response.status,
      headers: response.headers,
      bytes: collected.bytes,
      truncated: collected.truncated,
    } satisfies AzureDevOpsRestResponse;
  });

  /** Azure DevOps Services serves some areas from other hosts; Server serves every area itself. */
  const areaBase = Effect.fn("AzureDevOpsRest.areaBase")(function* (input: AzureDevOpsRestRequest) {
    const organization = trimSlashes(input.organizationUrl);
    if (input.area === undefined) return organization;
    const key = organizationKey(organization);
    const area = input.area.toLowerCase();
    const cached = (yield* Ref.get(areaHosts)).get(key);
    if (cached !== undefined) return cached.get(area) ?? organization;
    const answer = yield* send(organization, {
      organizationUrl: organization,
      token: input.token,
      operation: "resourceAreas",
      path: "_apis/resourceAreas",
      apiVersion: RESOURCE_AREAS_API_VERSION,
    });
    const hosts: ReadonlyMap<string, string> = new Map(
      Option.match(decodeResourceAreas(textOf(answer.bytes)), {
        onNone: () => [],
        onSome: (decoded) =>
          decoded.value.map(
            (entry) => [entry.name.toLowerCase(), trimSlashes(entry.locationUrl)] as const,
          ),
      }),
    );
    yield* Ref.update(areaHosts, (current) => new Map(current).set(key, hosts));
    return hosts.get(area) ?? organization;
  });

  /**
   * A token without the needed scope gets the same empty 401 as a revoked one. `connectionData`
   * answers any valid token whatever its scopes, so one more request tells them apart.
   */
  const explainUnauthorized = (error: AzureDevOpsRestError, input: AzureDevOpsRestRequest) =>
    send(trimSlashes(input.organizationUrl), {
      organizationUrl: input.organizationUrl,
      token: input.token,
      operation: "connectionData",
      path: "_apis/connectionData",
      apiVersion: RESOURCE_AREAS_API_VERSION,
    }).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.fail(error),
        onSuccess: () =>
          Effect.fail(
            new AzureDevOpsRestError({
              operation: error.operation,
              reason: "scope",
              status: error.status,
            }),
          ),
      }),
    );

  const request: AzureDevOpsRest["Service"]["request"] = (input) =>
    areaBase(input).pipe(
      Effect.flatMap((base) => send(base, input)),
      Effect.catchIf(
        (error): error is AzureDevOpsRestError =>
          error._tag === "AzureDevOpsRestError" &&
          error.reason === "authentication" &&
          error.status === 401 &&
          error.serverMessage === undefined,
        (error) => explainUnauthorized(error, input),
      ),
    );

  const json: AzureDevOpsRest["Service"]["json"] = (input, schema) =>
    request(input).pipe(
      Effect.flatMap((answer) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(textOf(answer.bytes)).pipe(
          Effect.mapError(
            (cause) =>
              new AzureDevOpsRestError({
                operation: input.operation,
                reason: "response",
                status: answer.status,
                cause,
              }),
          ),
        ),
      ),
    );

  return AzureDevOpsRest.of({ request, json });
});

export const layer = Layer.effect(AzureDevOpsRest, make);
