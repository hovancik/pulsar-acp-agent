import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Readable, Writable } from "stream";
import { TextEditor } from "atom";
import * as acp from "@agentclientprotocol/sdk";

export const PROTOCOL_VERSION = acp.PROTOCOL_VERSION;
const STARTUP_TIMEOUT_MS = 30_000;
const CLIENT_INFO = {
  name: "pulsar-acp-agent",
  title: "Pulsar ACP Agent",
  version: "0.1.0",
};

export type AgentEvent =
  | { type: "status"; text: string }
  | {
      type: "initialized";
      info: acp.Implementation | null;
      authMethods: acp.AuthMethod[];
    }
  | { type: "ready"; session: acp.NewSessionResponse }
  | { type: "turn-start" }
  | { type: "turn-end"; stopReason?: acp.StopReason }
  | { type: "update"; update: acp.SessionUpdate }
  | {
      type: "permission";
      params: acp.RequestPermissionRequest;
      respond: (outcome: acp.RequestPermissionResponse) => void;
    }
  | { type: "file-written"; path: string }
  | { type: "stderr"; text: string }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null; signal: string | null };

type Listener = (event: AgentEvent) => void;

interface ModelInfo {
  modelId: string;
  name: string;
}

interface SessionModelsExt {
  availableModels?: ModelInfo[];
  currentModelId?: string;
}

interface TerminalAuthMeta {
  command?: string;
  args?: string[];
}

export class AgentSession {
  private listeners = new Set<Listener>();
  private connection: acp.ClientSideConnection | null = null;
  private child: ChildProcess | null = null;
  sessionId: string | null = null;
  running = false;
  private authMethods: acp.AuthMethod[] = [];
  private sessionCwd: string | null = null;
  private starting: Promise<void> | null = null;
  private permissionResolvers = new Set<
    (outcome: acp.RequestPermissionResponse) => void
  >();

