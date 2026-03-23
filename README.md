# hackathon-ai-tinkerer

Minimal TypeScript Node.js application for Google Cloud Run using buildpacks and source deployment, with a Vite + React frontend, an Express backend, a Google ADK agent, and MCP-based access to Vertex AI RAG.

It includes:

- a Google ADK agent for generating delivery plans from best practices plus feedback data
- a local MCP server that exposes Vertex AI RAG retrieval as a tool
- direct helper endpoints for Google-hosted MCP servers, including BigQuery

It also includes a repo-local Node tool for setting up and querying a Vertex AI RAG corpus from the markdown files under `data/best-practices`.

For structured feedback analysis, it also includes a repo-local BigQuery ingestion tool for newline-delimited JSON feedback files.

## Prerequisites

- Node.js current LTS
- npm
- Google Cloud SDK (`gcloud`)

## Install dependencies

```bash
npm install
```

## Run locally

For hot reload during development:

```bash
npm run dev
```

This starts:

- the Express backend in watch mode on `http://127.0.0.1:8080`
- the Vite frontend with HMR, proxying `/api` and `/mcp` to the backend

For a production-style local run:

```bash
npm run build
npm start
```

The app listens on `PORT`, with a default of `8080`, and serves the built React app from the Express server.

For the ADK-backed agent flow, set a Gemini API key before running locally.
Preferred env var:

```bash
export GOOGLE_GENAI_API_KEY="your-api-key"
```

Also supported by this app as a fallback:

```bash
export GOOGLE_API_KEY="your-api-key"
```

Optional model override:

```bash
export ADK_MODEL="gemini-2.5-flash-lite"
```

## Delivery Plan Agent

This app includes:

- `POST /api/agent`
- `GET /mcp/tools?server=bigquery.googleapis.com`
- `POST /mcp/call`

The browser page at `/` lets a user ask for a delivery plan, for example:

- `Create me the best practice config.`
- `Create a delivery plan for this feedback dataset.`

`POST /api/agent` runs a Google ADK `LlmAgent` that uses:

- the local Vertex RAG MCP server at [scripts/vertex-rag-mcp.mjs](/Users/ronnyroeller/git/hackathon-ai-tinkerer/scripts/vertex-rag-mcp.mjs) for best-practice guidance
- the official Google BigQuery MCP server for dataset inspection, sampling, and validation

The agent is instructed to always return a delivery plan with these sections:

- Description of Company/Product
- Description of AI Analysis Focus
- Suggested Taxonomy
- Jobs to fill Taxonomy
- Validation examples for the Playground (5-10)

Example request to ask the ADK agent:

```bash
curl -X POST "http://localhost:8080/api/agent" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create me the best practice config."
  }'
```

Example request to list tools directly:

```bash
curl "http://localhost:8080/mcp/tools?server=bigquery.googleapis.com"
```

Example request to call a tool:

```bash
curl -X POST "http://localhost:8080/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{
    "server": "bigquery.googleapis.com",
    "toolName": "list_datasets",
    "arguments": {
      "project_id": "ai-tinkerer-hackathon"
    }
  }'
```

For Vertex RAG retrieval and direct MCP tool calls from the backend, authenticate with Application Default Credentials:

```bash
gcloud auth application-default login
```

Notes:

- The ADK agent path requires a Gemini-compatible model configuration. Use `GOOGLE_GENAI_API_KEY` in production. This app also maps `GOOGLE_API_KEY` to the expected runtime env vars.
- The Vertex RAG corpus is hardcoded in the app for this project.
- The agent validates taxonomy ideas against BigQuery feedback data before recommending them.
- `tools/list` works without authentication for Google MCP servers.
- Tool calls generally require Google credentials through ADC.
- If you want to target Google Maps MCP, you can pass an `apiKey` field in `POST /mcp/call`.
- The browser page at `/` now sends free-form delivery-plan requests to the agent.

## Vertex AI RAG Tooling

This repo includes a local Node-based helper script so you can avoid Python for Vertex RAG setup.

Prerequisites:

- `gcloud config set project ai-tinkerer-hackathon`
- `gcloud services enable aiplatform.googleapis.com storage.googleapis.com`
- `gcloud auth application-default login`
- Upload your markdown files to a GCS prefix, for example:

```bash
gcloud storage cp data/best-practices/*.md gs://ai-tinkerer-hackathon-rag/best-practices/
```

Create or reuse a corpus and import the files:

```bash
npm run rag:setup
```

Test retrieval:

```bash
npm run rag:retrieve -- "What are the best practices for search vs filtering?"
```

Optional environment variables:

- `GOOGLE_CLOUD_PROJECT`
- `VERTEX_RAG_LOCATION`
- `VERTEX_RAG_BUCKET_URI`
- `VERTEX_RAG_CORPUS_DISPLAY_NAME`
- `VERTEX_RAG_CHUNK_SIZE`
- `VERTEX_RAG_CHUNK_OVERLAP`

## BigQuery Feedback Tooling

This repo includes a local Node-based helper script for loading feedback JSONL into BigQuery so it is accessible through the Google BigQuery MCP server.

Prerequisites:

- `gcloud config set project ai-tinkerer-hackathon`
- `gcloud services enable bigquery.googleapis.com storage.googleapis.com`
- `gcloud auth application-default login`

Setup from a local file:

```bash
npm run feedback:setup -- data/feedback/spotify.jsonl
```

Setup from an existing GCS object:

```bash
npm run feedback:setup -- gs://your-bucket/path/spotify.jsonl
```

This will:

- upload the local file to GCS if needed
- create dataset `feedback`
- load table `feedback.feedback_raw`
- create view `feedback.feedback_agent_view`
- create view `feedback.feedback_project_overview`

Inspect project-level profile data:

```bash
npm run feedback:profile
```

Inspect a small row sample:

```bash
npm run feedback:sample
```

Optional environment variables:

- `GOOGLE_CLOUD_PROJECT`
- `BIGQUERY_LOCATION`
- `FEEDBACK_GCS_PREFIX`
- `FEEDBACK_DATASET`
- `FEEDBACK_RAW_TABLE`
- `FEEDBACK_AGENT_VIEW`
- `FEEDBACK_OVERVIEW_VIEW`

## Set the Google Cloud project

```bash
gcloud config set project ai-tinkerer-hackathon
```

## Deploy manually

Make sure these env vars are set in your shell first:

```bash
export GOOGLE_GENAI_API_KEY="your-api-key"
```

```bash
npm run deploy
```

Equivalent `gcloud` command:

```bash
gcloud run deploy ai-tinkerer-hackathon --source . --region europe-west4 --allow-unauthenticated --set-env-vars GOOGLE_GENAI_API_KEY=$GOOGLE_GENAI_API_KEY,ADK_MODEL=gemini-2.5-flash-lite
```

When prompted, use region `europe-west4`.

## GitHub Actions deployment

The workflow at `.github/workflows/deploy.yml` deploys on every push to `main`.

Required GitHub secrets:

- `GCP_WIF_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
