import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { z } from "zod";

import clientNotificationSchema from "../../vendor/openai-codex-app-server-protocol/json-schema/ClientNotification.json" with { type: "json" };
import clientRequestSchema from "../../vendor/openai-codex-app-server-protocol/json-schema/ClientRequest.json" with { type: "json" };
import jsonRpcMessageSchema from "../../vendor/openai-codex-app-server-protocol/json-schema/JSONRPCMessage.json" with { type: "json" };
import serverNotificationSchema from "../../vendor/openai-codex-app-server-protocol/json-schema/ServerNotification.json" with { type: "json" };
import serverRequestSchema from "../../vendor/openai-codex-app-server-protocol/json-schema/ServerRequest.json" with { type: "json" };
import type { ClientNotification } from "../../vendor/openai-codex-app-server-protocol/typescript/ClientNotification.js";
import type { ClientRequest } from "../../vendor/openai-codex-app-server-protocol/typescript/ClientRequest.js";
import type { ServerNotification } from "../../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";
import type { ServerRequest } from "../../vendor/openai-codex-app-server-protocol/typescript/ServerRequest.js";
import {
  CodexClientResponseSchemas,
  CodexServerResponseSchemas,
} from "./generated/codex-methods.js";

const INT_32_MIN = -(2 ** 31);
const INT_32_MAX = 2 ** 31 - 1;
const UINT_16_MAX = 2 ** 16 - 1;
const UINT_32_MAX = 2 ** 32 - 1;
const jsonValueSchema = z.json();
const emptyParamsSchema = z.strictObject({});

export type JsonValue = z.infer<typeof jsonValueSchema>;
type RequestId = string | number;

interface WireRequest {
  readonly error?: never;
  readonly id: RequestId;
  readonly method: string;
  readonly params?: JsonValue;
  readonly result?: never;
  readonly trace?: {
    readonly traceparent?: string | null;
    readonly tracestate?: string | null;
  } | null;
}

interface WireNotification {
  readonly error?: never;
  readonly id?: never;
  readonly method: string;
  readonly params?: JsonValue;
  readonly result?: never;
}

interface WireSuccessResponse {
  readonly error?: never;
  readonly id: RequestId;
  readonly method?: never;
  readonly result: JsonValue;
}

interface WireErrorResponse {
  readonly error: {
    readonly code: number;
    readonly data?: JsonValue;
    readonly message: string;
  };
  readonly id: RequestId;
  readonly method?: never;
  readonly result?: never;
}

export type CodexWireMessage =
  | WireRequest
  | WireNotification
  | WireSuccessResponse
  | WireErrorResponse;

export type JsonRpcLibraryMessage = CodexWireMessage & {
  readonly jsonrpc: "2.0";
};

const integerBetween =
  (minimum: number, maximum: number) =>
  (value: number): boolean =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  // Schemars uses `properties` without a redundant `type: "object"`.
  strictTypes: false,
});
ajv.addFormat("double", { type: "number", validate: Number.isFinite });
ajv.addFormat("int32", {
  type: "number",
  validate: integerBetween(INT_32_MIN, INT_32_MAX),
});
ajv.addFormat("int64", { type: "number", validate: Number.isSafeInteger });
ajv.addFormat("uint", {
  type: "number",
  validate: integerBetween(0, Number.MAX_SAFE_INTEGER),
});
ajv.addFormat("uint16", {
  type: "number",
  validate: integerBetween(0, UINT_16_MAX),
});
ajv.addFormat("uint32", {
  type: "number",
  validate: integerBetween(0, UINT_32_MAX),
});
ajv.addFormat("uint64", {
  type: "number",
  validate: integerBetween(0, Number.MAX_SAFE_INTEGER),
});

const validateWireMessage = ajv.compile<CodexWireMessage>(jsonRpcMessageSchema);
const clientRequestValidators = new Map<
  string,
  {
    readonly parameterless: boolean;
    readonly validate: ValidateFunction<ClientRequest>;
  }
>();
for (const branch of clientRequestSchema.oneOf) {
  const [method] = branch.properties.method.enum;
  if (method) {
    clientRequestValidators.set(method, {
      parameterless:
        "type" in branch.properties.params &&
        branch.properties.params.type === "null",
      validate: ajv.compile<ClientRequest>({
        ...branch,
        definitions: clientRequestSchema.definitions,
      }),
    });
  }
}
// The desktop still calls this method, but Schemars omits it from ClientRequest.
clientRequestValidators.set("getAuthStatus", {
  parameterless: false,
  validate: ajv.compile<ClientRequest>({
    properties: {
      id: { anyOf: [{ type: "string" }, { type: "integer" }] },
      method: { const: "getAuthStatus" },
      params: {
        properties: {
          includeToken: { type: ["boolean", "null"] },
          refreshToken: { type: ["boolean", "null"] },
        },
        required: ["includeToken", "refreshToken"],
        type: "object",
      },
    },
    required: ["id", "method", "params"],
    type: "object",
  }),
});
const validateClientNotification = ajv.compile<ClientNotification>(
  clientNotificationSchema
);
const validateServerRequest = ajv.compile<ServerRequest>(serverRequestSchema);
const validateServerNotification = ajv.compile<ServerNotification>(
  serverNotificationSchema
);
type ResponseSchemaMap =
  | typeof CodexClientResponseSchemas
  | typeof CodexServerResponseSchemas;
