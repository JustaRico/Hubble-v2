/**
 * Hubble escalation tool (Phase 7).
 *
 * Registers `request_private_data(reason, data_requested)` on the model's
 * tool catalog via the `ctx.tools` seam, using the registry's plain object
 * shape (name/description/parameters/output/execute) — no build-time imports,
 * so the plugin file is fully self-contained inside any DSH deployment.
 *
 * The handler POSTs to the Escalation Plugin service (Phase 8) when present;
 * until then it returns a structured status so the contract is observable.
 */
const ESCALATION_URL = globalThis.process?.env?.HUBBLE_ESCALATION_URL
  ?? "http://host.docker.internal:8812/escalate";

const name = "hubble-escalation-tool";
const inject = ["tools"];

function apply(ctx) {
  ctx.tools.register({
    name: "request_private_data",
    description:
      "Request access to the user's private data when an answer genuinely requires it. " +
      "State a short reason and exactly which data you need. A privacy gate evaluates " +
      "the request before any data is released.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why this data is needed for the current answer.",
        },
        data_requested: {
          type: "string",
          description: "Which private data is requested (e.g. 'tomorrow's calendar events').",
        },
      },
      required: ["reason", "data_requested"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          detail: { type: "string" },
        },
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) {
      try {
        const res = await fetch(ESCALATION_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: String(args.reason),
            data_requested: String(args.data_requested),
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          return { status: "error", detail: `escalation endpoint HTTP ${res.status}` };
        }
        return await res.json();
      } catch (err) {
        // Escalation service unreachable: structured failure, never a throw.
        return { status: "unavailable", detail: String(err?.message ?? err) };
      }
    },
  });
}

export { apply, inject, name };
