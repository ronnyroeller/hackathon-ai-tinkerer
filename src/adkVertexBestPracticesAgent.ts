import "dotenv/config";

import { GoogleGenAI } from "@google/genai";
import {
  MCPSessionManager,
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
} from "@google/adk";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

const DEFAULT_MODEL = process.env.ADK_MODEL || "gemini-2.5-flash-lite";
const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const MAX_VERTEX_QUERIES = 3;
const MAX_SQL_QUERIES = 5;
const MAX_AGENT_ROUNDS = 2;

hydrateGeminiApiKeyEnv();

export type AgentTraceItem = {
  type: "tool_call" | "tool_result" | "message";
  title: string;
  details: string;
};

export type AgentRunResult = {
  response: string;
  trace: AgentTraceItem[];
};

type EvidenceSummary = {
  fetchedFeedbackItems: number;
  bestPracticeSearches: number;
  bestPracticeEvidenceChunks: number;
};

type AgentRunOptions = {
  onTrace?: (item: AgentTraceItem) => void;
};

const queryBatchSchema = z.object({
  vertexQueries: z.array(z.string().min(1)).max(MAX_VERTEX_QUERIES).default([]),
  sqlQueries: z
    .array(
      z.object({
        purpose: z.string().min(1),
        query: z.string().min(1),
      }),
    )
    .max(MAX_SQL_QUERIES)
    .default([]),
});

const reviewSchema = z.object({
  needsMoreEvidence: z.boolean(),
  reasoning: z.string().min(1),
  vertexQueries: z.array(z.string().min(1)).max(2).default([]),
  sqlQueries: z
    .array(
      z.object({
        purpose: z.string().min(1),
        query: z.string().min(1),
      }),
    )
    .max(3)
    .default([]),
});

type QueryBatch = z.infer<typeof queryBatchSchema>;
type ReviewDecision = z.infer<typeof reviewSchema>;

