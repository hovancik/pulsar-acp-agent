#!/usr/bin/env node

const AUTH_REQUIRED = -32000;
const PROTOCOL_VERSION = 1;

const singleMethod = process.env.MOCK_AUTH_METHODS === "1";
const noAuth = process.env.MOCK_NO_AUTH === "1";

const authMethods = singleMethod
  ? [{ id: "mock-sso", name: "Mock SSO" }]
  : [
      { id: "mock-sso", name: "Mock SSO", description: "Sign in via the mock SSO flow" },
      { id: "mock-api-key", name: "Mock API Key", description: "Use a mock API key" },
    ];

let authenticated = noAuth;
let sessionCounter = 0;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        authMethods,
        agentInfo: { name: "Mock Agent", version: "0.0.0" },
        agentCapabilities: {
          promptCapabilities: { image: false },
        },
      });
      return;

    case "authenticate":
      authenticated = true;
      reply(id, {});
      return;

    case "session/new":
      if (!authenticated) {
        replyError(id, AUTH_REQUIRED, "Authentication required");
        return;
      }
      reply(id, { sessionId: `mock-session-${++sessionCounter}` });
      return;

    case "session/prompt": {
      const sessionId = params?.sessionId;
      const text =
        (params?.prompt ?? [])
          .filter((b) => b?.type === "text")
          .map((b) => b.text)
          .join(" ") || "(no text)";
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Mock agent received: ${text}` },
        },
      });
      reply(id, { stopReason: "end_turn" });
      return;
    }

    case "session/cancel":
      return;

    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`mock-agent parse error: ${err}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
