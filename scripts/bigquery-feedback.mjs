import "dotenv/config";

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

const DEFAULT_PROJECT_ID = "ai-tinkerer-hackathon";
const DEFAULT_LOCATION = "europe-west4";
const DEFAULT_DATASET = "feedback";
const DEFAULT_RAW_TABLE = "feedback_raw";
const DEFAULT_AGENT_VIEW = "feedback_agent_view";
const DEFAULT_OVERVIEW_VIEW = "feedback_project_overview";
const DEFAULT_GCS_PREFIX = "gs://ai-tinkerer-hackathon-rag/feedback/";
const DEFAULT_SOURCE = "data/feedback/spotify.jsonl";
const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const auth = new GoogleAuth({
  scopes: [BIGQUERY_SCOPE],
});

const command = process.argv[2];

if (command === "setup") {
  await setupFeedback(process.argv[3] || DEFAULT_SOURCE);
} else if (command === "sample") {
  await sampleFeedback();
} else if (command === "profile") {
  await profileFeedback();
} else {
  printUsage();
  process.exitCode = 1;
}

async function setupFeedback(sourceInput) {
  const config = getConfig();
  const sourceUri = resolveSourceUri(sourceInput, config.gcsPrefix);

  console.log(`Using project ${config.projectId} in ${config.location}`);
  console.log(`Dataset: ${config.datasetId}`);
  console.log(`Raw table: ${config.rawTableId}`);
  console.log(`Agent view: ${config.agentViewId}`);
  console.log(`Overview view: ${config.overviewViewId}`);
  console.log(`Source URI: ${sourceUri}`);

  await ensureDataset(config);
  await runLoadJob(config, sourceUri);
  await runQuery(config, buildAgentViewSql(config));
  await runQuery(config, buildOverviewViewSql(config));

  console.log("");
  console.log("Feedback dataset is ready for BigQuery MCP access.");
  console.log("Suggested next checks:");
  console.log("  npm run feedback:profile");
  console.log("  npm run feedback:sample");
}

async function sampleFeedback() {
  const config = getConfig();
  const query = `
    SELECT
      tenant,
      project_id,
      source,
      title,
      text,
      tag_ids
    FROM ${tableRef(config.projectId, config.datasetId, config.agentViewId)}
    ORDER BY recorded_at DESC NULLS LAST
    LIMIT 5
  `;

  const rows = await runQuery(config, query);
  printRows(rows);
}

async function profileFeedback() {
  const config = getConfig();
  const query = `
    SELECT *
    FROM ${tableRef(config.projectId, config.datasetId, config.overviewViewId)}
    ORDER BY feedback_count DESC
    LIMIT 20
  `;

  const rows = await runQuery(config, query);
  printRows(rows);
}