  onEvent(callback: Listener): { dispose: () => void } {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[pulsar-acp-agent] event listener failed", error);
      }
    }
  }

  isReady(): boolean {
    return this.sessionId != null;
  }

  start(): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this._start().catch((error) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async _start(): Promise<void> {
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {}
      this.child = null;
      this.connection = null;
      this.sessionCwd = null;
    }

    const command: string =
      atom.config.get("pulsar-acp-agent.command") || "copilot";
    const args: string[] = atom.config.get("pulsar-acp-agent.args") || [];
    const cwd = this.cwd();
    this.emit({ type: "status", text: `Starting ${command}\u2026` });

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const processError = new Promise<never>((_, reject) => {
      child.once("error", (error: Error) => {
        if (this.child !== child) return;
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT"
            ? `Could not find "${command}". Install it and/or set its path in the Agent package settings.`
            : `Agent process error: ${error.message}`;
        this.emit({ type: "error", message });
        reject(new Error(message));
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) =>
      this.emit({ type: "stderr", text }),
    );

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.connection = null;
      this.sessionId = null;
      this.sessionCwd = null;
      this.starting = null;
      this.running = false;
      this.emit({ type: "exit", code, signal });
    });

    const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(
      child.stdout,
    ) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toAgent, fromAgent);
    const connection = new acp.ClientSideConnection(
      () => this.buildClient(),
      stream,
    );
    this.connection = connection;

    const init = await this.withStartupTimeout(
      Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: CLIENT_INFO,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
        }),
        processError,
      ]),
      "initialize",
    );
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      child.kill("SIGTERM");
      throw new Error(
        `Unsupported ACP protocol version ${init.protocolVersion}; expected ${PROTOCOL_VERSION}.`,
      );
    }
    this.authMethods = init.authMethods || [];
    this.emit({
      type: "initialized",
      info: init.agentInfo ?? null,
      authMethods: this.authMethods,
    });

    if (this.authMethods.length > 0) {
      const method = this.authMethods[0];
      this.emit({
        type: "status",
        text: `Authenticating: ${method.name}\u2026`,
      });
      try {
        await this.withStartupTimeout(
          Promise.race([
            connection.authenticate({ methodId: method.id }),
            processError,
          ]),
          "authenticate",
        );
      } catch (authError) {
        throw new Error(this.loginHint(method, authError));
      }
    }

    let session: acp.NewSessionResponse;
    try {
      session = await this.withStartupTimeout(
        Promise.race([
          connection.newSession({ cwd, mcpServers: [] }),
          processError,
        ]),
        "session/new",
      );
    } catch (error) {
      const code = (error as { code?: number } | null)?.code;
      if (code === -32000 && this.authMethods.length > 0) {
        throw new Error(this.loginHint(this.authMethods[0], error));
      }
      throw error;
    }
    this.sessionId = session.sessionId;
    this.sessionCwd = cwd;
    this.emit({ type: "ready", session });
    this.emit({ type: "status", text: this.readyStatus(session) });
  }

  private cwd(): string {
    const override: string = atom.config.get("pulsar-acp-agent.cwd");
    if (override && override.trim()) {
      return this.assertAbsoluteCwd(
        override.trim(),
        "configured working directory",
      );
    }
    const paths: string[] = atom.project.getPaths();
    if (paths && paths.length > 0) {
      return this.assertAbsoluteCwd(paths[0], "project folder");
    }
    throw new Error(
      "Open a project folder or set Pulsar ACP Agent -> Working directory before starting the agent.",
    );
  }

  private assertAbsoluteCwd(cwd: string, source: string): string {
    if (path.isAbsolute(cwd)) return cwd;
    throw new Error(
      `Pulsar ACP Agent ${source} must be an absolute path: ${cwd}`,
    );
  }

  async prompt(text: string): Promise<acp.PromptResponse> {
    if (this.running) throw new Error("The agent is already responding.");
    this.running = true;
    this.emit({ type: "turn-start" });
    try {
      await this.start();
      if (!this.connection || !this.sessionId) {
        throw new Error("Agent session is not ready.");
      }
      const result = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.emit({ type: "turn-end", stopReason: result?.stopReason });
      return result;
    } finally {
      this.running = false;
    }
  }

  cancel(): void {
    if (this.connection && this.sessionId) {
      this.connection.cancel({ sessionId: this.sessionId }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "error",
          message: `Failed to cancel agent turn: ${message}`,
        });
      });
    } else if (this.child) {
      this.child.kill("SIGTERM");
      this.starting = null;
    }
    for (const resolve of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
  }

  private buildClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        this.emit({ type: "update", update: params.update });
      },
      requestPermission: async (params: acp.RequestPermissionRequest) =>
        this.requestPermission(params),
      readTextFile: async (params: acp.ReadTextFileRequest) =>
        this.readTextFile(params),
      writeTextFile: async (params: acp.WriteTextFileRequest) => {
        await this.writeTextFile(params);
        return {};
      },
    };
  }

  private requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    this.assertSessionId(params.sessionId);
    return new Promise((resolve) => {
      const respond = (outcome: acp.RequestPermissionResponse) => {
        this.permissionResolvers.delete(respond);
        resolve(outcome);
      };
      this.permissionResolvers.add(respond);
      this.emit({ type: "permission", params, respond });
    });
  }

  private async readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    this.assertSessionId(params.sessionId);
    await this.assertProjectPath(params.path, false);
    const editor = this.editorForPath(params.path);
    let content: string = editor
      ? editor.getText()
      : await fs.promises.readFile(params.path, "utf8");

    if (params.line != null || params.limit != null) {
      const lines = content.split("\n");
      const start = params.line != null ? Math.max(0, params.line - 1) : 0;
      const end = params.limit != null ? start + params.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  private async writeTextFile(params: acp.WriteTextFileRequest): Promise<void> {
    this.assertSessionId(params.sessionId);
    await this.assertProjectPath(params.path, true);
    const editor = this.editorForPath(params.path);
    if (editor) {
      if (editor.isModified()) {
        throw new Error(
          `Refusing to overwrite unsaved changes in ${params.path}`,
        );
      }
      editor.setText(params.content);
      await editor.save();
    } else {
      await fs.promises.mkdir(path.dirname(params.path), { recursive: true });
      await fs.promises.writeFile(params.path, params.content, "utf8");
    }
    this.emit({ type: "file-written", path: params.path });
  }

  private loginHint(method: acp.AuthMethod, error: unknown): string {
    const meta = method._meta?.["terminal-auth"] as TerminalAuthMeta | undefined;
    const command = meta?.command
      ? [meta.command, ...(meta.args ?? [])].join(" ")
      : "copilot login";
    const reason = error instanceof Error ? ` (${error.message})` : "";
    return `Sign-in required${reason}. Run \`${command}\` in a terminal, then press Restart.`;
  }

  private readyStatus(session: acp.NewSessionResponse): string {
    const models = (session as { models?: SessionModelsExt }).models;
    if (models && Array.isArray(models.availableModels)) {
      const current = models.availableModels.find(
        (m) => m.modelId === models.currentModelId,
      );
      if (current) return `Ready \u00b7 ${current.name}`;
    }
    return "Ready";
  }

  private assertSessionId(sessionId: acp.SessionId): void {
    if (this.sessionId === sessionId) return;
    const error = new Error(
      `Rejecting request for unknown ACP session: ${sessionId}`,
    ) as Error & { code?: number };
    error.code = -32002;
    throw error;
  }

  private withStartupTimeout<T>(promise: Promise<T>, step: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.child) this.child.kill("SIGTERM");
        reject(
          new Error(`Timed out during ${step}. Press Restart and try again.`),
        );
      }, STARTUP_TIMEOUT_MS);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async assertProjectPath(
    filePath: string,
    forWrite: boolean,
  ): Promise<void> {
    const target = forWrite
      ? await this.realPathForWrite(filePath)
      : await fs.promises.realpath(filePath);
    const roots = await this.allowedRealRoots();
    const isAllowed = roots.some(
      (root) => target === root || target.startsWith(root + path.sep),
    );
    if (!isAllowed) {
      const error = new Error(
        `Refusing to access path outside the project: ${filePath}`,
      ) as Error & { code?: number };
      error.code = -32002;
      throw error;
    }
  }

  private async allowedRealRoots(): Promise<string[]> {
    if (!this.sessionCwd) {
      throw new Error("Agent session working directory is not ready.");
    }
    const root = path.resolve(this.sessionCwd);
    return [await fs.promises.realpath(root).catch(() => root)];
  }

  private async realPathForWrite(filePath: string): Promise<string> {
    const target = path.resolve(filePath);
    try {
      return await fs.promises.realpath(target);
    } catch {
      let parent = path.dirname(target);
      while (true) {
        try {
          const realParent = await fs.promises.realpath(parent);
          return path.join(realParent, path.relative(parent, target));
        } catch {
          const next = path.dirname(parent);
          if (next === parent) {
            throw new Error(`Cannot resolve parent for ${filePath}`);
          }
          parent = next;
        }
      }
    }
  }

  private editorForPath(filePath: string): TextEditor | undefined {
    const absolutePath = path.resolve(filePath);
    return atom.workspace.getTextEditors().find((item) => {
      const itemPath = item.getPath();
      return itemPath != null && path.resolve(itemPath) === absolutePath;
    });
  }

  dispose(): void {
    try {
      this.cancel();
    } catch {}
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {}
      try {
        this.child.kill("SIGTERM");
      } catch {}
    }
    this.sessionCwd = null;
    this.listeners.clear();
  }
}
