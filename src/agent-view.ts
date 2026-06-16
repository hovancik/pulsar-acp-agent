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

type PendingImage = { id: number; data: string; mimeType: string; file: File };

const STDERR_LIMIT = 4000;

// Reject images above Zed's 5 MiB per-image cap; we don't downscale.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SUPPORTED_IMAGE_ACCEPT = Array.from(SUPPORTED_IMAGE_MIME_TYPES).join(",");
const SUPPORTED_IMAGE_LABEL = "PNG, JPEG, GIF, or WebP";

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
  private fileInput!: HTMLInputElement;
  private attachButton!: HTMLButtonElement;
  private thumbnailStrip!: HTMLElement;
  private conversation!: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private restartButton!: HTMLButtonElement;
  private newSessionButton!: HTMLButtonElement;
  private sessionsBar!: HTMLElement;
  private sessionsList!: HTMLElement;
  private sessionsListVisible = false;
  private knownSessions: acp.SessionInfo[] = [];
  private sessionConversationCache = new Map<string, HTMLElement>();

  private pendingImages: PendingImage[] = [];
  private pendingImageLoads = 0;
  private imageLoadGeneration = 0;
  private nextImageId = 1;
  private preparingPrompt = false;
  private imageSupportKnown = false;
  private supportsImages = false;

  constructor() {
    this.subscriptions = new CompositeDisposable();
    this.session = new AgentSession();

    this.buildUI();
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);
    this.setStatus("Idle \u2014 type a message to start the agent.");

    // Start the agent eagerly so the session list is available immediately.
    this.session.start().catch(() => {
      // Errors are surfaced via the event stream; suppress the unhandled rejection.
    });
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

    this.thumbnailStrip = document.createElement("div");
    this.thumbnailStrip.classList.add("pulsar-acp-agent-thumbnails");
    this.thumbnailStrip.style.display = "none";

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = SUPPORTED_IMAGE_ACCEPT;
    this.fileInput.multiple = true;
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", () => {
      if (this.fileInput.files) this.addImages(Array.from(this.fileInput.files));
      this.fileInput.value = "";
    });

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
    this.input.addEventListener("paste", (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items || !this.canAcceptImages()) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (this.isSupportedImageMimeType(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        event.preventDefault();
        this.addImages(imageFiles);
      }
    });

    footer.addEventListener("dragover", (event: DragEvent) => {
      if (!this.canAcceptImages()) return;
      const hasImage = Array.from(event.dataTransfer?.items ?? []).some((i) =>
        this.isSupportedImageMimeType(i.type),
      );
      if (!hasImage) return;
      event.preventDefault();
      footer.classList.add("pulsar-acp-agent-footer--drag-over");
    });
    footer.addEventListener("dragleave", () => {
      footer.classList.remove("pulsar-acp-agent-footer--drag-over");
    });
    footer.addEventListener("drop", (event: DragEvent) => {
      footer.classList.remove("pulsar-acp-agent-footer--drag-over");
      if (!this.canAcceptImages()) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
        this.isSupportedImageMimeType(f.type),
      );
      if (files.length > 0) this.addImages(files);
    });

    const actions = document.createElement("div");
    actions.classList.add("pulsar-acp-agent-actions");
    this.attachButton = document.createElement("button");
    this.attachButton.classList.add(
      "btn",
      "icon",
      "icon-file-media",
      "pulsar-acp-agent-attach",
    );
    this.attachButton.title = "Attach image (or drag-and-drop / paste)";
    this.attachButton.addEventListener("click", () => this.fileInput.click());
    this.sendButton = this.makeButton("Send", () => this.send());
    this.sendButton.classList.add("pulsar-acp-agent-send");
    this.stopButton = this.makeButton("Stop", () => this.session.cancel());
    this.stopButton.classList.add("pulsar-acp-agent-stop");
    this.stopButton.disabled = true;
    actions.appendChild(this.attachButton);
    actions.appendChild(this.stopButton);
    actions.appendChild(this.sendButton);

    footer.appendChild(this.fileInput);
    footer.appendChild(this.thumbnailStrip);
    footer.appendChild(this.input);
    footer.appendChild(actions);

    this.element.appendChild(header);
    this.element.appendChild(this.buildSessionsBar());
    this.element.appendChild(this.conversation);
    this.element.appendChild(footer);
  }

  private buildSessionsBar(): HTMLElement {
    this.sessionsBar = document.createElement("div");
    this.sessionsBar.classList.add("pulsar-acp-agent-sessions-bar");
    this.sessionsBar.style.display = "none";

    const controls = document.createElement("div");
    controls.classList.add("pulsar-acp-agent-sessions-controls");

    const toggle = document.createElement("button");
    toggle.classList.add("pulsar-acp-agent-sessions-toggle", "btn");
    toggle.textContent = "\u25b8 Sessions";
    toggle.addEventListener("click", () => {
      this.sessionsListVisible = !this.sessionsListVisible;
      this.sessionsList.style.display = this.sessionsListVisible ? "" : "none";
      toggle.textContent = `${this.sessionsListVisible ? "\u25be" : "\u25b8"} Sessions`;
    });

    this.newSessionButton = this.makeButton("+ New", () =>
      this.startNewSession(),
    );
    this.newSessionButton.classList.add("pulsar-acp-agent-new-session");

    controls.appendChild(toggle);
    controls.appendChild(this.newSessionButton);

    this.sessionsList = document.createElement("div");
    this.sessionsList.classList.add("pulsar-acp-agent-sessions-list");
    this.sessionsList.style.display = "none";

    this.sessionsBar.appendChild(controls);
    this.sessionsBar.appendChild(this.sessionsList);
    return this.sessionsBar;
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.classList.add("btn");
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private send(): void {
    void this.sendPrompt();
  }

  private async sendPrompt(): Promise<void> {
    const text = this.input.value.trim();
    if (
      (text.length === 0 && this.pendingImages.length === 0) ||
      this.session.running ||
      this.session.switching ||
      this.preparingPrompt ||
      this.pendingImageLoads > 0
    )
      return;

    const currentSession = this.session;
    if (this.pendingImages.length > 0) {
      this.preparingPrompt = true;
      this.updateInputControls();

      try {
        await this.session.start();
        if (this.session !== currentSession) return;
        if (!this.session.supportsImages()) {
          this.appendError(
            "The configured agent does not support image prompts; images were not sent.",
          );
          this.pendingImages = [];
          this.clearThumbnails();
          return;
        }
      } catch (error) {
        if (this.session === currentSession)
          this.appendError(
            error instanceof Error ? error.message : String(error),
          );
        return;
      } finally {
        if (this.session === currentSession) {
          this.preparingPrompt = false;
          this.updateInputControls();
        }
      }
    }

    const images = this.pendingImages.splice(0);
    this.input.value = "";
    this.clearThumbnails();
    this.appendUserMessage(text, images);
    this.endStreamingBlocks();
    this.sendButton.disabled = true;
    this.session.prompt(text, images).catch((error) => {
      if (this.session !== currentSession) return;
      this.appendError(error.message || String(error));
      this.stopButton.disabled = true;
      this.updateInputControls();
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
    this.clearConversation();
    this.imageSupportKnown = false;
    this.supportsImages = false;
    this.attachButton.style.display = "";
    this.sessionsBar.style.display = "none";
    this.sessionsList.innerHTML = "";
    this.knownSessions = [];
    this.sessionsListVisible = false;
    this.sessionConversationCache.clear();
    this.sessionsList.style.display = "none";
    this.setStatus("Idle \u2014 type a message to start the agent.");
    this.stopButton.disabled = true;
    this.updateInputControls();
  }

  private clearConversation(): void {
    this.conversation.innerHTML = "";
    this.resetConversationState();
  }

  private resetConversationState(): void {
    this.toolViews.clear();
    this.terminalOutputs.clear();
    this.planElement = null;
    this.stderrBody = null;
    this.pendingImages = [];
    this.pendingImageLoads = 0;
    this.imageLoadGeneration++;
    this.preparingPrompt = false;
    this.clearThumbnails();
    this.endStreamingBlocks();
  }

  private startNewSession(): void {
    if (this.session.running || this.session.switching) return;
    this.session.newSession().catch((error) => {
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  private switchToSession(id: string): void {
    if (this.session.running || this.session.switching) return;
    const currentId = this.session.sessionId;
    const info = this.knownSessions.find((s) => s.sessionId === id);

    // Save current conversation DOM node (preserves canvas pixels etc.)
    if (currentId) {
      this.sessionConversationCache.set(currentId, this.conversation);
      this.swapInFreshConversation();
    }

    const cached = this.sessionConversationCache.get(id);
    if (cached !== undefined) {
      this.resetConversationState();
      this.swapInConversation(cached);
      this.session.activateCachedSession(id);
      return;
    }

    this.resetConversationState();
    this.session.loadSession(id, info?.cwd).catch((error) => {
      // Roll back to the previous session's conversation on failure.
      if (currentId) {
        const prev = this.sessionConversationCache.get(currentId);
        if (prev) this.swapInConversation(prev);
      }
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  private swapInFreshConversation(): void {
    const fresh = document.createElement("div");
    fresh.className = this.conversation.className;
    this.conversation.replaceWith(fresh);
    this.conversation = fresh;
  }

  private swapInConversation(el: HTMLElement): void {
    this.conversation.replaceWith(el);
    this.conversation = el;
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "status":
        this.setStatus(event.text);
        break;
      case "initialized":
        if (event.info && event.info.name)
          this.setStatus(`Connected to ${event.info.title || event.info.name}`);
        this.imageSupportKnown = true;
        this.supportsImages = event.supportsImages;
        this.attachButton.style.display = event.supportsImages ? "" : "none";
        this.updateInputControls();
        break;
      case "ready":
        if (event.source === "new") {
          this.clearConversation();
        }
        if (event.source === "load") {
          this.conversation.scrollTop = this.conversation.scrollHeight;
        }
        this.sessionsBar.style.display = "";
        this.updateSessionControls();
        this.updateInputControls();
        break;
      case "session-list":
        this.renderSessionsList(event.sessions);
        break;
      case "turn-start":
        this.stopButton.disabled = false;
        this.updateInputControls();
        this.updateSessionControls();
        this.stderrBody = null;
        break;
      case "turn-end":
        this.stopButton.disabled = true;
        this.updateInputControls();
        this.updateSessionControls();
        this.endStreamingBlocks();
        if (event.stopReason && event.stopReason !== "end_turn") {
          this.appendNote(`Turn stopped: ${event.stopReason}`);
        }
        this.session.refreshSessionList();
        break;
      case "update":
        this.handleUpdate(event.sessionId, event.update);
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
        this.updateInputControls();
        break;
      case "exit":
        this.setStatus(
          `Agent exited${event.code != null ? ` (code ${event.code})` : ""}. Press Restart.`,
        );
        this.stopButton.disabled = true;
        this.updateInputControls();
        this.endStreamingBlocks();
        break;
    }
  }

  private handleUpdate(
    sessionId: acp.SessionId,
    update: acp.SessionUpdate,
  ): void {
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
      case "session_info_update":
        this.applySessionInfoUpdate(sessionId, update);
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

  private appendUserMessage(
    text: string,
    images: PendingImage[],
  ): void {
    const body = this.appendMessage("user", text);
    for (const img of images) {
      body.appendChild(
        this.createImageCanvas(img.file, "pulsar-acp-agent-inline-image"),
      );
    }
  }

  private addImages(files: File[]): void {
    if (!this.canAcceptImages()) return;
    for (const file of files) {
      if (!this.isSupportedImageMimeType(file.type)) {
        this.appendError(
          `"${file.name}" is not a supported image ` +
            `(${SUPPORTED_IMAGE_LABEL}) and was not attached.`,
        );
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        this.appendError(
          `"${file.name}" is larger than 5 MB and was not attached.`,
        );
        continue;
      }
      const generation = this.imageLoadGeneration;
      const reader = new FileReader();
      this.pendingImageLoads++;
      this.updateInputControls();
      reader.onload = () => {
        if (generation !== this.imageLoadGeneration) {
          return;
        }
        if (!(reader.result instanceof ArrayBuffer)) {
          this.appendError(`Could not read image "${file.name}".`);
          return;
        }
        const bytes = new Uint8Array(reader.result);
        let binary = "";
        for (let i = 0; i < bytes.length; i++)
          binary += String.fromCharCode(bytes[i]);
        const image = {
          id: this.nextImageId++,
          data: btoa(binary),
          mimeType: file.type,
          file,
        };
        this.pendingImages.push(image);
        this.renderThumbnail(image);
      };
      reader.onerror = () => {
        if (generation === this.imageLoadGeneration)
          this.appendError(`Could not read image "${file.name}".`);
      };
      reader.onloadend = () => {
        if (generation !== this.imageLoadGeneration) return;
        this.pendingImageLoads--;
        this.updateInputControls();
      };
      reader.readAsArrayBuffer(file);
    }
  }

  private renderThumbnail(image: PendingImage): void {
    this.thumbnailStrip.style.display = "";
    const wrapper = document.createElement("div");
    wrapper.classList.add("pulsar-acp-agent-thumbnail");
    const canvas = this.createImageCanvas(image.file);
    const remove = document.createElement("button");
    remove.classList.add("pulsar-acp-agent-thumbnail-remove");
    remove.textContent = "\u00d7";
    remove.title = "Remove image";
    remove.addEventListener("click", () => {
      const idx = this.pendingImages.findIndex((i) => i.id === image.id);
      if (idx >= 0) this.pendingImages.splice(idx, 1);
      wrapper.remove();
      if (this.thumbnailStrip.children.length === 0)
        this.thumbnailStrip.style.display = "none";
      this.updateInputControls();
    });
    wrapper.appendChild(canvas);
    wrapper.appendChild(remove);
    this.thumbnailStrip.appendChild(wrapper);
  }

  private clearThumbnails(): void {
    this.thumbnailStrip.innerHTML = "";
    this.thumbnailStrip.style.display = "none";
  }

  private createImageCanvas(file: File, className?: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    if (className) canvas.classList.add(className);
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", file.name || "Attached image");
    createImageBitmap(file)
      .then((bitmap) => {
        if (!canvas.isConnected) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) {
          bitmap.close();
          return;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch((error) =>
        console.warn("[pulsar-acp-agent] image preview failed", error),
      );
    return canvas;
  }

  private canAcceptImages(): boolean {
    return (
      !this.session.running &&
      !this.session.switching &&
      !this.preparingPrompt &&
      (!this.imageSupportKnown || this.supportsImages)
    );
  }

  private isSupportedImageMimeType(mimeType: string): boolean {
    return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
  }

  private updateInputControls(): void {
    const busy =
      this.session.running ||
      this.session.switching ||
      this.preparingPrompt;
    this.sendButton.disabled = busy || this.pendingImageLoads > 0;
    this.attachButton.disabled = busy || !this.canAcceptImages();
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

  private renderSessionsList(sessions: acp.SessionInfo[]): void {
    this.knownSessions = sessions;
    this.sessionsList.innerHTML = "";
    const canDelete = this.session.canDeleteSession();
    for (const info of sessions) {
      const row = document.createElement("div");
      row.classList.add("pulsar-acp-agent-session-row");
      row.dataset.sessionId = info.sessionId;

      const entry = document.createElement("button");
      entry.classList.add("pulsar-acp-agent-session-entry", "btn");
      if (info.sessionId === this.session.sessionId) {
        entry.classList.add("is-active");
      }
      entry.disabled =
        this.session.running ||
        this.session.switching ||
        !this.session.canLoadSession() ||
        info.sessionId === this.session.sessionId;

      const titleEl = document.createElement("span");
      titleEl.classList.add("pulsar-acp-agent-session-title");
      titleEl.textContent = info.title || info.sessionId;
      titleEl.title = info.title || info.sessionId;

      const timeEl = document.createElement("span");
      timeEl.classList.add("pulsar-acp-agent-session-time");
      timeEl.textContent = info.updatedAt ? this.relativeTime(info.updatedAt) : "";

      entry.appendChild(titleEl);
      entry.appendChild(timeEl);
      entry.addEventListener("click", () => {
        if (info.sessionId !== this.session.sessionId)
          this.switchToSession(info.sessionId);
      });
      row.appendChild(entry);

      if (canDelete) {
        const del = document.createElement("button");
        del.classList.add("pulsar-acp-agent-session-delete", "btn");
        del.title = "Delete session";
        del.textContent = "\u00d7";
        del.disabled = this.session.running || this.session.switching;
        del.addEventListener("click", () => this.deleteSession(info.sessionId));
        row.appendChild(del);
      }

      this.sessionsList.appendChild(row);
    }
  }

  private deleteSession(id: string): void {
    if (this.session.running || this.session.switching) return;
    const info = this.knownSessions.find((s) => s.sessionId === id);
    const result = this.session.deleteSession(id, info?.cwd);
    this.updateInputControls();
    this.updateSessionControls();
    result.then(({ deletedActive }) => {
      this.sessionConversationCache.delete(id);
      if (deletedActive) {
        this.clearConversation();
        this.startNewSession();
      } else {
        this.updateInputControls();
        this.updateSessionControls();
      }
    }).catch((error) => {
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  private applySessionInfoUpdate(
    sessionId: acp.SessionId,
    update: acp.SessionInfoUpdate,
  ): void {
    const index = this.knownSessions.findIndex(
      (session) => session.sessionId === sessionId,
    );
    if (index === -1) return;

    const nextSessions = this.knownSessions.slice();
    const nextInfo = { ...nextSessions[index] };
    if (update.title !== undefined) nextInfo.title = update.title;
    if (update.updatedAt !== undefined) nextInfo.updatedAt = update.updatedAt;
    nextSessions[index] = nextInfo;
    this.renderSessionsList(nextSessions);
    this.updateSessionControls();
  }

  private updateSessionControls(): void {
    const busy = this.session.running || this.session.switching;
    this.newSessionButton.disabled = busy;
    for (const row of Array.from(
      this.sessionsList.querySelectorAll<HTMLElement>(".pulsar-acp-agent-session-row"),
    )) {
      const id = row.dataset.sessionId;
      const entry = row.querySelector<HTMLButtonElement>(".pulsar-acp-agent-session-entry");
      const del = row.querySelector<HTMLButtonElement>(".pulsar-acp-agent-session-delete");
      if (entry) {
        const canLoad = this.session.canLoadSession() && id !== this.session.sessionId;
        entry.disabled = busy || !canLoad;
      }
      if (del) del.disabled = busy;
    }
  }

  private relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
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
