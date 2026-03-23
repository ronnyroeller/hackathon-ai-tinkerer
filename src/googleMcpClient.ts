import { GoogleAuth } from "google-auth-library";

type JsonRpcId = number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcError;
};

type ListToolsResult = {
  tools: unknown[];
};

type CallToolResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

type CallToolParams = {
  server: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  apiKey?: string;
};

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export class GoogleMcpClient {
  private readonly auth = new GoogleAuth({
    scopes: [CLOUD_PLATFORM_SCOPE],
  });

  private nextId = 1;

  async listTools(server: string): Promise<ListToolsResult> {
    return this.sendJsonRpcRequest<ListToolsResult>({
      server,
      method: "tools/list",
    });
  }

  async callTool(params: CallToolParams): Promise<CallToolResult> {
    return this.sendJsonRpcRequest<CallToolResult>({
      server: params.server,
      method: "tools/call",
      params: {
        name: params.toolName,
        arguments: params.arguments ?? {},
      },
      apiKey: params.apiKey,
    });
  }

  private async sendJsonRpcRequest<T>({
    server,
    method,
    params,
    apiKey,
  }: {
    server: string;
    method: string;
    params?: Record<string, unknown>;
    apiKey?: string;
  }): Promise<T> {
    const endpoint = normalizeServerEndpoint(server);
    const headers = await this.buildHeaders(method, apiKey);

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(this.createRequest(method, params)),
    });

    const responseText = await response.text();
    const payload = parseJsonRpcResponse<T>(responseText);

    if (!response.ok) {
      throw new GoogleMcpTransportError(
        `Google MCP server request failed with status ${response.status}`,
        response.status,
        payload,
      );
    }

    if (payload.error) {
      throw new GoogleMcpError(
        `Google MCP server returned JSON-RPC error ${payload.error.code}: ${payload.error.message}`,
      );
    }

    if (payload.result === undefined) {
      throw new GoogleMcpError("Google MCP server returned no result");
    }

    return payload.result;
  }

  private createRequest(
    method: string,
    params?: Record<string, unknown>,
  ): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      ...(params ? { params } : {}),
    };
  }

  private async buildHeaders(
    method: string,
    apiKey?: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey) {
      headers["x-goog-api-key"] = apiKey;
      return headers;
    }

    if (method === "tools/list") {
      return headers;
    }

    const client = await this.auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    const accessToken =
      typeof accessTokenResponse === "string"
        ? accessTokenResponse
        : accessTokenResponse?.token;

    if (!accessToken) {
      throw new GoogleMcpError(
        "Unable to acquire a Google access token. Configure Application Default Credentials first.",
      );
    }

    headers.authorization = `Bearer ${accessToken}`;
    return headers;
  }
}

export class GoogleMcpError extends Error {}

export class GoogleMcpTransportError extends GoogleMcpError {
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
  }
}

function normalizeServerEndpoint(server: string): string {
  if (server.startsWith("https://")) {
    return server.endsWith("/mcp") ? server : `${server.replace(/\/$/, "")}/mcp`;
  }

  const normalizedServer = server.endsWith("/mcp") ? server : `${server}/mcp`;
  return `https://${normalizedServer}`;
}

function parseJsonRpcResponse<T>(responseText: string): JsonRpcResponse<T> {
  try {
    return JSON.parse(responseText) as JsonRpcResponse<T>;
  } catch {
    throw new GoogleMcpError(
      `Google MCP server returned non-JSON response: ${responseText.slice(0, 300)}`,
    );
  }
}
