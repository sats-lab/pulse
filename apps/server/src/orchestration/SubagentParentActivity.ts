import {
  EventId,
  type OrchestrationThreadActivity,
  type PulseSubagent,
  type OrchestrationEvent,
} from "@t3tools/contracts";

const terminal = new Set(["completed", "failed", "stopped", "interrupted"]);
type SubagentEvent = Pick<
  Omit<Extract<OrchestrationEvent, { type: `subagent.${string}` }>, "sequence">,
  "type" | "payload" | "occurredAt"
>;

export function subagentParentActivity(
  event: SubagentEvent,
  subagent: PulseSubagent,
): OrchestrationThreadActivity {
  if (event.type === "subagent.created") {
    return activity(event, subagent, "pending", "task.created", subagent.title);
  }
  let status: string;
  let kind = "task.updated";
  let summary = subagent.title;
  switch (event.type) {
    case "subagent.attached":
      status = "starting";
      break;
    case "subagent.started":
      status = "running";
      break;
    case "subagent.progressed":
      status = "running";
      kind = "task.progress";
      summary = "progress" in event.payload ? event.payload.progress : subagent.title;
      break;
    case "subagent.waited":
      status = "waiting";
      break;
    case "subagent.idled":
      status = "idle";
      break;
    case "subagent.stop-requested":
      status = "stop-requested";
      break;
    case "subagent.completed":
      status = "completed";
      break;
    case "subagent.failed":
      status = "failed";
      summary = "error" in event.payload ? event.payload.error : subagent.title;
      break;
    case "subagent.stopped":
      status = "stopped";
      break;
    case "subagent.interrupted":
      status = "interrupted";
      break;
  }
  if (terminal.has(status)) kind = `task.${status}`;
  return activity(event, subagent, status, kind, summary);
}

function activity(
  event: SubagentEvent,
  subagent: PulseSubagent,
  status: string,
  kind: string,
  summary: string,
): OrchestrationThreadActivity {
  const phase = terminal.has(status)
    ? "terminal"
    : status === "pending" || status === "starting"
      ? "start"
      : "progress";
  return {
    id: EventId.make(`pulse-subagent:${subagent.origin.threadId}:${subagent.id}:${phase}`),
    tone: status === "failed" ? "error" : "info",
    kind,
    summary,
    payload: {
      taskId: `pulse-subagent:${subagent.id}`,
      taskType: "subagent",
      agentKind: "agent",
      status,
      title: subagent.title,
      model: subagent.metadata.model,
      ...(subagent.effort !== undefined ? { effort: subagent.effort } : {}),
      timelineBypass: false,
      ...(event.type === "subagent.progressed" && "progress" in event.payload
        ? { progress: event.payload.progress }
        : {}),
      ...(event.type === "subagent.failed" && "error" in event.payload
        ? { error: event.payload.error }
        : {}),
    },
    turnId: subagent.origin.turnId,
    createdAt: event.occurredAt,
  };
}
