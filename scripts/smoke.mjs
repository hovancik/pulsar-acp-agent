import spawn from "cross-spawn";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as acp from "@agentclientprotocol/sdk";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const command = process.argv[2] || process.env.COPILOT_CLI_PATH || "copilot";
const rest = process.argv.slice(3);
const args = rest.length ? rest : ["--acp", "--stdio"];
const cwd = process.cwd();

class SmokeClient {
  async sessionUpdate(params) {
    const u = params.update;
    if (!u) return;
    if (
      u.sessionUpdate === "agent_message_chunk" &&
      u.content?.type === "text"
    ) {
      process.stdout.write(u.content.text);
    } else if (u.sessionUpdate === "tool_call") {
      console.log(`\n[tool_call] ${u.title} (${u.status})`);
    } else if (u.sessionUpdate === "tool_call_update") {
      console.log(`[tool_update] ${u.toolCallId} -> ${u.status || ""}`);
    } else if (u.sessionUpdate === "plan") {
      console.log(`[plan] ${(u.entries || []).length} entries`);
    }
  }

  async requestPermission(params) {
    const opts = params.options || [];
    const opt = opts.find((o) => o.kind === "allow_once") || opts[0];
    console.log(`\n[permission] ${params.toolCall?.title} -> ${opt?.optionId}`);
    return { outcome: { outcome: "selected", optionId: opt.optionId } };
  }

  async readTextFile(params) {
    return { content: fs.readFileSync(params.path, "utf8") };
  }

  async writeTextFile() {
    return {};
  }
}

async function main() {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const toAgent = Writable.toWeb(child.stdin);
  const fromAgent = Readable.toWeb(child.stdout);
  const stream = acp.ndJsonStream(toAgent, fromAgent);
  const connection = new acp.ClientSideConnection(
    () => new SmokeClient(),
    stream,
  );

  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: "pulsar-acp-agent-smoke",
      title: "Pulsar ACP Agent Smoke Test",
      version: pkg.version,
    },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  });
  if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ACP protocol version ${init.protocolVersion}; expected ${acp.PROTOCOL_VERSION}.`,
    );
  }
  console.log(
    "initialized:",
    init.agentInfo?.name,
    "| auth:",
    (init.authMethods || []).map((m) => m.id).join(",") || "(none)",
  );

  if (init.authMethods?.length) {
    await connection.authenticate({ methodId: init.authMethods[0].id });
    console.log("authenticated");
  }

  const session = await connection.newSession({ cwd, mcpServers: [] });
  console.log("session:", session.sessionId);

  console.log("--- prompt ---");
  const res = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: hello from acp" }],
  });
  console.log("\n--- stopReason:", res?.stopReason, "---");

  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
