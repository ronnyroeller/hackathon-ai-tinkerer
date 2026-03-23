import "dotenv/config";

import { GoogleAuth } from "google-auth-library";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_PROJECT_ID = "ai-tinkerer-hackathon";
const DEFAULT_LOCATION = "europe-west4";
const DEFAULT_CORPUS =
  "projects/ai-tinkerer-hackathon/locations/europe-west4/ragCorpora/6917529027641081856";
const DEFAULT_TOP_K = 5;
const AIPLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const auth = new GoogleAuth({
  scopes: [AIPLATFORM_SCOPE],
});

const server = new McpServer({
  name: "vertex-rag-best-practices",
  version: "1.0.0",
});

server.registerTool(
  "search_best_practices",
  {
    description:
      "Search the Vertex AI RAG corpus containing best-practice markdown documents. " +
      "Use this to find relevant guidance before answering the user. " +
      "You may call it multiple times with improved search wording.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe("The search query to send to the Vertex RAG corpus."),
      topK: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many contexts to retrieve. Defaults to 5."),
    },
    outputSchema: {
      corpus: z.string(),
      contexts: z.array(
        z.object({
          sourceDisplayName: z.string().optional(),
          sourceUri: z.string().optional(),
          score: z.number().optional(),
          text: z.string(),
        }),
      ),
    },
  },
  async ({ query, topK }) => {
    const response = await retrieveContexts({
      query,
      topK: topK ?? DEFAULT_TOP_K,
    });

    const contexts = (response.contexts?.contexts ?? []).map((context) => ({
      sourceDisplayName: context.sourceDisplayName,
      sourceUri: context.sourceUri,
      score: context.score,
      text: context.text ?? "",
    }));

    const corpus = await getCorpusName();
    const structuredContent = {
      corpus,
      contexts,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    };
  },
);

main().catch((error) => {
  console.error("Vertex RAG MCP server error:", error);
  process.exit(1);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function retrieveContexts({ query, topK }) {
  const config = getConfig();
  const corpus = await getCorpusName();

  return vertexRequest({
    location: config.location,
    path: `/projects/${config.projectId}/locations/${config.location}:retrieveContexts`,
    method: "POST",
    body: {
      vertexRagStore: {
        ragResources: [{ ragCorpus: corpus }],
      },
      query: {
        text: query,
        ragRetrievalConfig: {
          topK,
        },
      },
    },
  });
}

let cachedCorpusName;

async function getCorpusName() {
  if (cachedCorpusName) {
    return cachedCorpusName;
  }

  cachedCorpusName = DEFAULT_CORPUS;
  return cachedCorpusName;
}

async function vertexRequest({ location, path, method, body }) {
  const token = await getAccessToken();
  const response = await fetch(`https://${location}-aiplatform.googleapis.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(
      `Vertex API request failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

async function getAccessToken() {
  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token =
    typeof accessTokenResponse === "string"
      ? accessTokenResponse
      : accessTokenResponse?.token;

  if (!token) {
    throw new Error(
      "Unable to acquire Google credentials. Run gcloud auth application-default login first.",
    );
  }

  return token;
}

function getConfig() {
  return {
    projectId: process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID,
    location: process.env.VERTEX_RAG_LOCATION || DEFAULT_LOCATION,
  };
}
