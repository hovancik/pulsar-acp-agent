import { CompositeDisposable } from "atom";
import * as acp from "@agentclientprotocol/sdk";
import { AgentEvent, AgentSession } from "./agent-session";

export const PULSAR_ACP_AGENT_URI = "atom://pulsar-acp-agent";

type DockLocation = "left" | "right" | "bottom";

type ToolUpdate = Extract<
  acp.SessionUpdate,
  { sessionUpdate: "tool_call" | "tool_call_update" }
>;

type ToolView = {
  element: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
};

const STDERR_LIMIT = 4000;

export class PulsarAcpAgentView {
  element!: HTMLElement;
  private subscriptions: CompositeDisposable;
  private session: AgentSession;
  private eventSubscription!: { dispose: () => void };
  private toolViews = new Map<string, ToolView>();
  private terminalOutputs = new Map<string, string>();
  private planElement: HTMLElement | null = null;
  private stderrBody: HTMLElement | null = null;
  private streamRole: string | null = null;
  private streamMessageId: string | null = null;
  private streamBody: HTMLElement | null = null;

  private statusEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private conversation!: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private restartButton!: HTMLButtonElement;

  constructor() {
    this.subscriptions = new CompositeDisposable();
    this.session = new AgentSession();

    this.buildUI();
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);
    this.setStatus("Idle \u2014 type a message to start the agent.");
  }

  private buildUI(): void {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-acp-agent");

    const header = document.createElement("div");
    header.classList.add("pulsar-acp-agent-header");
    const title = document.createElement("span");
    title.classList.add("pulsar-acp-agent-title");
    title.textContent = "Pulsar ACP Agent";
    this.statusEl = document.createElement("span");
    this.statusEl.classList.add("pulsar-acp-agent-status");
    this.restartButton = this.makeButton("Restart", () => this.restart());
    this.restartButton.classList.add("pulsar-acp-agent-restart");
    header.appendChild(title);
    header.appendChild(this.statusEl);
    header.appendChild(this.restartButton);

    this.conversation = document.createElement("div");
    this.conversation.classList.add("pulsar-acp-agent-conversation");

    const footer = document.createElement("div");
    footer.classList.add("pulsar-acp-agent-footer");

    this.input = document.createElement("textarea");
    this.input.classList.add("pulsar-acp-agent-input", "native-key-bindings");
    this.input.setAttribute("rows", "3");
    this.input.setAttribute(
      "placeholder",
      "Ask the agent\u2026  (Enter to send, Shift+Enter for newline)",
    );
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });

    const actions = document.createElement("div");
    actions.classList.add("pulsar-acp-agent-actions");
    this.sendButton = this.makeButton("Send", () => this.send());
    this.sendButton.classList.add("pulsar-acp-agent-send");
    this.stopButton = this.makeButton("Stop", () => this.session.cancel());
    this.stopButton.classList.add("pulsar-acp-agent-stop");
    this.stopButton.disabled = true;
    actions.appendChild(this.stopButton);
    actions.appendChild(this.sendButton);

    footer.appendChild(this.input);
    footer.appendChild(actions);

    this.element.appendChild(header);
    this.element.appendChild(this.conversation);
    this.element.appendChild(footer);
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.classList.add("btn");
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private send(): void {
    const text = this.input.value.trim();
    if (text.length === 0 || this.session.running) return;
    this.input.value = "";
    this.appendMessage("user", text);
    this.endStreamingBlocks();
    this.sendButton.disabled = true;
    const currentSession = this.session;
    this.session.prompt(text).catch((error) => {
      if (this.session !== currentSession) return;
      this.appendError(error.message || String(error));
      this.sendButton.disabled = false;
      this.stopButton.disabled = true;
    });
  }

  private restart(): void {
    this.subscriptions.remove(this.eventSubscription);
    this.session.dispose();
    this.session = new AgentSession();
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);
    this.conversation.innerHTML = "";
    this.toolViews.clear();
    this.terminalOutputs.clear();
    this.planElement = null;
    this.stderrBody = null;
    this.endStreamingBlocks();
    this.setStatus("Idle \u2014 type a message to start the agent.");
    this.stopButton.disabled = true;
    this.sendButton.disabled = false;
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "status":
        this.setStatus(event.text);
        break;
      case "initialized":
        if (event.info && event.info.name)
          this.setStatus(`Connected to ${event.info.title || event.info.name}`);
        break;
      case "turn-start":
        this.stopButton.disabled = false;
        this.sendButton.disabled = true;
        this.stderrBody = null;
        break;
      case "turn-end":
        this.stopButton.disabled = true;
        this.sendButton.disabled = false;
        this.endStreamingBlocks();
        if (event.stopReason && event.stopReason !== "end_turn") {
          this.appendNote(`Turn stopped: ${event.stopReason}`);
        }
        break;
      case "update":
        this.handleUpdate(event.update);
        break;
      case "permission":
        this.renderPermission(event.params, event.respond);
        break;
      case "file-written":
        this.appendNote(`Wrote ${event.path}`);
        break;
      case "terminal-output":
        this.handleTerminalOutput(event.terminalId, event.output);
        break;
      case "stderr":
        console.warn("[pulsar-acp-agent]", event.text);
        this.appendStderr(event.text);
        break;
      case "error":
        this.appendError(event.message);
        this.stopButton.disabled = true;
        this.sendButton.disabled = false;
        break;
      case "exit":
        this.setStatus(
          `Agent exited${event.code != null ? ` (code ${event.code})` : ""}. Press Restart.`,
        );
        this.stopButton.disabled = true;
        this.sendButton.disabled = false;
        this.endStreamingBlocks();
        break;
    }
  }

  private handleUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendChunk("agent", update.messageId, update.content);
        break;
      case "agent_thought_chunk":
        this.appendChunk("thought", update.messageId, update.content);
        break;
      case "user_message_chunk":
        this.appendChunk("user", update.messageId, update.content);
        break;
      case "tool_call":
      case "tool_call_update":
        this.renderToolCall(update);
        break;
      case "plan":
        this.renderPlan(update.entries || []);
        break;
      case "current_mode_update":
        this.setStatus(`Mode: ${update.currentModeId}`);
        break;
      case "usage_update":
        if (
          typeof update.used === "number" &&
          typeof update.size === "number"
        ) {
          this.setStatus(`Context: ${update.used} / ${update.size} tokens`);
        }
        break;
    }
  }

  private contentToText(content: acp.ContentBlock | null | undefined): string {
    if (!content) return "";
    switch (content.type) {
      case "text":
        return content.text || "";
      case "resource_link":
        return content.uri
          ? `[${content.name || content.uri}](${content.uri})`
          : content.name || "";
      case "resource":
        return "[resource]";
      case "image":
        return "[image]";
      case "audio":
        return "[audio]";
      default:
        return "";
    }
  }

  private appendChunk(
    role: string,
    messageId: acp.MessageId | null | undefined,
    content: acp.ContentBlock,
  ): void {
    const text = this.contentToText(content);
    if (!text) return;
    const streamMessageId = messageId ?? null;
    if (
      this.streamRole !== role ||
      this.streamMessageId !== streamMessageId ||
      !this.streamBody
    ) {
      this.streamBody = this.appendMessage(role, "");
      this.streamRole = role;
      this.streamMessageId = streamMessageId;
    }
    this.streamBody.textContent += text;
    this.scrollToBottom();
  }

  private endStreamingBlocks(): void {
    this.streamRole = null;
    this.streamMessageId = null;
    this.streamBody = null;
  }

  private appendMessage(role: string, text: string): HTMLElement {
    const message = document.createElement("div");
    message.classList.add(
      "pulsar-acp-agent-message",
      `pulsar-acp-agent-message--${role}`,
    );

    const label = document.createElement("div");
    label.classList.add("pulsar-acp-agent-message-role");
    const labels: Record<string, string> = {
      user: "You",
      agent: "Agent",
      thought: "Thinking",
      note: "Note",
    };
    label.textContent = labels[role] || role;

    const body = document.createElement("div");
    body.classList.add("pulsar-acp-agent-message-body");
    body.textContent = text;

    message.appendChild(label);
    message.appendChild(body);
    this.conversation.appendChild(message);
    this.scrollToBottom();
    return body;
  }

  private appendNote(text: string): void {
    this.appendMessage("note", text);
  }

  private appendError(text: string): void {
    const message = document.createElement("div");
    message.classList.add(
      "pulsar-acp-agent-message",
      "pulsar-acp-agent-message--error",
    );
    message.textContent = text;
    this.conversation.appendChild(message);
    this.scrollToBottom();
  }

  private appendStderr(text: string): void {
    if (!this.stderrBody) {
      this.stderrBody = this.appendMessage("note", "Agent stderr:\n");
    }
    const nextText = `${this.stderrBody.textContent}${text}`;
    this.stderrBody.textContent =
      nextText.length > STDERR_LIMIT
        ? `Agent stderr:\n…${nextText.slice(-STDERR_LIMIT)}`
        : nextText;
    this.scrollToBottom();
  }

  private renderToolCall(update: ToolUpdate): void {
    let tool = this.toolViews.get(update.toolCallId);
    if (!tool) {
      const element = document.createElement("div");
      element.classList.add("pulsar-acp-agent-tool");
      const heading = document.createElement("div");
      heading.classList.add("pulsar-acp-agent-tool-heading");
      const title = document.createElement("span");
      title.classList.add("pulsar-acp-agent-tool-title");
      const status = document.createElement("span");
      status.classList.add("pulsar-acp-agent-tool-status");
      heading.appendChild(status);
      heading.appendChild(title);
      const body = document.createElement("div");
      body.classList.add("pulsar-acp-agent-tool-body");
      element.appendChild(heading);
      element.appendChild(body);
      tool = { element, title, status, body };
      this.toolViews.set(update.toolCallId, tool);
      this.conversation.appendChild(element);
      this.endStreamingBlocks();
    }

    if (update.title) tool.title.textContent = update.title;
    if (update.kind) tool.element.dataset.kind = update.kind;
    if (update.status) {
      tool.element.dataset.status = update.status;
      const statuses: Record<string, string> = {
        pending: "\u25cb",
        in_progress: "\u25d0",
        completed: "\u25cf",
        failed: "\u2715",
      };
      tool.status.textContent = statuses[update.status] || "";
    }
    if (Array.isArray(update.content)) {
      tool.body.textContent = "";
      for (const item of update.content) {
        tool.body.appendChild(this.renderToolContent(item));
      }
    }
    this.scrollToBottom();
  }

  private renderToolContent(item: acp.ToolCallContent): HTMLElement {
    const node = document.createElement("div");
    if (item.type === "diff") {
      node.classList.add("pulsar-acp-agent-diff");
      this.renderDiff(node, item);
    } else if (item.type === "content") {
      node.textContent = this.contentToText(item.content);
    } else if (item.type === "terminal") {
      node.classList.add("pulsar-acp-agent-terminal");
      const pre = document.createElement("pre");
      pre.classList.add("pulsar-acp-agent-terminal-output");
      pre.dataset.terminalId = item.terminalId;
      pre.textContent = this.terminalOutputs.get(item.terminalId) ?? "";
      node.appendChild(pre);
    }
    return node;
  }

  private handleTerminalOutput(terminalId: string, output: string): void {
    this.terminalOutputs.set(terminalId, output);
    const elements = Array.from(
      this.conversation.querySelectorAll("pre.pulsar-acp-agent-terminal-output"),
    ).filter((el) => (el as HTMLElement).dataset.terminalId === terminalId);
    if (elements.length === 0) return;
    for (const element of elements) {
      element.textContent = output;
    }
    this.scrollToBottom();
  }

  private renderDiff(node: HTMLElement, diff: acp.Diff): void {
    this.appendDiffLine(node, "path", `--- ${diff.path}`);
    this.appendDiffLine(node, "path", `+++ ${diff.path}`);

    const oldLines = this.contentLines(diff.oldText ?? "");
    const newLines = this.contentLines(diff.newText);
    let prefixLength = 0;
    while (
      prefixLength < oldLines.length &&
      prefixLength < newLines.length &&
      oldLines[prefixLength] === newLines[prefixLength]
    ) {
      prefixLength++;
    }

    let oldSuffixStart = oldLines.length;
    let newSuffixStart = newLines.length;
    while (
      oldSuffixStart > prefixLength &&
      newSuffixStart > prefixLength &&
      oldLines[oldSuffixStart - 1] === newLines[newSuffixStart - 1]
    ) {
      oldSuffixStart--;
      newSuffixStart--;
    }

    const DIFF_CONTEXT = 3;
    const prefixStart = Math.max(0, prefixLength - DIFF_CONTEXT);
    if (prefixStart > 0) {
      this.appendDiffLine(node, "context", " \u2026");
    }
    for (const line of oldLines.slice(prefixStart, prefixLength)) {
      this.appendDiffLine(node, "context", ` ${line}`);
    }
    for (const line of oldLines.slice(prefixLength, oldSuffixStart)) {
      this.appendDiffLine(node, "removed", `-${line}`);
    }
    for (const line of newLines.slice(prefixLength, newSuffixStart)) {
      this.appendDiffLine(node, "added", `+${line}`);
    }
    const suffixEnd = Math.min(oldLines.length, oldSuffixStart + DIFF_CONTEXT);
    for (const line of oldLines.slice(oldSuffixStart, suffixEnd)) {
      this.appendDiffLine(node, "context", ` ${line}`);
    }
    if (suffixEnd < oldLines.length) {
      this.appendDiffLine(node, "context", " \u2026");
    }
  }

  private contentLines(text: string): string[] {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  private appendDiffLine(
    node: HTMLElement,
    kind: "path" | "context" | "added" | "removed",
    text: string,
  ): void {
    const line = document.createElement("div");
    line.classList.add(
      "pulsar-acp-agent-diff-line",
      `pulsar-acp-agent-diff-line--${kind}`,
    );
    line.textContent = text;
    node.appendChild(line);
  }

  private renderPlan(entries: acp.PlanEntry[]): void {
    if (!this.planElement) {
      this.planElement = document.createElement("div");
      this.planElement.classList.add("pulsar-acp-agent-plan");
    }
    this.planElement.innerHTML = "";
    const heading = document.createElement("div");
    heading.classList.add("pulsar-acp-agent-plan-heading");
    heading.textContent = "Plan";
    this.planElement.appendChild(heading);
    for (const entry of entries) {
      const row = document.createElement("div");
      row.classList.add("pulsar-acp-agent-plan-entry");
      row.dataset.status = entry.status;
      const marks: Record<string, string> = {
        pending: "\u25cb",
        in_progress: "\u25d0",
        completed: "\u2713",
      };
      const mark = marks[entry.status] || "\u25cb";
      row.textContent = `${mark} ${entry.content}`;
      this.planElement.appendChild(row);
    }
    if (!this.planElement.isConnected) {
      this.conversation.appendChild(this.planElement);
    }
    this.scrollToBottom();
  }

  private renderPermission(
    params: acp.RequestPermissionRequest,
    respond: (outcome: acp.RequestPermissionResponse) => void,
  ): void {
    const block = document.createElement("div");
    block.classList.add("pulsar-acp-agent-permission");

    const question = document.createElement("div");
    question.classList.add("pulsar-acp-agent-permission-question");
    const toolTitle =
      params.toolCall && params.toolCall.title
        ? params.toolCall.title
        : "an action";
    question.textContent = `Allow the agent to run: ${toolTitle}?`;
    block.appendChild(question);

    const buttons = document.createElement("div");
    buttons.classList.add("pulsar-acp-agent-permission-options");
    for (const option of params.options || []) {
      const button = this.makeButton(option.name, () => {
        respond({
          outcome: { outcome: "selected", optionId: option.optionId },
        });
        for (const child of Array.from(buttons.children))
          (child as HTMLButtonElement).disabled = true;
        block.dataset.resolved = option.optionId;
        question.textContent = `${option.name} \u2014 ${toolTitle}`;
      });
      if (option.kind && option.kind.startsWith("reject"))
        button.classList.add("pulsar-acp-agent-reject");
      buttons.appendChild(button);
    }
    block.appendChild(buttons);
    this.conversation.appendChild(block);
    this.scrollToBottom();
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private scrollToBottom(): void {
    const isAtBottom =
      this.conversation.scrollHeight - this.conversation.scrollTop <=
      this.conversation.clientHeight + 50;
    if (isAtBottom) {
      this.conversation.scrollTop = this.conversation.scrollHeight;
    }
  }

  getTitle(): string {
    return "Pulsar ACP Agent";
  }

  getURI(): string {
    return PULSAR_ACP_AGENT_URI;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  getIconName(): string {
    return "hubot";
  }

  getDefaultLocation(): DockLocation {
    return "right";
  }

  getAllowedLocations(): DockLocation[] {
    return ["right", "left", "bottom"];
  }

  getPreferredWidth(): number {
    return 400;
  }

  serialize(): { deserializer: string } {
    return { deserializer: "PulsarAcpAgentView" };
  }

  destroy(): void {
    this.subscriptions.dispose();
    this.session.dispose();
    if (this.element) this.element.remove();
  }
}