export async function askBestPracticesAgent(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<AgentRunResult> {
  const trace: AgentTraceItem[] = [];
  const debugLog: string[] = [];
  const pushTrace = (item: AgentTraceItem) => {
    trace.push(item);
    options.onTrace?.(item);
  };

  try {
    const [vertexSession, bigQuerySession] = await Promise.all([
      createVertexSession(),
      createBigQuerySession(),
    ]);

    const [vertexTools, bigQueryTools] = await Promise.all([
      vertexSession.listTools(),
      bigQuerySession.listTools(),
    ]);

    debugLog.push(
      `Vertex MCP tools: ${vertexTools.tools.map((tool) => tool.name).join(", ") || "none"}`,
    );
    debugLog.push(
      `BigQuery MCP tools: ${bigQueryTools.tools.map((tool) => tool.name).join(", ") || "none"}`,
    );

    const evidence = [];
    const feedbackConfig = getFeedbackConfig();
    const usedVertexQueries = new Set<string>();
    const usedSqlQueries = new Set<string>();

    pushTrace({
      type: "message",
      title: "planning",
      details: "Preparing the first evidence-gathering pass.",
    });

    pushTrace({
      type: "tool_call",
      title: "get_table_info",
      details: `Inspecting BigQuery table ${feedbackConfig.fullAgentViewName}.`,
    });
    const tableInfo = await bigQuerySession.callTool({
      name: "get_table_info",
      arguments: {
        projectId: feedbackConfig.projectId,
        datasetId: feedbackConfig.datasetId,
        tableId: feedbackConfig.agentViewId,
      },
    });
    pushTrace({
      type: "tool_result",
      title: "get_table_info",
      details: "BigQuery returned table metadata.",
    });
    evidence.push({
      source: "bigquery_table_info",
      data: sanitizeTableInfo(tableInfo),
    });

    const initialBatch = await createAnalysisPlan(prompt, debugLog);
    debugLog.push(`Initial plan: ${JSON.stringify(initialBatch)}`);

    await executeQueryBatch({
      batch: initialBatch,
      evidence,
      vertexSession,
      bigQuerySession,
      feedbackConfig,
      usedVertexQueries,
      usedSqlQueries,
      pushTrace,
    });

    for (let round = 1; round <= MAX_AGENT_ROUNDS; round += 1) {
      const review = await reviewEvidenceAndPlanNextStep(prompt, evidence, debugLog);
      debugLog.push(`Review ${round}: ${JSON.stringify(review)}`);

      if (!review.needsMoreEvidence) {
        pushTrace({
          type: "message",
          title: "review",
          details: "The agent has enough evidence and is ready to write the plan.",
        });
        break;
      }

      const followUpBatch = filterNovelQueries(
        {
          vertexQueries: review.vertexQueries,
          sqlQueries: review.sqlQueries,
        },
        usedVertexQueries,
        usedSqlQueries,
      );

      if (
        followUpBatch.vertexQueries.length === 0 &&
        followUpBatch.sqlQueries.length === 0
      ) {
        pushTrace({
          type: "message",
          title: "review",
          details:
            "The agent wanted more evidence, but the follow-up queries repeated earlier work.",
        });
        break;
      }

      pushTrace({
        type: "message",
        title: "review",
        details: `The agent found a gap and is running a follow-up evidence pass: ${review.reasoning}`,
      });

      await executeQueryBatch({
        batch: followUpBatch,
        evidence,
        vertexSession,
        bigQuerySession,
        feedbackConfig,
        usedVertexQueries,
        usedSqlQueries,
        pushTrace,
      });
    }

    pushTrace({
      type: "message",
      title: "synthesis",
      details: "Drafting the delivery plan from the collected evidence.",
    });

    const response = await synthesizeDeliveryPlan(
      prompt,
      evidence,
      summarizeEvidence(evidence),
      debugLog,
    );
    if (!response) {
      throw new VertexBestPracticesAgentError(
        "The delivery-plan model did not return any text.",
        trace,
        debugLog.join("\n"),
      );
    }

    return {
      response,
      trace,
    };
  } catch (error) {
    throw toAgentError(error, trace, debugLog.join("\n"));
  }
}

function hydrateGeminiApiKeyEnv(): void {
  const fallbackApiKey = process.env.GOOGLE_API_KEY;

  if (fallbackApiKey) {
    if (!process.env.GOOGLE_GENAI_API_KEY) {
      process.env.GOOGLE_GENAI_API_KEY = fallbackApiKey;
    }

    if (!process.env.GEMINI_API_KEY) {
      process.env.GEMINI_API_KEY = fallbackApiKey;
    }
  }
}

async function createVertexSession() {
  const manager = new MCPSessionManager(getVertexConnectionParams());
  return manager.createSession();
}

async function createBigQuerySession() {
  const manager = new MCPSessionManager(await getBigQueryConnectionParams());
  return manager.createSession();
}

function getVertexConnectionParams(): StdioConnectionParams {
  return {
    type: "StdioConnectionParams",
    serverParams: {
      command: "node",
      args: ["scripts/vertex-rag-mcp.mjs"],
    },
  };
}

async function getBigQueryConnectionParams(): Promise<StreamableHTTPConnectionParams> {
  const accessToken = await getGoogleAccessToken();

  return {
    type: "StreamableHTTPConnectionParams",
    url: "https://bigquery.googleapis.com/mcp",
    transportOptions: {
      requestInit: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  };
}

async function getGoogleAccessToken(): Promise<string> {
  const auth = new GoogleAuth({
    scopes: [BIGQUERY_SCOPE],
  });

  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token =
    typeof accessTokenResponse === "string"
      ? accessTokenResponse
      : accessTokenResponse?.token;

  if (!token) {
    throw new Error("Unable to acquire Google credentials for BigQuery MCP access.");
  }

  return token;
}

async function createAnalysisPlan(
  prompt: string,
  debugLog: string[],
): Promise<QueryBatch> {
  const ai = createGenAI();
  const feedbackConfig = getFeedbackConfig();
  const planPrompt = [
    "You are planning evidence gathering for a delivery plan.",
    `The BigQuery table to analyze is ${feedbackConfig.fullAgentViewName}.`,
    "This table is a flat feedback view. It does NOT contain nested objects like feedback_item.*, agent_feedback.*, source.company, source.product, or rating.",
    "Available columns in the table are exactly:",
    "- id",
    "- tenant",
    "- project_id",
    "- created_at",
    "- recorded_at",
    "- created_by",
    "- source",
    "- source_lower",
    "- source_recording_id",
    "- contributor_id",
    "- contributor_name",
    "- media_category",
    "- media_preview_type",
    "- title",
    "- interpretation_plain",
    "- text",
    "- tag_ids",
    "- tag_count",
    "- ai_status",
    "- ai_interpret_status",
    "- ai_tags_status",
    "- score",
    "- searchable_text",
    "The available data sources are:",
    "- Vertex best-practice docs, searchable by short semantic queries.",
    "- BigQuery feedback data, queryable with read-only SQL.",
    "",
    "Return JSON only with this shape:",
    "{",
    '  "vertexQueries": ["...", "..."],',
    '  "sqlQueries": [{"purpose": "...", "query": "SELECT ..."}]',
    "}",
    "",
    "Requirements:",
    "- Use 1 to 3 Vertex queries.",
    "- Use 2 to 5 BigQuery SQL queries.",
    "- SQL must be read-only SELECT statements only.",
    "- SQL should help identify the company/product, the type of feedback data, candidate taxonomy coverage, and representative validation examples.",
    "- Prefer querying the provided view directly.",
    "- Keep SQL concise and practical.",
    "- Only use the listed columns. Never invent columns.",
    "- Use source, project_id, tenant, title, text, interpretation_plain, media_category, tag_ids, and searchable_text heavily.",
    "- If you need company/product inference, use project_id, source, title, text, and interpretation_plain.",
    "",
    "Good SQL patterns include:",
    `- SELECT project_id, source, COUNT(*) AS feedback_count FROM \`${feedbackConfig.fullAgentViewName}\` GROUP BY project_id, source ORDER BY feedback_count DESC LIMIT 20`,
    `- SELECT media_category, COUNT(*) AS feedback_count FROM \`${feedbackConfig.fullAgentViewName}\` GROUP BY media_category ORDER BY feedback_count DESC LIMIT 20`,
    `- SELECT title, text, interpretation_plain FROM \`${feedbackConfig.fullAgentViewName}\` WHERE text IS NOT NULL ORDER BY recorded_at DESC LIMIT 10`,
    `- SELECT COUNT(*) AS match_count FROM \`${feedbackConfig.fullAgentViewName}\` WHERE LOWER(searchable_text) LIKE '%pricing%'`,
    `- SELECT title, text FROM \`${feedbackConfig.fullAgentViewName}\` WHERE LOWER(searchable_text) LIKE '%onboarding%' LIMIT 5`,
    "",
    `User request: ${prompt}`,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: planPrompt,
    config: {
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim() ?? "";
  debugLog.push(`Planner response: ${truncate(text, 500)}`);

  const parsed = parseJsonSafely(text);
  return queryBatchSchema.parse(parsed);
}

async function reviewEvidenceAndPlanNextStep(
  prompt: string,
  evidence: unknown[],
  debugLog: string[],
): Promise<ReviewDecision> {
  const ai = createGenAI();
  const feedbackConfig = getFeedbackConfig();

  const reviewPrompt = [
    "You are reviewing gathered evidence for an AI delivery plan.",
    `The BigQuery table being analyzed is ${feedbackConfig.fullAgentViewName}.`,
    "Decide whether another small evidence pass is needed before writing the final answer.",
    "",
    "Return JSON only with this shape:",
    "{",
    '  "needsMoreEvidence": true,',
    '  "reasoning": "...",',
    '  "vertexQueries": ["..."],',
    '  "sqlQueries": [{"purpose": "...", "query": "SELECT ..."}]',
    "}",
    "",
    "Rules:",
    "- Set needsMoreEvidence to true only if important uncertainty remains.",
    "- If true, propose at most 2 Vertex queries and at most 3 SQL queries.",
    "- SQL must be read-only SELECT statements only.",
    "- Only use the known flat columns of the feedback view.",
    "- Use follow-up queries to validate weak taxonomy ideas, identify missing company/product context, or collect examples.",
    "- If the evidence already looks sufficient, set needsMoreEvidence to false and leave query arrays empty.",
    "",
    `Original request: ${prompt}`,
    "",
    "Evidence so far:",
    JSON.stringify(evidence, null, 2),
  ].join("\n");

  const response = await ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: reviewPrompt,
    config: {
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim() ?? "";
  debugLog.push(`Reviewer response: ${truncate(text, 500)}`);

  const parsed = parseJsonSafely(text);
  return reviewSchema.parse(parsed);
}

async function synthesizeDeliveryPlan(
  prompt: string,
  evidence: unknown[],
  evidenceSummary: EvidenceSummary,
  debugLog: string[],
): Promise<string> {
  const ai = createGenAI();

  const synthesisPrompt = [
    "You are a concise analyst preparing a delivery plan from evidence.",
    "Use only the evidence provided.",
    "If evidence is weak, say so explicitly.",
    "Write in clear Markdown.",
    "",
    "Return a delivery plan with exactly these sections:",
    "Description of Company/Product",
    "Description of AI Analysis Focus",
    "Suggested Taxonomy",
    "Jobs to fill Taxonomy",
    "Validation examples for the Playground (5-10)",
    "Validation Summary",
    "Recommended Next Step",
    "",
    "Requirements for the ending:",
    '- The \"Validation Summary\" section must include a line in this style: "Validated against X fetched feedback items and Y best-practice evidence chunks."',
    "- Use the exact numbers from the evidence summary provided below. Do not invent larger numbers.",
    '- The \"Recommended Next Step\" section must be a single concrete action.',
    "- If the evidence is partial, say so directly in the validation summary.",
    "",
    `Original request: ${prompt}`,
    "",
    "Evidence summary:",
    JSON.stringify(evidenceSummary, null, 2),
    "",
    "Evidence:",
    JSON.stringify(evidence, null, 2),
  ].join("\n");

  const response = await ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: synthesisPrompt,
  });

  const text = response.text?.trim() ?? "";
  debugLog.push(`Writer response: ${truncate(text, 500)}`);
  return text;
}

function createGenAI(): GoogleGenAI {
  const apiKey =
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error(
      "API key must be provided via GOOGLE_GENAI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
    );
  }

  return new GoogleGenAI({ apiKey });
}

function getFeedbackConfig() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || "ai-tinkerer-hackathon";
  const datasetId = process.env.FEEDBACK_DATASET || "feedback";
  const agentViewId = process.env.FEEDBACK_AGENT_VIEW || "feedback_agent_view";

  return {
    projectId,
    datasetId,
    agentViewId,
    fullAgentViewName: `${projectId}.${datasetId}.${agentViewId}`,
  };
}

function summarizeEvidence(evidence: unknown[]): EvidenceSummary {
  let fetchedFeedbackItems = 0;
  let bestPracticeSearches = 0;
  let bestPracticeEvidenceChunks = 0;

  for (const item of evidence) {
    if (!isRecord(item) || typeof item.source !== "string") {
      continue;
    }

    if (item.source === "bigquery_query") {
      fetchedFeedbackItems += extractBigQueryRowCount(item.data) ?? 0;
      continue;
    }

    if (item.source === "vertex_best_practices") {
      bestPracticeSearches += 1;
      bestPracticeEvidenceChunks += extractVertexContextCount(item.data) ?? 0;
    }
  }

  return {
    fetchedFeedbackItems,
    bestPracticeSearches,
    bestPracticeEvidenceChunks,
  };
}

async function executeQueryBatch({
  batch,
  evidence,
  vertexSession,
  bigQuerySession,
  feedbackConfig,
  usedVertexQueries,
  usedSqlQueries,
  pushTrace,
}: {
  batch: QueryBatch;
  evidence: unknown[];
  vertexSession: Awaited<ReturnType<typeof createVertexSession>>;
  bigQuerySession: Awaited<ReturnType<typeof createBigQuerySession>>;
  feedbackConfig: ReturnType<typeof getFeedbackConfig>;
  usedVertexQueries: Set<string>;
  usedSqlQueries: Set<string>;
  pushTrace: (item: AgentTraceItem) => void;
}) {
  for (const query of batch.vertexQueries) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || usedVertexQueries.has(normalizedQuery)) {
      continue;
    }

    usedVertexQueries.add(normalizedQuery);
    pushTrace({
      type: "tool_call",
      title: "search_best_practices",
      details: `Querying Vertex for "${normalizedQuery}".`,
    });
    const result = await vertexSession.callTool({
      name: "search_best_practices",
      arguments: {
        query: normalizedQuery,
        topK: 5,
      },
    });
    const contextCount = extractVertexContextCount(result);
    pushTrace({
      type: "tool_result",
      title: "search_best_practices",
      details:
        contextCount === null
          ? "Vertex returned best-practice evidence."
          : `Vertex returned ${contextCount} result${contextCount === 1 ? "" : "s"}.`,
    });
    evidence.push({
      source: "vertex_best_practices",
      query: normalizedQuery,
      data: result,
    });
  }

  for (const sqlItem of batch.sqlQueries) {
    const normalizedSql = normalizeSql(sqlItem.query);
    if (!normalizedSql || usedSqlQueries.has(normalizedSql)) {
      continue;
    }

    usedSqlQueries.add(normalizedSql);
    pushTrace({
      type: "tool_call",
      title: "execute_sql",
      details: `${sqlItem.purpose}: ${compactSql(normalizedSql)}`,
    });
    const result = await bigQuerySession.callTool({
      name: "execute_sql",
      arguments: {
        projectId: feedbackConfig.projectId,
        query: normalizedSql,
      },
    });
    const rowCount = extractBigQueryRowCount(result);
    pushTrace({
      type: "tool_result",
      title: "execute_sql",
      details:
        rowCount === null
          ? "BigQuery returned a query result."
          : `BigQuery returned ${rowCount} row${rowCount === 1 ? "" : "s"}.`,
    });
    evidence.push({
      source: "bigquery_query",
      purpose: sqlItem.purpose,
      query: normalizedSql,
      data: result,
    });
  }
}

