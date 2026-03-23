import "dotenv/config";

import { GoogleAuth } from "google-auth-library";

const DEFAULT_PROJECT_ID = "ai-tinkerer-hackathon";
const DEFAULT_LOCATION = "europe-west4";
const DEFAULT_BUCKET_URI = "gs://ai-tinkerer-hackathon-rag/best-practices/";
const DEFAULT_CORPUS_DISPLAY_NAME = "best-practices";
const DEFAULT_CORPUS_DESCRIPTION =
  "Markdown best-practices documents from the hackathon-ai-tinkerer repo";
const DEFAULT_CORPUS =
  "projects/ai-tinkerer-hackathon/locations/europe-west4/ragCorpora/6917529027641081856";
const DEFAULT_QUERY =
  "What are the best practices for search vs filtering?";
const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_CHUNK_OVERLAP = 100;
const AIPLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const auth = new GoogleAuth({
  scopes: [AIPLATFORM_SCOPE],
});

const command = process.argv[2];

if (command === "setup") {
  await setupCorpus();
} else if (command === "retrieve") {
  await retrieveContexts(process.argv.slice(3).join(" ") || DEFAULT_QUERY);
} else {
  printUsage();
  process.exitCode = 1;
}

async function setupCorpus() {
  const config = getConfig();
  console.log(`Using project ${config.projectId} in ${config.location}`);

  const corpus = await ensureCorpus(config);
  console.log(`Corpus: ${corpus.name}`);

  const resultSink = buildImportResultSink(config.bucketUri);
  console.log(`Importing files from ${config.bucketUri}`);

  const operation = await vertexRequest({
    path: `/${corpus.name}:ragFiles:import`.replace(":ragFiles:import", "/ragFiles:import"),
    method: "POST",
    body: {
      importRagFilesConfig: {
        gcsSource: {
          uris: [config.bucketUri],
        },
        ragFileTransformationConfig: {
          ragFileChunkingConfig: {
            fixedLengthChunking: {
              chunkSize: config.chunkSize,
              chunkOverlap: config.chunkOverlap,
            },
          },
        },
        importResultGcsSink: {
          outputUriPrefix: resultSink,
        },
      },
    },
  });

  const completed = await waitForOperation(operation.name);
  console.log("Import completed.");
  console.log(JSON.stringify(completed.response ?? completed, null, 2));
  console.log("");
  console.log("Next:");
  console.log(
    `npm run rag:retrieve -- "What are the best practices for search vs filtering?"`,
  );
}

async function retrieveContexts(queryText) {
  const config = getConfig();
  const corpusName = DEFAULT_CORPUS;

  if (!corpusName) {
    throw new Error("No corpus configured.");
  }

  console.log(`Querying corpus ${corpusName}`);

  const response = await vertexRequest({
    path: `/projects/${config.projectId}/locations/${config.location}:retrieveContexts`,
    method: "POST",
    body: {
      vertexRagStore: {
        ragResources: [{ ragCorpus: corpusName }],
      },
      query: {
        text: queryText,
        ragRetrievalConfig: {
          topK: 5,
        },
      },
    },
  });

  console.log(JSON.stringify(response, null, 2));
}

async function ensureCorpus(config) {
  const existing = await findCorpusByDisplayName(config, true);
  if (existing) {
    console.log(`Reusing existing corpus ${existing}`);
    return { name: existing };
  }

  console.log(`Creating corpus "${config.corpusDisplayName}"`);

  const operation = await vertexRequest({
    path: `/projects/${config.projectId}/locations/${config.location}/ragCorpora`,
    method: "POST",
    body: {
      displayName: config.corpusDisplayName,
      description: config.corpusDescription,
    },
  });

  const completed = await waitForOperation(operation.name);
  if (!completed.response?.name) {
    throw new Error("Corpus creation completed without a corpus name.");
  }

  return completed.response;
}

async function findCorpusByDisplayName(config, verbose = false) {
  const response = await vertexRequest({
    path: `/projects/${config.projectId}/locations/${config.location}/ragCorpora`,
    method: "GET",
  });

  const corpus = (response.ragCorpora ?? []).find(
    (item) => item.displayName === config.corpusDisplayName,
  );

  if (verbose && corpus) {
    console.log(`Found existing corpus for display name ${config.corpusDisplayName}`);
  }

  return corpus?.name;
}

async function waitForOperation(operationName) {
  for (;;) {
    const operation = await vertexRequest({
      path: `/${operationName}`,
      method: "GET",
    });

    if (operation.done) {
      if (operation.error) {
        throw new Error(
          `Vertex operation failed: ${operation.error.message || JSON.stringify(operation.error)}`,
        );
      }
      return operation;
    }

    await sleep(2000);
  }
}

async function vertexRequest({ path, method, body }) {
  const token = await getAccessToken();
  const endpoint = getServiceEndpoint();
  const response = await fetch(`${endpoint}/v1${path}`, {
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

function getServiceEndpoint() {
  const location = process.env.VERTEX_RAG_LOCATION || DEFAULT_LOCATION;
  return `https://${location}-aiplatform.googleapis.com`;
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

function getConfig() {
  return {
    projectId: process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID,
    location: process.env.VERTEX_RAG_LOCATION || DEFAULT_LOCATION,
    bucketUri: ensureTrailingSlash(
      process.env.VERTEX_RAG_BUCKET_URI || DEFAULT_BUCKET_URI,
    ),
    corpusDisplayName:
      process.env.VERTEX_RAG_CORPUS_DISPLAY_NAME || DEFAULT_CORPUS_DISPLAY_NAME,
    corpusDescription:
      process.env.VERTEX_RAG_CORPUS_DESCRIPTION || DEFAULT_CORPUS_DESCRIPTION,
    chunkSize: Number(process.env.VERTEX_RAG_CHUNK_SIZE) || DEFAULT_CHUNK_SIZE,
    chunkOverlap:
      Number(process.env.VERTEX_RAG_CHUNK_OVERLAP) || DEFAULT_CHUNK_OVERLAP,
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildImportResultSink(bucketUri) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${bucketUri}import-results/${timestamp}/`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
  console.log("Usage:");
  console.log("  npm run rag:setup");
  console.log('  npm run rag:retrieve -- "your query text"');
  console.log("");
  console.log("Environment variables:");
  console.log(`  GOOGLE_CLOUD_PROJECT (default: ${DEFAULT_PROJECT_ID})`);
  console.log(`  VERTEX_RAG_LOCATION (default: ${DEFAULT_LOCATION})`);
  console.log(`  VERTEX_RAG_BUCKET_URI (default: ${DEFAULT_BUCKET_URI})`);
  console.log(
    `  VERTEX_RAG_CORPUS_DISPLAY_NAME (default: ${DEFAULT_CORPUS_DISPLAY_NAME})`,
  );
}