const compileResponseSchemas = (
  schemas: ResponseSchemaMap
): Map<string, ValidateFunction<JsonValue>> => {
  const validators = new Map<string, ValidateFunction<JsonValue>>();
  for (const [method, schema] of Object.entries(schemas)) {
    validators.set(method, ajv.compile<JsonValue>(schema));
  }
  return validators;
};
const clientResponseValidators = compileResponseSchemas(
  CodexClientResponseSchemas
);
clientResponseValidators.set(
  "getAuthStatus",
  ajv.compile<JsonValue>({
    properties: {
      authMethod: {
        enum: [
          "apikey",
          "chatgpt",
          "chatgptAuthTokens",
          "headers",
          "agentIdentity",
          "personalAccessToken",
          "bedrockApiKey",
          null,
        ],
      },
      authToken: { type: ["string", "null"] },
      requiresOpenaiAuth: { type: ["boolean", "null"] },
    },
    required: ["authMethod", "authToken", "requiresOpenaiAuth"],
    type: "object",
  })
);
const serverResponseValidators = compileResponseSchemas(
  CodexServerResponseSchemas
);

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

const requireValid = <Value>(
  validator: ValidateFunction<Value>,
  value: JsonValue,
  label: string
): Value => {
  if (validator(value)) {
    return value;
  }
  throw new ProtocolValidationError(
    `${label} is invalid: ${ajv.errorsText(validator.errors, { separator: "; " })}`
  );
};

export const parseCodexWireMessage = (text: string): CodexWireMessage =>
  requireValid(
    validateWireMessage,
    jsonValueSchema.parse(JSON.parse(text)),
    "JSON-RPC message"
  );

export const addJsonRpcVersion = (
  message: CodexWireMessage
): JsonRpcLibraryMessage => ({ ...message, jsonrpc: "2.0" });

export const removeJsonRpcVersion = (
  message: JsonRpcLibraryMessage
): CodexWireMessage => {
  const { jsonrpc: _jsonRpcVersion, ...wireMessage } = message;
  return wireMessage;
};

export const parseClientRequest = (value: CodexWireMessage): ClientRequest => {
  const { method } = value;
  const entry =
    method === undefined ? undefined : clientRequestValidators.get(method);
  if (!entry) {
    throw new ProtocolValidationError(
      `Unsupported Codex client method: ${method ?? "missing method"}`
    );
  }
  const params = "params" in value ? value.params : undefined;
  const emptyParams =
    params === undefined || emptyParamsSchema.safeParse(params).success;
  const request =
    entry.parameterless && emptyParams ? { ...value, params: null } : value;
  return requireValid(
    entry.validate,
    jsonValueSchema.parse(request),
    `Codex client request for ${method}`
  );
};

export const parseClientNotification = (
  value: CodexWireMessage
): ClientNotification =>
  requireValid(
    validateClientNotification,
    jsonValueSchema.parse(value),
    "Codex client notification"
  );

export const parseServerRequest = (value: CodexWireMessage): ServerRequest =>
  requireValid(
    validateServerRequest,
    jsonValueSchema.parse(value),
    "Codex server request"
  );

export const parseServerNotification = (
  value: CodexWireMessage
): ServerNotification =>
  requireValid(
    validateServerNotification,
    jsonValueSchema.parse(value),
    "Codex server notification"
  );

const validateResponse = (
  validators: ReadonlyMap<string, ValidateFunction<JsonValue>>,
  method: string,
  value: JsonValue,
  label: string
): void => {
  const validator = validators.get(method);
  if (validator) {
    requireValid(validator, value, `${label} for ${method}`);
  }
};

export const validateClientResponse = (
  method: string,
  value: JsonValue
): void => {
  validateResponse(
    clientResponseValidators,
    method,
    value,
    "Codex client-method response"
  );
};

export const validateServerResponse = (
  method: string,
  value: JsonValue
): void => {
  validateResponse(
    serverResponseValidators,
    method,
    value,
    "Codex server-method response"
  );
};