function filterNovelQueries(
  batch: QueryBatch,
  usedVertexQueries: Set<string>,
  usedSqlQueries: Set<string>,
): QueryBatch {
  return {
    vertexQueries: batch.vertexQueries.filter(
      (query) => query.trim() && !usedVertexQueries.has(query.trim()),
    ),
    sqlQueries: batch.sqlQueries.filter((item) => {
      const normalizedSql = normalizeSql(item.query);
      return Boolean(normalizedSql) && !usedSqlQueries.has(normalizedSql);
    }),
  };
}

function parseJsonSafely(text: string): unknown {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

function compactSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function extractVertexContextCount(response: unknown): number | null {
  const contexts = extractVertexContexts(response);
  return contexts ? contexts.length : null;
}

function extractVertexContexts(response: unknown): unknown[] | null {
  if (!isRecord(response)) {
    return null;
  }

  if (
    isRecord(response.structuredContent) &&
    Array.isArray(response.structuredContent.contexts)
  ) {
    return response.structuredContent.contexts as unknown[];
  }

  if (Array.isArray(response.contexts)) {
    return response.contexts;
  }

  if (isRecord(response.result)) {
    return extractVertexContexts(response.result);
  }

  return null;
}

function extractBigQueryRowCount(response: unknown): number | null {
  const rows = extractBigQueryRows(response);
  return rows ? rows.length : null;
}

function extractScalarNumber(
  response: unknown,
  fieldName: string,
): number | null {
  const directValue = findNumericFieldValue(response, fieldName);
  if (directValue !== null) {
    return directValue;
  }

  const rows = extractBigQueryRows(response);
  if (!rows || rows.length === 0) {
    return null;
  }

  const firstRow = rows[0];
  if (!isRecord(firstRow)) {
    return null;
  }

  const value = firstRow[fieldName];
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractBigQueryRows(response: unknown): unknown[] | null {
  if (!isRecord(response)) {
    if (Array.isArray(response)) {
      return response;
    }
    return null;
  }

  if (Array.isArray(response.rows)) {
    return response.rows;
  }

  if (isRecord(response.structuredContent) && Array.isArray(response.structuredContent.rows)) {
    return response.structuredContent.rows as unknown[];
  }

  if (Array.isArray(response.content)) {
    for (const item of response.content) {
      if (!isRecord(item) || typeof item.text !== "string") {
        continue;
      }

      const parsed = parseEmbeddedJson(item.text);
      const rows = extractBigQueryRows(parsed);
      if (rows) {
        return rows;
      }
    }
  }

  if (isRecord(response.result)) {
    return extractBigQueryRows(response.result);
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTableInfo(response: unknown): unknown {
  if (!isRecord(response)) {
    return response;
  }

  const sanitized: Record<string, unknown> = {};

  for (const key of ["name", "description", "schema", "type"]) {
    if (key in response) {
      sanitized[key] = response[key];
    }
  }

  if (isRecord(response.structuredContent)) {
    const structuredContent = response.structuredContent;
    const sanitizedStructured: Record<string, unknown> = {};

    for (const key of ["name", "description", "schema", "type"]) {
      if (key in structuredContent) {
        sanitizedStructured[key] = structuredContent[key];
      }
    }

    if (Object.keys(sanitizedStructured).length > 0) {
      sanitized.structuredContent = sanitizedStructured;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : response;
}

function findNumericFieldValue(
  value: unknown,
  fieldName: string,
): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findNumericFieldValue(item, fieldName);
      if (result !== null) {
        return result;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (fieldName in value) {
    const numericValue = toNumber(value[fieldName]);
    if (numericValue !== null) {
      return numericValue;
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (typeof nestedValue === "string") {
      const parsed = parseEmbeddedJson(nestedValue);
      if (parsed !== null) {
        const result = findNumericFieldValue(parsed, fieldName);
        if (result !== null) {
          return result;
        }
      }
      continue;
    }

    const result = findNumericFieldValue(nestedValue, fieldName);
    if (result !== null) {
      return result;
    }
  }

  return null;
}

function parseEmbeddedJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function toAgentError(
  error: unknown,
  trace: AgentTraceItem[] = [],
  debug = "",
): VertexBestPracticesAgentError {
  if (error instanceof VertexBestPracticesAgentError) {
    return error;
  }

  if (error instanceof Error) {
    return new VertexBestPracticesAgentError(error.message, trace, debug);
  }

  return new VertexBestPracticesAgentError(
    "Unknown agent orchestration error",
    trace,
    debug,
  );
}

export class VertexBestPracticesAgentError extends Error {
  constructor(
    message: string,
    readonly trace: AgentTraceItem[] = [],
    readonly debug?: string,
  ) {
    super(message);
  }
}
