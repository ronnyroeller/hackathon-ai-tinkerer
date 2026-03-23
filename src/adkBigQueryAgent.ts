import "dotenv/config";

import { Content } from "@google/genai";
import {
  InMemorySessionService,
  isFinalResponse,
  LlmAgent,
  MCPToolset,
  Runner,
  StreamableHTTPConnectionParams,
  stringifyContent,
} from "@google/adk";

const APP_NAME = "hackathon-ai-tinkerer";
const DEFAULT_MODEL = process.env.ADK_MODEL || "gemini-2.5-flash-lite";

export async function askBigQueryAgent(prompt: string): Promise<string> {
  const toolset = new MCPToolset(getConnectionParams());
  const sessionService = new InMemorySessionService();

  try {
    const agent = new LlmAgent({
      name: "bigquery_mcp_assistant",
      model: DEFAULT_MODEL,
      instruction:
        "You are a concise assistant that can use the Google BigQuery MCP server. " +
        "Use MCP tools when they help answer the user. Do not invent tool results.",
      tools: [toolset],
    });

    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
    });

    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: "web-user",
      state: {},
    });

    const message: Content = {
      role: "user",
      parts: [{ text: prompt }],
    };

    let finalText = "";

    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: message,
    })) {
      if (isFinalResponse(event)) {
        finalText = stringifyContent(event).trim();
      }
    }

    if (!finalText) {
      throw new AdkAgentError(
        "The ADK agent finished without producing a final text response.",
      );
    }

    return finalText;
  } catch (error) {
    throw toAdkAgentError(error);
  } finally {
    await toolset.close();
  }
}

function getConnectionParams(): StreamableHTTPConnectionParams {
  return {
    type: "StreamableHTTPConnectionParams",
    url: "https://bigquery.googleapis.com/mcp",
  };
}

function toAdkAgentError(error: unknown): AdkAgentError {
  if (error instanceof AdkAgentError) {
    return error;
  }

  if (error instanceof Error) {
    return new AdkAgentError(error.message);
  }

  return new AdkAgentError("Unknown ADK error");
}

export class AdkAgentError extends Error {}