function resolveSourceUri(sourceInput, gcsPrefix) {
  if (sourceInput.startsWith("gs://")) {
    return sourceInput;
  }

  if (!existsSync(sourceInput)) {
    throw new Error(
      `Source file not found: ${sourceInput}. Pass a local JSONL path or gs:// URI.`,
    );
  }

  const destination = `${ensureTrailingSlash(gcsPrefix)}${path.basename(sourceInput)}`;
  console.log(`Uploading ${sourceInput} to ${destination}`);

  const result = spawnSync(
    "gcloud",
    ["storage", "cp", sourceInput, destination],
    {
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("gcloud storage cp failed");
  }

  return destination;
}

async function ensureDataset(config) {
  try {
    await bigQueryRequest({
      path: `/projects/${config.projectId}/datasets/${config.datasetId}`,
      method: "GET",
    });
    console.log(`Dataset ${config.datasetId} already exists.`);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    console.log(`Creating dataset ${config.datasetId}`);
    await bigQueryRequest({
      path: `/projects/${config.projectId}/datasets`,
      method: "POST",
      body: {
        datasetReference: {
          projectId: config.projectId,
          datasetId: config.datasetId,
        },
        location: config.location,
      },
    });
  }
}

async function runLoadJob(config, sourceUri) {
  console.log(`Loading ${sourceUri} into ${config.rawTableId}`);

  const job = await bigQueryRequest({
    path: `/projects/${config.projectId}/jobs`,
    method: "POST",
    body: {
      jobReference: {
        projectId: config.projectId,
        location: config.location,
      },
      configuration: {
        load: {
          sourceUris: [sourceUri],
          sourceFormat: "NEWLINE_DELIMITED_JSON",
          autodetect: true,
          writeDisposition: "WRITE_TRUNCATE",
          createDisposition: "CREATE_IF_NEEDED",
          destinationTable: {
            projectId: config.projectId,
            datasetId: config.datasetId,
            tableId: config.rawTableId,
          },
        },
      },
    },
  });

  await waitForJob(config, job.jobReference.jobId);
}

async function runQuery(config, query) {
  const response = await bigQueryRequest({
    path: `/projects/${config.projectId}/queries`,
    method: "POST",
    body: {
      query,
      useLegacySql: false,
      location: config.location,
    },
  });

  if (response.jobComplete === false) {
    throw new Error("Query did not complete synchronously.");
  }

  return mapRows(response.schema, response.rows ?? []);
}

async function waitForJob(config, jobId) {
  for (;;) {
    const response = await bigQueryRequest({
      path: `/projects/${config.projectId}/jobs/${jobId}?location=${config.location}`,
      method: "GET",
    });

    if (response.status?.state === "DONE") {
      if (response.status.errorResult) {
        throw new Error(
          `BigQuery job failed: ${JSON.stringify(response.status.errorResult)}`,
        );
      }

      console.log("BigQuery load job completed.");
      return;
    }

    await sleep(2000);
  }
}

async function bigQueryRequest({ path, method, body }) {
  const token = await getAccessToken();
  const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2${path}`, {
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
    const error = new Error(
      `BigQuery API request failed (${response.status}): ${JSON.stringify(payload)}`,
    );
    error.status = response.status;
    throw error;
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
      "Unable to acquire Google credentials. Run `gcloud auth application-default login` first.",
    );
  }

  return token;
}

function buildAgentViewSql(config) {
  const rawTable = tableRef(config.projectId, config.datasetId, config.rawTableId);
  const agentView = tableRef(config.projectId, config.datasetId, config.agentViewId);

  return `
    CREATE OR REPLACE VIEW ${agentView} AS
    SELECT
      id,
      tenant,
      project_id,
      SAFE_CAST(createdAt AS TIMESTAMP) AS created_at,
      SAFE_CAST(recordedAt AS TIMESTAMP) AS recorded_at,
      createdBy AS created_by,
      source,
      source_lower,
      source_recording_id,
      contributor_id,
      contributor_name,
      media_category,
      media_preview_type,
      title,
      interpretation_plain,
      text,
      tag_ids,
      ARRAY_LENGTH(tag_ids) AS tag_count,
      ai_status,
      ai_interpret_status,
      ai_tags_status,
      score,
      LOWER(CONCAT(
        IFNULL(title, ''),
        ' ',
        IFNULL(text, ''),
        ' ',
        IFNULL(interpretation_plain, '')
      )) AS searchable_text
    FROM ${rawTable}
  `;
}

function buildOverviewViewSql(config) {
  const rawTable = tableRef(config.projectId, config.datasetId, config.rawTableId);
  const overviewView = tableRef(
    config.projectId,
    config.datasetId,
    config.overviewViewId,
  );

  return `
    CREATE OR REPLACE VIEW ${overviewView} AS
    SELECT
      tenant,
      project_id,
      COUNT(*) AS feedback_count,
      COUNTIF(IFNULL(text, '') != '') AS text_count,
      COUNTIF(IFNULL(title, '') != '') AS title_count,
      COUNT(DISTINCT source) AS distinct_sources,
      ARRAY_AGG(DISTINCT source IGNORE NULLS LIMIT 20) AS sources,
      COUNT(DISTINCT media_category) AS distinct_media_categories,
      ARRAY_AGG(DISTINCT media_category IGNORE NULLS LIMIT 10) AS media_categories,
      MIN(SAFE_CAST(recordedAt AS TIMESTAMP)) AS earliest_recorded_at,
      MAX(SAFE_CAST(recordedAt AS TIMESTAMP)) AS latest_recorded_at,
      APPROX_COUNT_DISTINCT(contributor_id) AS approx_contributor_count,
      AVG(ARRAY_LENGTH(tag_ids)) AS avg_tag_count
    FROM ${rawTable}
    GROUP BY tenant, project_id
  `;
}

function mapRows(schema, rows) {
  const fields = schema?.fields ?? [];
  return rows.map((row) => mapRow(fields, row.f ?? []));
}

function mapRow(fields, cells) {
  const result = {};

  for (let index = 0; index < fields.length; index += 1) {
    result[fields[index].name] = mapCell(fields[index], cells[index]?.v);
  }

  return result;
}

function mapCell(field, value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (field.mode === "REPEATED") {
    return (value ?? []).map((item) => mapCell({ ...field, mode: "NULLABLE" }, item.v));
  }

  if (field.type === "RECORD" && Array.isArray(value.f)) {
    return mapRow(field.fields ?? [], value.f);
  }

  return value;
}

function printRows(rows) {
  console.log(JSON.stringify(rows, null, 2));
}

function tableRef(projectId, datasetId, tableId) {
  return `\`${projectId}.${datasetId}.${tableId}\``;
}

function getConfig() {
  return {
    projectId: process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID,
    location: process.env.BIGQUERY_LOCATION || DEFAULT_LOCATION,
    datasetId: process.env.FEEDBACK_DATASET || DEFAULT_DATASET,
    rawTableId: process.env.FEEDBACK_RAW_TABLE || DEFAULT_RAW_TABLE,
    agentViewId: process.env.FEEDBACK_AGENT_VIEW || DEFAULT_AGENT_VIEW,
    overviewViewId: process.env.FEEDBACK_OVERVIEW_VIEW || DEFAULT_OVERVIEW_VIEW,
    gcsPrefix: process.env.FEEDBACK_GCS_PREFIX || DEFAULT_GCS_PREFIX,
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isNotFoundError(error) {
  return typeof error === "object" && error !== null && error.status === 404;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
  console.log("Usage:");
  console.log("  npm run feedback:setup -- [local-jsonl-or-gs-uri]");
  console.log("  npm run feedback:sample");
  console.log("  npm run feedback:profile");
  console.log("");
  console.log("Defaults:");
  console.log(`  source: ${DEFAULT_SOURCE}`);
  console.log(`  location: ${DEFAULT_LOCATION}`);
  console.log(`  dataset: ${DEFAULT_DATASET}`);
  console.log(`  raw table: ${DEFAULT_RAW_TABLE}`);
  console.log(`  agent view: ${DEFAULT_AGENT_VIEW}`);
  console.log(`  overview view: ${DEFAULT_OVERVIEW_VIEW}`);
  console.log(`  gcs prefix: ${DEFAULT_GCS_PREFIX}`);
}
