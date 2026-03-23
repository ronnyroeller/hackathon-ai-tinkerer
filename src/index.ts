import express from "express";
import path from "node:path";
import {
  askBestPracticesAgent,
  VertexBestPracticesAgentError,
} from "./adkVertexBestPracticesAgent";
import { getAppStats } from "./dataStats";
import {
  GoogleMcpClient,
  GoogleMcpError,
  GoogleMcpTransportError,
} from "./googleMcpClient";

const app = express();
const port = Number(process.env.PORT) || 8080;
const googleMcpClient = new GoogleMcpClient();
const publicDir = path.join(__dirname, "public");

app.use(express.json());

app.get("/mcp/tools", async (req, res) => {
  const server = getServerParam(req.query.server);

  if (!server) {
    res.status(400).json({
      error: "Missing required query parameter: server",
    });
    return;
  }

  try {
    const result = await googleMcpClient.listTools(server);
    res.json(result);
  } catch (error) {
    handleGoogleMcpError(error, res);
  }
});

app.post("/mcp/call", async (req, res) => {
  const { server, toolName, arguments: toolArguments, apiKey } = req.body ?? {};

  if (typeof server !== "string" || typeof toolName !== "string") {
    res.status(400).json({
      error: "Request body must include string fields: server and toolName",
    });
    return;
  }

  try {
    const result = await googleMcpClient.callTool({
      server,
      toolName,
      arguments: isPlainObject(toolArguments) ? toolArguments : {},
      apiKey: typeof apiKey === "string" ? apiKey : undefined,
    });

    res.json(result);
  } catch (error) {
    handleGoogleMcpError(error, res);
  }
});

app.post("/api/agent", async (req, res) => {
  const prompt =
    typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";

  if (!prompt) {
    res.status(400).json({
      error: "Request body must include a non-empty string field: prompt",
    });
    return;
  }

  try {
    const response = await askBestPracticesAgent(prompt);
    res.json(response);
  } catch (error) {
    if (error instanceof VertexBestPracticesAgentError) {
      console.error("Agent error:", error.message, {
        trace: error.trace,
        debug: error.debug,
      });
      res.status(500).json({
        error: error.message,
        trace: error.trace,
        debug: error.debug,
      });
      return;
    }

    console.error("Unexpected best-practices agent error:", error);
    res.status(500).json({
      error: "Unexpected best-practices agent error",
    });
  }
});

app.get("/api/agent/stream", async (req, res) => {
  const prompt =
    typeof req.query.prompt === "string" ? req.query.prompt.trim() : "";

  if (!prompt) {
    res.status(400).json({
      error: "Query string must include a non-empty prompt parameter",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sendSseEvent(res, "status", {
    message: "Starting agent run.",
  });

  try {
    const response = await askBestPracticesAgent(prompt, {
      onTrace: (item) => {
        sendSseEvent(res, "trace", item);
      },
    });

    sendSseEvent(res, "response", {
      response: response.response,
    });
    sendSseEvent(res, "done", {});
  } catch (error) {
    if (error instanceof VertexBestPracticesAgentError) {
      console.error("Agent error:", error.message, {
        trace: error.trace,
        debug: error.debug,
      });
      sendSseEvent(res, "agent-error", {
        error: error.message,
        trace: error.trace,
        debug: error.debug,
      });
      sendSseEvent(res, "done", {});
      return;
    }

    console.error("Unexpected best-practices agent error:", error);
    sendSseEvent(res, "agent-error", {
      error: "Unexpected best-practices agent error",
    });
    sendSseEvent(res, "done", {});
  } finally {
    res.end();
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const stats = await getAppStats();
    res.json(stats);
  } catch (error) {
    console.error("Stats error:", error);
    res.json({
      bestPracticeDocCount: null,
      feedbackItemCount: null,
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});

function getServerParam(server: unknown): string | undefined {
  return typeof server === "string" && server.length > 0 ? server : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleGoogleMcpError(error: unknown, res: express.Response): void {
  if (error instanceof GoogleMcpTransportError) {
    res.status(error.status).json({
      error: error.message,
      details: error.details,
    });
    return;
  }

  if (error instanceof GoogleMcpError) {
    res.status(500).json({
      error: error.message,
    });
    return;
  }

  res.status(500).json({
    error: "Unexpected error while calling Google MCP server",
  });
}

function sendSseEvent(
  res: express.Response,
  event: string,
  payload: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.use(express.static(publicDir));

app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});
