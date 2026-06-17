import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import spawn from "cross-spawn";
import * as fs from "fs";
import * as path from "path";
import { Readable, Writable } from "stream";
import { TextEditor } from "atom";
import * as acp from "@agentclientprotocol/sdk";
import { parseCommandLine, TerminalRecord } from "./util";

declare const __PULSAR_ACP_AGENT_VERSION__: string;

const PROTOCOL_VERSION = acp.PROTOCOL_VERSION;
const STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTE_LIMIT = 64 * 1024;
const MAX_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const CLIENT_INFO = {
  name: "pulsar-acp-agent",
  title: "Pulsar ACP Agent",
  version: __PULSAR_ACP_AGENT_VERSION__,
};

export type AgentEvent =
  | { type: "status"; text: string }
  | {
      type: "initialized";
      info: acp.Implementation | null;
      capabilities: acp.AgentCapabilities | null;
      authMethods: acp.AuthMethod[];
      supportsImages: boolean;
    }
  | { type: "ready"; source: "start" | "new" | "load" }
  | { type: "session-list"; sessions: acp.SessionInfo[] }
  | { type: "turn-start" }
  | { type: "turn-end"; stopReason?: acp.StopReason }
  | { type: "update"; sessionId: acp.SessionId; update: acp.SessionUpdate }
  | {
      type: "permission";
      params: acp.RequestPermissionRequest;
      respond: (outcome: acp.RequestPermissionResponse) => void;
    }
  | { type: "file-written"; path: string }
  | { type: "terminal-output"; terminalId: string; output: string }
  | { type: "stderr"; text: string }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null; signal: string | null };

type Listener = (event: AgentEvent) => void;

interface TerminalAuthMeta {
  command?: string;
  args?: string[];
}

// Builds an Error carrying a JSON-RPC error code for the ACP transport.
function rpcError(message: string, code: number): Error {
  const error = new Error(message) as Error & { code?: number };
  error.code = code;
  return error;
}

// True when `target` is one of `roots` or nested beneath one of them.
function isInsideRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

