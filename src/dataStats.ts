import { readdir } from "node:fs/promises";
import path from "node:path";

import { GoogleAuth } from "google-auth-library";

const DEFAULT_PROJECT_ID = "ai-tinkerer-hackathon";
const DEFAULT_LOCATION = "europe-west4";
const DEFAULT_DATASET = "feedback";
const DEFAULT_RAW_TABLE = "feedback_raw";
const DEFAULT_BEST_PRACTICES_BUCKET_URI =
  "gs://ai-tinkerer-hackathon-rag/best-practices/";
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const auth = new GoogleAuth({
  scopes: [GOOGLE_CLOUD_SCOPE],
});

export type AppStats = {
  bestPracticeDocCount: number | null;
  feedbackItemCount: number | null;
};

export async function getAppStats(): Promise<AppStats> {
  const [bestPracticeDocCount, feedbackItemCount] = await Promise.all([
    countBestPracticeDocs(),
    countFeedbackItems(),
  ]);

  return {
    bestPracticeDocCount,
    feedbackItemCount,
  };
}

async function countBestPracticeDocs(): Promise<number | null> {
  const gcsCount = await countBestPracticeDocsInGcs();
  if (gcsCount !== null) {
    return gcsCount;
  }

  return countBestPracticeDocsInLocalDir();
}

async function countBestPracticeDocsInGcs(): Promise<number | null> {
  const token = await getAccessToken();
  const { bucketName, prefix } = parseGsUri(
    process.env.VERTEX_RAG_BUCKET_URI || DEFAULT_BEST_PRACTICES_BUCKET_URI,
  );

  try {
    const objectNames = await listBucketObjects(bucketName, prefix, token);
    return objectNames.filter(
      (name) => name !== prefix && name.endsWith(".md"),
    ).length;
  } catch {
    return null;
  }
}

async function countBestPracticeDocsInLocalDir(): Promise<number | null> {
  const docsDir = path.join(process.cwd(), "data", "best-practices");
  try {
    const entries = await readdir(docsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .length;
  } catch {
    return null;
  }
}

async function countFeedbackItems(): Promise<number | null> {
  const config = getConfig();

  try {
    const token = await getAccessToken();
    const response = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${config.projectId}/queries`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `SELECT COUNT(*) AS feedback_count FROM \`${config.projectId}.${config.datasetId}.${config.rawTableId}\``,
          useLegacySql: false,
          location: config.location,
        }),
      },
    );

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as BigQueryQueryResponse) : {};

    if (!response.ok || payload.jobComplete === false) {
      return null;
    }

    const countValue = payload.rows?.[0]?.f?.[0]?.v;
    return typeof countValue === "string" ? Number(countValue) : null;
  } catch {
    return null;
  }
}

async function listBucketObjects(
  bucketName: string,
  prefix: string,
  token: string,
): Promise<string[]> {
  const names: string[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o`,
    );
    url.searchParams.set("prefix", prefix);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as GoogleCloudStorageListResponse) : {};

    if (!response.ok) {
      throw new Error(`Unable to list bucket objects: ${response.status}`);
    }

    for (const item of payload.items ?? []) {
      if (item.name) {
        names.push(item.name);
      }
    }

    pageToken = payload.nextPageToken;
  } while (pageToken);

  return names;
}

async function getAccessToken(): Promise<string> {
  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token =
    typeof accessTokenResponse === "string"
      ? accessTokenResponse
      : accessTokenResponse?.token;

  if (!token) {
    throw new Error("Unable to acquire Google credentials.");
  }

  return token;
}

function parseGsUri(uri: string) {
  const match = /^gs:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!match) {
    throw new Error(`Invalid GCS URI: ${uri}`);
  }

  const bucketName = match[1];
  const rawPrefix = match[2] || "";

  return {
    bucketName,
    prefix: rawPrefix && !rawPrefix.endsWith("/") ? `${rawPrefix}/` : rawPrefix,
  };
}

function getConfig() {
  return {
    projectId: process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID,
    location: process.env.BIGQUERY_LOCATION || DEFAULT_LOCATION,
    datasetId: process.env.FEEDBACK_DATASET || DEFAULT_DATASET,
    rawTableId: process.env.FEEDBACK_RAW_TABLE || DEFAULT_RAW_TABLE,
  };
}

type BigQueryQueryResponse = {
  jobComplete?: boolean;
  rows?: Array<{
    f?: Array<{
      v?: string;
    }>;
  }>;
};

type GoogleCloudStorageListResponse = {
  items?: Array<{
    name?: string;
  }>;
  nextPageToken?: string;
};
