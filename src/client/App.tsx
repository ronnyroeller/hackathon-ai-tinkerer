import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";

type TraceItem = {
  type: "tool_call" | "tool_result" | "message";
  title: string;
  details: string;
};

type TraceGroup = {
  key: string;
  type: TraceItem["type"];
  title: string;
  details: string[];
};

const DEMO_PROMPTS = [
  "Create me the best practice config.",
  "Suggest a taxonomy for this dataset.",
  "Check whether there is enough data for tagging.",
] as const;

const GCP_PROJECT_ID = "ai-tinkerer-hackathon";
const BIGQUERY_DATASET = "feedback";
const BIGQUERY_TABLE = "feedback_raw";

export function App() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const [question, setQuestion] = useState("Create me the best practice config.");
  const [stats, setStats] = useState<{
    bestPracticeDocCount: number | null;
    feedbackItemCount: number | null;
  }>({
    bestPracticeDocCount: null,
    feedbackItemCount: null,
  });
  const [output, setOutput] = useState<string>(
    "Ask for a best-practice config or a specific delivery plan.",
  );
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const response = await fetch("/api/stats");
        const payload = (await response.json()) as {
          bestPracticeDocCount?: number;
          feedbackItemCount?: number | null;
        };

        if (!response.ok || cancelled) {
          return;
        }

        setStats({
          bestPracticeDocCount: payload.bestPracticeDocCount ?? null,
          feedbackItemCount: payload.feedbackItemCount ?? null,
        });
      } catch {
        if (!cancelled) {
          setStats({
            bestPracticeDocCount: null,
            feedbackItemCount: null,
          });
        }
      }
    }

    void loadStats();

    return () => {
      cancelled = true;
      eventSourceRef.current?.close();
    };
  }, []);

  async function handleAskQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      setOutput("Please enter a question first.");
      return;
    }

    setIsLoading(true);
    setOutput("Loading...");
    setTrace([]);
    eventSourceRef.current?.close();

    const eventSource = new EventSource(
      `/api/agent/stream?prompt=${encodeURIComponent(trimmedQuestion)}`,
    );
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("trace", (event) => {
      const payload = parseEventData<TraceItem>(event);
      if (!payload) {
        return;
      }

      setTrace((currentTrace) => [...currentTrace, payload]);
    });

    eventSource.addEventListener("response", (event) => {
      const payload = parseEventData<{ response?: string }>(event);
      setOutput(payload?.response ?? "No response returned.");
    });

    eventSource.addEventListener("agent-error", (event) => {
      const payload = parseEventData<{
        error?: string;
        trace?: TraceItem[];
        debug?: string;
      }>(event);

      if (payload?.trace?.length) {
        setTrace(payload.trace);
      }

      setOutput(
        payload?.debug
          ? `Error: ${payload.error ?? "Request failed"}\n\n${payload.debug}`
          : `Error: ${payload?.error ?? "Request failed"}`,
      );
    });

    eventSource.addEventListener("done", () => {
      eventSource.close();
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
      }
      setIsLoading(false);
    });

    eventSource.onerror = () => {
      eventSource.close();
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
      }
      setIsLoading(false);
    };
  }

  return (
    <main className="shell">
      <section className="panel">
        <div className="badgeRow" aria-label="Stack badges">
          <span className="badge">Cloud Run</span>
          <span className="badge">Vertex RAG</span>
          <span className="badge">BigQuery MCP</span>
          <span className="badge">Live Agent Trace</span>
        </div>
        <h1>Config Magician Deluxe ✨</h1>
        <p className="intro">
          Turn best-practice guidance and raw feedback into a launch-ready AI
          delivery plan in one pass.
        </p>
        <section className="statsGrid">
          <a
            className="statCard statCardLink"
            href={getVertexConsoleUrl()}
            rel="noreferrer"
            target="_blank"
          >
            <span className="statLabel">Vertex Best-Practice Docs</span>
            <strong className="statValue">
              {formatStat(stats.bestPracticeDocCount)}
            </strong>
          </a>
          <a
            className="statCard statCardLink"
            href={getBigQueryConsoleUrl()}
            rel="noreferrer"
            target="_blank"
          >
            <span className="statLabel">BigQuery Feedback Items</span>
            <strong className="statValue">
              {formatStat(stats.feedbackItemCount)}
            </strong>
          </a>
        </section>
        <form className="questionForm" onSubmit={handleAskQuestion}>
          <div className="promptChips" role="list" aria-label="Demo prompts">
            {DEMO_PROMPTS.map((prompt) => (
              <button
                className="promptChip"
                key={prompt}
                onClick={() => setQuestion(prompt)}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>
          <label className="questionLabel" htmlFor="question">
            Your question
          </label>
          <textarea
            className="questionInput"
            id="question"
            onChange={(event) => setQuestion(event.target.value)}
            placeholder='Try: "Create me the best practice config."'
            rows={4}
            value={question}
          />
          <div className="actions">
            <button disabled={isLoading} type="submit">
              {isLoading ? "Thinking..." : "Create Delivery Plan"}
            </button>
          </div>
        </form>
        <section className="traceSection">
          <h2 className="traceTitle">Agent Trace</h2>
          {trace.length === 0 ? (
            <p className="traceEmpty">No trace yet.</p>
          ) : (
            <ol className="traceList">
              {groupTrace(trace).map((item, index) => (
                <li
                  className={`traceItem traceItem-${item.type}`}
                  key={`${item.key}-${index}`}
                >
                  <details className="traceDisclosure" open={index === 0}>
                    <summary className="traceItemTitle">{item.title}</summary>
                    <div className="traceItemDetailsGroup">
                      {item.details.map((detail, detailIndex) => (
                        <span className="traceItemDetails" key={detailIndex}>
                          {detail}
                        </span>
                      ))}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="output markdownOutput">
          <ReactMarkdown>{output}</ReactMarkdown>
        </section>
      </section>
    </main>
  );
}

function compactTraceTitle(title: string): string {
  const normalized = title
    .replace("Tool call: ", "")
    .replace("Tool result: ", "")
    .replaceAll("_", " ");

  switch (normalized) {
    case "execute sql":
      return "Query BigQuery";
    case "get table info":
      return "Inspect BigQuery Table";
    case "get dataset info":
      return "Inspect BigQuery Dataset";
    case "list table ids":
      return "List BigQuery Tables";
    case "list dataset ids":
      return "List BigQuery Datasets";
    case "search best practices":
      return "Search Best Practices";
    case "planning":
      return "Plan Analysis";
    case "synthesis":
      return "Write Delivery Plan";
    default:
      return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

function parseEventData<T>(event: Event): T | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    return null;
  }

  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

function groupTrace(trace: TraceItem[]): TraceGroup[] {
  const groups: TraceGroup[] = [];

  for (const item of trace) {
    const title = compactTraceTitle(item.title);
    const lastGroup = groups.at(-1);

    if (lastGroup && lastGroup.title === title) {
      lastGroup.details.push(item.details);
      if (item.type === "tool_result") {
        lastGroup.type = "tool_result";
      }
      continue;
    }

    groups.push({
      key: `${item.type}:${title}`,
      type: item.type,
      title,
      details: [item.details],
    });
  }

  return groups;
}

function formatStat(value: number | null): string {
  if (value === null) {
    return "N/A";
  }

  return new Intl.NumberFormat().format(value);
}

function getVertexConsoleUrl(): string {
  return "https://console.cloud.google.com/storage/browser/ai-tinkerer-hackathon-rag/best-practices?pageState=(%22StorageObjectListTable%22:(%22f%22:%22%255B%255D%22))&authuser=1&project=ai-tinkerer-hackathon";
}

function getBigQueryConsoleUrl(): string {
  return `https://console.cloud.google.com/bigquery?project=${GCP_PROJECT_ID}&ws=!1m5!1m4!4m3!1s${GCP_PROJECT_ID}!2s${BIGQUERY_DATASET}!3s${BIGQUERY_TABLE}`;
}