export class AgentSession {
  private listeners = new Set<Listener>();
  private connection: acp.ClientSideConnection | null = null;
  private child: ChildProcess | null = null;
  sessionId: string | null = null;
  running = false;
  switching = false;
  private pendingSessionId: string | null = null;
  private sessionListGeneration = 0;
  private authMethods: acp.AuthMethod[] = [];
  private agentCapabilities: acp.AgentCapabilities | null = null;
  private promptCapabilities: acp.PromptCapabilities | null = null;
  private sessionCwd: string | null = null;
  private starting: Promise<void> | null = null;
  private permissionResolvers = new Set<
    (outcome: acp.RequestPermissionResponse) => void
  >();
  private terminals = new Map<string, TerminalRecord>();
  private loadedSessionIds = new Set<string>();

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
      this.cancelPendingPermissions();
      this.cleanupTerminals();
      this.loadedSessionIds.clear();
    }

    const commandLine: string =
      atom.config.get("pulsar-acp-agent.command") || "copilot --acp --stdio";
    const [command, ...args] = parseCommandLine(commandLine);
    if (!command) {
      const message =
        "No agent command configured. Set it in the Agent package settings.";
      this.emit({ type: "error", message });
      throw new Error(message);
    }
    const cwd = this.cwd();
    this.emit({ type: "status", text: `Starting ${command}\u2026` });

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill("SIGTERM");
      throw new Error("Failed to open stdio streams to the agent process.");
    }

    const processError = new Promise<never>((_, reject) => {
      child.once("error", (error: Error) => {
        if (this.child !== child) return;
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT"
            ? `Could not find "${command}". Install it and/or set its path in the Agent package settings.`
            : `Agent process error: ${error.message}`;
        this.cancelPendingPermissions();
        reject(new Error(message));
      });
    });
    // Prevent unhandled rejection crash if error fires after startup completes
    processError.catch(() => {});

    stderr.setEncoding("utf8");
    stderr.on("data", (text: string) =>
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
      this.switching = false;
      this.pendingSessionId = null;
      this.agentCapabilities = null;
      this.promptCapabilities = null;
      this.cancelPendingPermissions();
      this.cleanupTerminals();
      this.loadedSessionIds.clear();
      this.emit({ type: "exit", code, signal });
    });

    const toAgent = Writable.toWeb(stdin) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(
      stdout,
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
            terminal: true,
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
    this.agentCapabilities = init.agentCapabilities ?? null;
    this.promptCapabilities = init.agentCapabilities?.promptCapabilities ?? null;
    this.emit({
      type: "initialized",
      info: init.agentInfo ?? null,
      capabilities: this.agentCapabilities,
      authMethods: this.authMethods,
      supportsImages: this.promptCapabilities?.image === true,
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
    this.loadedSessionIds.add(session.sessionId);
    this.emit({ type: "ready", source: "start" });
    this.refreshSessionList();
  }

  private cwd(): string {
    const paths: string[] = atom.project.getPaths();
    if (paths && paths.length > 0) {
      const cwd = paths[0];
      if (path.isAbsolute(cwd)) return cwd;
      throw new Error(
        `Pulsar ACP Agent project folder must be an absolute path: ${cwd}`,
      );
    }
    throw new Error(
      "Open a project folder before starting the agent.",
    );
  }

  supportsImages(): boolean {
    return this.promptCapabilities?.image === true;
  }

  async prompt(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<acp.PromptResponse> {
    if (this.running) throw new Error("The agent is already responding.");
    this.running = true;
    try {
      await this.start();
      this.emit({ type: "turn-start" });
      if (!this.connection || !this.sessionId) {
        throw new Error("Agent session is not ready.");
      }
      const prompt: acp.ContentBlock[] = [{ type: "text", text }];
      if (images && images.length > 0) {
        if (!this.supportsImages())
          throw new Error("The configured agent does not support image prompts.");
        for (const img of images) {
          prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      }
      const result = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt,
      });
      // Clear `running` before emitting so listeners that re-render controls
      // (e.g. the "+ New" button) see the idle state. The finally is a safety net.
      this.running = false;
      this.emit({ type: "turn-end", stopReason: result?.stopReason });
      return result;
    } catch (error) {
      this.running = false;
      this.emit({ type: "turn-end" });
      throw error;
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
    this.cancelPendingPermissions();
  }

  private cancelPendingPermissions(): void {
    for (const resolve of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
  }

  private buildClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        const expectedId = this.pendingSessionId ?? this.sessionId;
        if (params.sessionId !== expectedId) return;
        this.emit({
          type: "update",
          sessionId: params.sessionId,
          update: params.update,
        });
      },
      requestPermission: async (params: acp.RequestPermissionRequest) =>
        this.requestPermission(params),
      readTextFile: async (params: acp.ReadTextFileRequest) =>
        this.readTextFile(params),
      writeTextFile: async (params: acp.WriteTextFileRequest) => {
        await this.writeTextFile(params);
        return {};
      },
      createTerminal: async (params: acp.CreateTerminalRequest) =>
        this.createTerminal(params),
      terminalOutput: async (params: acp.TerminalOutputRequest) =>
        this.terminalOutput(params),
      waitForTerminalExit: async (params: acp.WaitForTerminalExitRequest) =>
        this.waitForTerminalExit(params),
      killTerminal: async (params: acp.KillTerminalRequest) => {
        this.getTerminal(params.sessionId, params.terminalId).killProcess();
        return {};
      },
      releaseTerminal: async (params: acp.ReleaseTerminalRequest) => {
        this.releaseTerminal(params);
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

  private async createTerminal(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    this.assertSessionId(params.sessionId);
    const cwd = await this.terminalCwd(params.cwd);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    for (const item of params.env ?? []) env[item.name] = item.value;
    env.PAGER = "";
    env.GIT_PAGER = "cat";

    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const limit = Math.max(
      1,
      Math.min(
        params.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT,
        MAX_OUTPUT_BYTE_LIMIT,
      ),
    );
    const terminalId = randomUUID();
    const record = new TerminalRecord(child, limit, () =>
      this.emit({
        type: "terminal-output",
        terminalId,
        output: record.output(),
      }),
    );
    this.terminals.set(terminalId, record);

    child.stdout?.on("data", (chunk: Buffer) => record.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => record.append(chunk));
    child.on("error", (error: Error) => {
      record.append(Buffer.from(`\n[pulsar-acp-agent] ${error.message}\n`));
      record.resolveExit({ exitCode: null, signal: null });
      record.flushOutput();
    });
    child.on("exit", (code, signal) => {
      record.resolveExit({ exitCode: code, signal });
      record.flushOutput();
    });

    return { terminalId };
  }

  private terminalOutput(
    params: acp.TerminalOutputRequest,
  ): acp.TerminalOutputResponse {
    const record = this.getTerminal(params.sessionId, params.terminalId);
    return {
      output: record.output(),
      truncated: record.truncated,
      exitStatus: record.exitStatus,
    };
  }

  private async waitForTerminalExit(
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const record = this.getTerminal(params.sessionId, params.terminalId);
    const status = await record.waitForExit();
    return { exitCode: status.exitCode, signal: status.signal };
  }

  private releaseTerminal(params: acp.ReleaseTerminalRequest): void {
    const record = this.getTerminal(params.sessionId, params.terminalId);
    record.killProcess();
    record.releaseWaiters();
    this.terminals.delete(params.terminalId);
  }

  private getTerminal(
    sessionId: acp.SessionId,
    terminalId: string,
  ): TerminalRecord {
    this.assertSessionId(sessionId);
    const record = this.terminals.get(terminalId);
    if (!record) {
      throw rpcError(`Unknown terminal: ${terminalId}`, -32602);
    }
    return record;
  }

  private async terminalCwd(requested: string | null | undefined): Promise<string> {
    if (requested == null || requested.trim() === "") {
      if (!this.sessionCwd) {
        throw new Error("Agent session working directory is not ready.");
      }
      return this.sessionCwd;
    }
    if (!path.isAbsolute(requested)) {
      throw rpcError(
        `Terminal working directory must be an absolute path: ${requested}`,
        -32602,
      );
    }
    const real = await fs.promises.realpath(requested);
    const stat = await fs.promises.stat(real);
    const roots = await this.allowedRealRoots();
    if (!stat.isDirectory() || !isInsideRoots(real, roots)) {
      throw rpcError(
        `Refusing to launch a terminal outside the project: ${requested}`,
        -32002,
      );
    }
    return real;
  }

  private cleanupTerminals(): void {
    for (const record of this.terminals.values()) {
      record.killProcess();
      record.releaseWaiters();
    }
    this.terminals.clear();
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
      const lines = content.replace(/\r\n/g, "\n").split("\n");
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

  private assertSessionId(sessionId: acp.SessionId): void {
    if (this.sessionId === sessionId) return;
    throw rpcError(
      `Rejecting request for unknown ACP session: ${sessionId}`,
      -32002,
    );
  }

  private withStartupTimeout<T>(promise: Promise<T>, step: string): Promise<T> {
    let currentChild = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.child === currentChild && currentChild) currentChild.kill("SIGTERM");
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
    if (!path.isAbsolute(filePath)) {
      throw rpcError(
        `File system path must be an absolute path: ${filePath}`,
        -32602,
      );
    }
    const target = forWrite
      ? await this.realPathForWrite(filePath)
      : await fs.promises.realpath(filePath);
    const roots = await this.allowedRealRoots();
    if (!isInsideRoots(target, roots)) {
      throw rpcError(
        `Refusing to access path outside the project: ${filePath}`,
        -32002,
      );
    }
  }

  private async allowedRealRoots(cwd: string | null = this.sessionCwd): Promise<string[]> {
    if (!cwd) {
      throw new Error("Agent session working directory is not ready.");
    }
    const root = path.resolve(cwd);
    return [await fs.promises.realpath(root).catch(() => root)];
  }

  private async assertSessionCwdAllowed(
    cwd: string,
    action: "load" | "delete",
  ): Promise<void> {
    if (!path.isAbsolute(cwd)) {
      throw new Error(
        `Refusing to ${action} session with non-absolute working directory: ${cwd}`,
      );
    }
    const roots = await this.allowedRealRoots();
    const target = await fs.promises.realpath(cwd).catch(() => path.resolve(cwd));
    if (!isInsideRoots(target, roots)) {
      throw new Error(`Refusing to ${action} session outside the project: ${cwd}`);
    }
  }

  private async sessionInfoAllowed(
    info: acp.SessionInfo,
    roots: string[],
  ): Promise<boolean> {
    if (!path.isAbsolute(info.cwd)) return false;
    const target = await fs.promises.realpath(info.cwd).catch(() =>
      path.resolve(info.cwd),
    );
    return isInsideRoots(target, roots);
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
          if (next === parent || parent.length <= 3) {
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
      return itemPath != null && path.relative(path.resolve(itemPath), absolutePath) === "";
    });
  }

  canListSessions(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.list != null;
  }

  canLoadSession(): boolean {
    return this.agentCapabilities?.loadSession === true;
  }

  canDeleteSession(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.delete != null;
  }

  // True when the agent already has this session loaded in memory. The client
  // must re-activate such a session instead of calling `session/load` again,
  // which agents reject as already loaded.
  isSessionLoaded(id: string): boolean {
    return this.loadedSessionIds.has(id);
  }

  async deleteSession(
    id: string,
    cwd?: string,
  ): Promise<{ deletedActive: boolean }> {
    if (!this.connection) throw new Error("Agent is not connected.");
    if (!this.canDeleteSession()) throw new Error("The agent does not support deleting sessions.");
    if (this.running || this.switching) throw new Error("The agent is already responding.");

    this.switching = true;
    try {
      const deletedActive = id === this.sessionId;
      const scopedCwd = cwd ?? (deletedActive ? this.sessionCwd : null);
      if (!scopedCwd) {
        throw new Error(
          `Refusing to delete session without a known working directory: ${id}`,
        );
      }
      await this.assertSessionCwdAllowed(scopedCwd, "delete");
      await this.connection.deleteSession({ sessionId: id });
      this.loadedSessionIds.delete(id);
      if (deletedActive) {
        this.sessionId = null;
        this.cleanupTerminals();
      }
      this.refreshSessionList();
      return { deletedActive };
    } finally {
      this.switching = false;
    }
  }

  async newSession(): Promise<void> {
    if (!this.connection) throw new Error("Agent is not connected.");
    if (this.running || this.switching) throw new Error("The agent is already responding.");
    this.switching = true;
    try {
      const cwd = this.cwd();
      const session = await this.connection.newSession({ cwd, mcpServers: [] });
      this.sessionId = session.sessionId;
      this.sessionCwd = cwd;
      this.cleanupTerminals();
      this.loadedSessionIds.add(session.sessionId);
      this.switching = false;
      this.emit({ type: "ready", source: "new" });
      this.refreshSessionList();
    } finally {
      this.switching = false;
    }
  }

  activateCachedSession(id: string): void {
    this.sessionId = id;
    this.cleanupTerminals();
    this.emit({ type: "ready", source: "load" });
    this.refreshSessionList();
  }

  async loadSession(id: string, cwd?: string): Promise<void> {
    if (!this.connection) throw new Error("Agent is not connected.");
    if (this.running || this.switching) throw new Error("The agent is already responding.");
    if (!this.canLoadSession()) {
      throw new Error("The agent does not support loading sessions.");
    }
    this.switching = true;
    this.pendingSessionId = id;
    try {
      const sessionCwd = cwd ?? this.cwd();
      await this.assertSessionCwdAllowed(sessionCwd, "load");
      await this.connection.loadSession({
        sessionId: id,
        cwd: sessionCwd,
        mcpServers: [],
      });
      this.sessionId = id;
      this.pendingSessionId = null;
      this.sessionCwd = sessionCwd;
      this.cleanupTerminals();
      this.loadedSessionIds.add(id);
      this.switching = false;
      this.emit({ type: "ready", source: "load" });
      this.refreshSessionList();
    } catch (error) {
      this.pendingSessionId = null;
      throw error;
    } finally {
      this.switching = false;
    }
  }

  refreshSessionList(): void {
    if (!this.canListSessions()) return;
    this.listSessions().catch((error) => {
      console.error("[pulsar-acp-agent] session/list failed", error);
    });
  }

  async listSessions(): Promise<void> {
    if (!this.connection || !this.canListSessions()) return;
    const generation = ++this.sessionListGeneration;
    const cwd = this.sessionCwd ?? this.cwd();
    const roots = await this.allowedRealRoots(cwd);
    const sessions: acp.SessionInfo[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();
    do {
      const response = await this.connection.listSessions(
        cursor ? { cwd, cursor } : { cwd },
      );
      for (const session of response.sessions ?? []) {
        if (await this.sessionInfoAllowed(session, roots)) {
          sessions.push(session);
        }
      }
      const nextCursor = response.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (true);
    if (generation !== this.sessionListGeneration) return;
    this.emit({ type: "session-list", sessions });
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
      this.child = null;
    }
    this.sessionCwd = null;
    this.cleanupTerminals();
    this.listeners.clear();
  }
}
