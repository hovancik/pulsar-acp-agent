import { CompositeDisposable } from "atom";
import * as acp from "@agentclientprotocol/sdk";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { AgentEvent, AgentSession } from "./agent-session";
import { flattenInfoRows } from "./util";

marked.setOptions({ breaks: true });

export const PULSAR_ACP_AGENT_URI = "atom://pulsar-acp-agent";

export type AgentStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "working"
  | "awaiting"
  | "error";

export interface AgentStatusReporter {
  report(
    view: PulsarAcpAgentView,
    status: AgentStatus,
    name: string | null,
  ): void;
  clear(view: PulsarAcpAgentView): void;
}

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
  toggle: HTMLButtonElement;
  expanded: boolean;
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
  private streamRawText = "";
  private streamRenderHandle: number | null = null;
  private stickToBottom = true;
  private lastUserScrollAt = 0;
  private pointerDownInConversation = false;
  private scrollBoundConversations = new WeakSet<HTMLElement>();

  private liveStatusEl!: HTMLElement;
  private agentNameEl!: HTMLButtonElement;
  private restartButton!: HTMLButtonElement;
  private infoPanel!: HTMLElement;
  private infoPanelOpen = false;
  private storedAgentInfo: acp.Implementation | null = null;
  private storedCapabilities: acp.AgentCapabilities | null = null;
  private currentMode: string | null = null;
  private currentTokens: string | null = null;
  private lifecycleStatus = "";
  private agentExited = false;
  private input!: HTMLTextAreaElement;
  private fileInput!: HTMLInputElement;
  private attachButton!: HTMLButtonElement;
  private thumbnailStrip!: HTMLElement;
  private conversation!: HTMLElement;
  private conversationWrapper!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private generatingIndicator: HTMLElement | null = null;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private newSessionButton!: HTMLButtonElement;
  private sessionsBar!: HTMLElement;
  private sessionsList!: HTMLElement;
  private sessionTooltips = new CompositeDisposable();
  private thumbnailTooltips = new CompositeDisposable();
  private sessionsToggle!: HTMLButtonElement;
  private sessionsListVisible = false;
  private knownSessions: acp.SessionInfo[] = [];
  private sessionConversationCache = new Map<string, HTMLElement>();
  private sessionLiveState = new Map<
    string,
    { mode: string | null; tokens: string | null }
  >();

  private pendingImages: PendingImage[] = [];
  private pendingImageLoads = 0;
  private imageLoadGeneration = 0;
  private nextImageId = 1;
  private preparingPrompt = false;
  private imageSupportKnown = false;
  private supportsImages = false;
  private startObserver: IntersectionObserver | null = null;
  private reporter: AgentStatusReporter | null;

  constructor(reporter: AgentStatusReporter | null = null) {
    this.reporter = reporter;
    this.subscriptions = new CompositeDisposable();
    this.session = new AgentSession();

    this.buildUI();
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);
    this.setLifecycleStatus("Idle \u2014 type a message to start the agent.");
    this.setAgentStatus("idle");

    // Start the agent only once the panel is actually shown. A dock restored
    // collapsed at editor startup should not spawn the agent until the user
    // opens it. ensureStarted() also runs on the first prompt as a fallback.
    this.observeStartOnVisible();
  }

  private observeStartOnVisible(): void {
    if (typeof IntersectionObserver === "undefined") {
      this.ensureStarted();
      return;
    }
    this.startObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.disconnectStartObserver();
        this.ensureStarted();
      }
    });
    this.startObserver.observe(this.element);
  }

  private disconnectStartObserver(): void {
    this.startObserver?.disconnect();
    this.startObserver = null;
  }

  private ensureStarted(): void {
    this.disconnectStartObserver();
    this.session.start().catch(() => {
      // Errors are surfaced via the event stream; suppress the unhandled rejection.
    });
  }

  private buildUI(): void {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-acp-agent");

    const header = document.createElement("div");
    header.classList.add("pulsar-acp-agent-header");

    const row1 = document.createElement("div");
    row1.classList.add("pulsar-acp-agent-header-row1");
    this.agentNameEl = document.createElement("button");
    this.agentNameEl.classList.add("pulsar-acp-agent-name");
    this.agentNameEl.setAttribute("aria-expanded", "false");
    this.agentNameEl.addEventListener("click", () => this.toggleInfoPanel());
    this.subscriptions.add(
      atom.tooltips.add(this.agentNameEl, {
        title: () =>
          this.storedAgentInfo != null || this.agentExited
            ? "Agent details"
            : "",
      }),
    );
    this.restartButton = this.makeButton("Restart", () => this.restart());
    this.restartButton.classList.add("pulsar-acp-agent-restart");
    this.subscriptions.add(
      atom.tooltips.add(this.restartButton, { title: "Restart agent" }),
    );
    row1.appendChild(this.agentNameEl);

    this.liveStatusEl = document.createElement("div");
    this.liveStatusEl.classList.add("pulsar-acp-agent-header-row2");

    header.appendChild(row1);
    header.appendChild(this.liveStatusEl);

    this.infoPanel = document.createElement("div");
    this.infoPanel.classList.add("pulsar-acp-agent-info-panel");
    this.infoPanel.style.display = "none";

    this.conversation = document.createElement("div");
    this.conversation.classList.add("pulsar-acp-agent-conversation");
    this.attachConversationScrollListener();

    // Wrap the conversation so the loading overlay can cover just this region
    // (not the header or footer) while history is replayed.
    this.conversationWrapper = document.createElement("div");
    this.conversationWrapper.classList.add("pulsar-acp-agent-conversation-wrapper");

    this.loadingOverlay = document.createElement("div");
    this.loadingOverlay.classList.add("pulsar-acp-agent-loading-overlay");
    this.loadingOverlay.style.display = "none";
    const loadingLabel = document.createElement("div");
    loadingLabel.classList.add("pulsar-acp-agent-loading-label");
    loadingLabel.textContent = "Loading session\u2026";
    this.loadingOverlay.appendChild(loadingLabel);

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
    this.attachButton.setAttribute("aria-label", "Attach image");
    this.subscriptions.add(
      atom.tooltips.add(this.attachButton, {
        title: "Attach image (or drag-and-drop / paste)",
      }),
    );
    this.attachButton.addEventListener("click", () => this.fileInput.click());
    this.sendButton = this.makeButton("Send", () => this.send());
    this.sendButton.classList.add("pulsar-acp-agent-send");
    this.stopButton = this.makeButton("Stop", () => {
      this.setGeneratingState("stopping");
      this.session.cancel();
    });
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
    this.element.appendChild(this.infoPanel);
    this.element.appendChild(this.buildSessionsBar());
    this.conversationWrapper.appendChild(this.conversation);
    this.conversationWrapper.appendChild(this.loadingOverlay);
    this.element.appendChild(this.conversationWrapper);
    this.element.appendChild(footer);
  }

  private buildSessionsBar(): HTMLElement {
    this.sessionsBar = document.createElement("div");
    this.sessionsBar.classList.add("pulsar-acp-agent-sessions-bar");
    this.sessionsBar.style.display = "none";

    const controls = document.createElement("div");
    controls.classList.add("pulsar-acp-agent-sessions-controls");

    this.sessionsToggle = document.createElement("button");
    this.sessionsToggle.classList.add("pulsar-acp-agent-sessions-toggle");
    this.sessionsToggle.textContent = "\u25b8 Sessions";
    this.sessionsToggle.setAttribute("aria-expanded", "false");
    this.sessionsToggle.addEventListener("click", () => {
      this.sessionsListVisible = !this.sessionsListVisible;
      this.sessionsList.style.display = this.sessionsListVisible ? "" : "none";
      this.sessionsToggle.setAttribute(
        "aria-expanded",
        String(this.sessionsListVisible),
      );
      this.sessionsToggle.textContent = `${this.sessionsListVisible ? "\u25be" : "\u25b8"} Sessions`;
    });

    this.newSessionButton = this.makeButton("+ New", () =>
      this.startNewSession(),
    );
    this.newSessionButton.classList.add(
      "pulsar-acp-agent-new-session",
      "btn-primary",
    );

    controls.appendChild(this.sessionsToggle);
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

  private toggleInfoPanel(): void {
    if (!this.storedAgentInfo && !this.agentExited) return;
    this.infoPanelOpen = !this.infoPanelOpen;
    if (this.infoPanelOpen) {
      this.renderInfoPanel();
      this.infoPanel.style.display = "";
    } else {
      this.infoPanel.style.display = "none";
    }
    this.agentNameEl.classList.toggle(
      "pulsar-acp-agent-name--active",
      this.infoPanelOpen,
    );
    this.agentNameEl.setAttribute("aria-expanded", String(this.infoPanelOpen));
  }

  // Identity disclosure. Lifecycle and turn state live in the status bar tile;
  // mode and token usage live in the separate live row.
  private renderPill(): void {
    const info = this.storedAgentInfo;
    const name = info ? info.title || info.name : null;
    this.agentNameEl.textContent = name || "Starting\u2026";
    this.agentNameEl.style.display = "";
    const hasPanel = info != null || this.agentExited;
    this.agentNameEl.disabled = !hasPanel;
    this.agentNameEl.classList.toggle(
      "pulsar-acp-agent-name--toggle",
      hasPanel,
    );
  }

  private renderInfoPanel(): void {
    this.infoPanel.innerHTML = "";
    const info = this.storedAgentInfo;
    const caps = this.storedCapabilities;

    const addRow = (label: string, content: HTMLElement | string): void => {
      const row = document.createElement("div");
      row.classList.add("pulsar-acp-agent-info-row");
      const lbl = document.createElement("span");
      lbl.classList.add("pulsar-acp-agent-info-label");
      lbl.textContent = label;
      row.appendChild(lbl);
      if (typeof content === "string") {
        const val = document.createElement("span");
        val.classList.add("pulsar-acp-agent-info-value");
        val.textContent = content;
        row.appendChild(val);
      } else {
        row.appendChild(content);
      }
      this.infoPanel.appendChild(row);
    };
    const infoTable = (value: unknown): HTMLElement | null => {
      const rows = flattenInfoRows(value);
      if (rows.length === 0) return null;
      const wrap = document.createElement("div");
      wrap.classList.add("pulsar-acp-agent-info-table");
      const table = document.createElement("table");
      const body = document.createElement("tbody");
      for (const item of rows) {
        const row = document.createElement("tr");
        const key = document.createElement("td");
        key.classList.add("pulsar-acp-agent-info-key");
        key.textContent = item.key;
        const val = document.createElement("td");
        val.classList.add("pulsar-acp-agent-info-table-value");
        val.textContent = item.value;
        row.appendChild(key);
        row.appendChild(val);
        body.appendChild(row);
      }
      table.appendChild(body);
      wrap.appendChild(table);
      return wrap;
    };

    // No identity yet (agent exited before initializing): still surface Restart
    // so a failed start is recoverable from the UI.
    if (!info) {
      const statusContent = document.createElement("div");
      statusContent.classList.add("pulsar-acp-agent-info-version");
      const statusValue = document.createElement("span");
      statusValue.classList.add("pulsar-acp-agent-info-value");
      statusValue.textContent = this.lifecycleStatus || "Not connected.";
      statusContent.appendChild(statusValue);
      statusContent.appendChild(this.restartButton);
      addRow("Status", statusContent);
      return;
    }

    const versionValue = document.createElement("span");
    versionValue.classList.add("pulsar-acp-agent-info-value");
    versionValue.textContent = info.version;
    const versionContent = document.createElement("div");
    versionContent.classList.add("pulsar-acp-agent-info-version");
    versionContent.appendChild(versionValue);
    versionContent.appendChild(this.restartButton);
    addRow("Version", versionContent);

    addRow("Capabilities", caps ? (infoTable(caps) ?? "none reported") : "none reported");

    const meta = info._meta;
    if (meta && Object.keys(meta).length > 0) {
      const table = infoTable(meta);
      if (table) addRow("Meta", table);
    }
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
        if (this.session === currentSession) {
          this.appendError(
            error instanceof Error ? error.message : String(error),
          );
          this.setAgentStatus("error");
        }
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
      this.setAgentStatus("error");
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
    this.resetAgentChrome();
    this.resetSessionsChrome();
    this.setLifecycleStatus("Idle \u2014 type a message to start the agent.");
    this.setAgentStatus("idle");
    this.renderLiveRow();
    this.stopButton.disabled = true;
    this.updateInputControls();

    // Restart is user-initiated on a visible panel, so reconnect immediately
    // rather than waiting for the panel to be shown again.
    this.ensureStarted();
  }

  private resetSessionsChrome(): void {
    this.sessionTooltips.dispose();
    this.sessionTooltips = new CompositeDisposable();
    this.sessionsBar.style.display = "none";
    this.sessionsList.innerHTML = "";
    this.sessionsList.style.display = "none";
    this.sessionsToggle.textContent = "\u25b8 Sessions";
    this.knownSessions = [];
    this.sessionsListVisible = false;
    this.sessionConversationCache.clear();
    this.sessionLiveState.clear();
  }

  private resetAgentChrome(): void {
    this.storedAgentInfo = null;
    this.storedCapabilities = null;
    this.currentMode = null;
    this.currentTokens = null;
    this.agentExited = false;
    this.renderLiveRow();
    this.renderPill();
    this.infoPanel.style.display = "none";
    this.infoPanel.innerHTML = "";
    this.infoPanelOpen = false;
    this.agentNameEl.classList.remove("pulsar-acp-agent-name--active");
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
    this.stickToBottom = true;
    this.generatingIndicator = null;
  }

  private startNewSession(): void {
    if (this.session.running || this.session.switching) return;
    // Cache the outgoing conversation: the agent keeps it loaded, so returning
    // to it must restore this DOM rather than re-load (which the agent rejects).
    const currentId = this.session.sessionId;
    if (currentId) {
      this.sessionConversationCache.set(currentId, this.conversation);
      this.swapInFreshConversation();
    }
    this.session.newSession().catch((error) => {
      // Roll back to the previous conversation if creating the session failed.
      if (currentId) {
        const prev = this.sessionConversationCache.get(currentId);
        if (prev) this.swapInConversation(prev);
      }
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  private switchToSession(id: string): void {
    if (this.session.running || this.session.switching) return;
    this.hideLoadingOverlay();
    const currentId = this.session.sessionId;
    const info = this.knownSessions.find((s) => s.sessionId === id);

    // Save current conversation DOM node (preserves canvas pixels etc.)
    if (currentId) {
      this.sessionConversationCache.set(currentId, this.conversation);
      this.swapInFreshConversation();
    }

    // If the agent already has this session loaded, re-activate it instead of
    // calling session/load again (agents reject loading an already-loaded
    // session). Restore the cached conversation DOM when we still have it.
    if (this.session.isSessionLoaded(id)) {
      this.resetConversationState();
      const cached = this.sessionConversationCache.get(id);
      if (cached !== undefined) this.swapInConversation(cached);
      this.session.activateCachedSession(id);
      return;
    }

    this.resetConversationState();
    // session/load replays history asynchronously; cover the blank pane with a
    // pulsing overlay until the "ready" event reveals the restored conversation.
    this.currentMode = null;
    this.currentTokens = null;
    this.setLifecycleStatus("Loading session\u2026");
    this.setAgentStatus("connecting");
    this.showLoadingOverlay();
    this.updateSessionControls();
    this.session.loadSession(id, info?.cwd).catch((error) => {
      // Roll back to the previous session's conversation on failure.
      this.hideLoadingOverlay();
      if (currentId) {
        const prev = this.sessionConversationCache.get(currentId);
        if (prev) this.swapInConversation(prev);
      }
      this.setLifecycleStatus("");
      this.setAgentStatus("ready");
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
    this.stickToBottom = true;
    this.attachConversationScrollListener();
  }

  private showLoadingOverlay(): void {
    this.loadingOverlay.style.display = "";
  }

  private hideLoadingOverlay(): void {
    this.loadingOverlay.style.display = "none";
  }

  private setGeneratingState(
    state: "working" | "awaiting" | "stopping" | null,
  ): void {
    if (state === null) {
      if (this.generatingIndicator) {
        this.generatingIndicator.remove();
        this.generatingIndicator = null;
      }
      return;
    }
    if (!this.generatingIndicator) {
      this.generatingIndicator = document.createElement("div");
      this.generatingIndicator.classList.add("pulsar-acp-agent-generating");
    }
    const labels: Record<"working" | "awaiting" | "stopping", string> = {
      working: "Working\u2026",
      awaiting: "Awaiting confirmation\u2026",
      stopping: "Stopping\u2026",
    };
    this.generatingIndicator.textContent = labels[state];
    this.conversation.appendChild(this.generatingIndicator);
    this.scrollToBottom();
  }

  private swapInConversation(el: HTMLElement): void {
    this.conversation.replaceWith(el);
    this.conversation = el;
    this.stickToBottom = true;
    this.attachConversationScrollListener();
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "status":
        this.setLifecycleStatus(event.text);
        this.setAgentStatus("connecting");
        break;
      case "initialized":
        this.storedAgentInfo = event.info;
        this.storedCapabilities = event.capabilities;
        if (event.info && this.infoPanelOpen) this.renderInfoPanel();
        this.setLifecycleStatus("Connected");
        this.setAgentStatus("connecting");
        this.imageSupportKnown = true;
        this.supportsImages = event.supportsImages;
        this.attachButton.style.display = event.supportsImages ? "" : "none";
        this.updateInputControls();
        break;
      case "ready":
        this.lifecycleStatus = "";
        this.hideLoadingOverlay();
        this.renderPill();
        this.setAgentStatus("ready");
        this.restoreLiveStateFor(this.session.sessionId);
        if (event.source === "new") {
          this.clearConversation();
        }
        if (event.source === "load") {
          this.endStreamingBlocks();
          this.stickToBottom = true;
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
        this.setAgentStatus("working");
        this.stopButton.disabled = false;
        this.setGeneratingState("working");
        this.updateInputControls();
        this.updateSessionControls();
        this.stderrBody = null;
        break;
      case "turn-end":
        this.setAgentStatus("ready");
        this.stopButton.disabled = true;
        this.setGeneratingState(null);
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
        this.hideLoadingOverlay();
        this.setGeneratingState(null);
        this.appendError(event.message);
        this.setAgentStatus("error");
        this.stopButton.disabled = true;
        this.updateInputControls();
        break;
      case "exit": {
        this.hideLoadingOverlay();
        this.setGeneratingState(null);
        const detail = `exited${event.code != null ? ` (code ${event.code})` : ""}`;
        this.agentExited = true;
        this.currentMode = null;
        this.currentTokens = null;
        this.renderLiveRow();
        this.setLifecycleStatus(`Agent ${detail}.`);
        this.setAgentStatus("error");
        // Auto-open details so Restart stays reachable even if the agent died
        // before reporting any identity (e.g. a bad agent command).
        this.infoPanelOpen = true;
        this.renderInfoPanel();
        this.infoPanel.style.display = "";
        this.agentNameEl.classList.add("pulsar-acp-agent-name--active");
        this.resetSessionsChrome();
        this.stopButton.disabled = true;
        this.updateInputControls();
        this.endStreamingBlocks();
        break;
      }
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
        this.currentMode = update.currentModeId || null;
        this.rememberLiveState(sessionId, "mode", this.currentMode);
        this.renderLiveRow();
        break;
      case "usage_update":
        if (
          typeof update.used === "number" &&
          typeof update.size === "number"
        ) {
          this.currentTokens = `${update.used}\u202f/\u202f${update.size} tokens`;
          this.rememberLiveState(sessionId, "tokens", this.currentTokens);
          this.renderLiveRow();
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
      this.endStreamingBlocks();
      this.streamBody = this.appendMessage(role, "");
      this.streamRole = role;
      this.streamMessageId = streamMessageId;
    }
    this.streamRawText += text;
    // ponytail: re-render the whole accumulated markdown, coalesced to one
    // render per frame so bursts of chunks don't reparse O(n) each.
    this.scheduleStreamRender();
    this.scrollToBottom();
  }

  private scheduleStreamRender(): void {
    if (this.streamRenderHandle !== null) return;
    this.streamRenderHandle = requestAnimationFrame(() => {
      this.streamRenderHandle = null;
      this.flushStreamRender();
    });
  }

  private flushStreamRender(): void {
    if (!this.streamBody) return;
    this.renderMarkdown(this.streamBody, this.streamRawText);
    this.scrollToBottom();
  }

  private endStreamingBlocks(): void {
    if (this.streamRenderHandle !== null) {
      cancelAnimationFrame(this.streamRenderHandle);
      this.streamRenderHandle = null;
    }
    if (this.streamBody && this.streamRawText) {
      this.renderMarkdown(this.streamBody, this.streamRawText);
      this.scrollToBottom();
    }
    this.streamRole = null;
    this.streamMessageId = null;
    this.streamBody = null;
    this.streamRawText = "";
  }

  // Renders Markdown into el. Agent and user content frequently relays
  // untrusted data (file contents, tool/web output, prompt-injection payloads),
  // so the generated HTML is sanitized with DOMPurify to strip scripts and
  // inline event handlers.
  private renderMarkdown(el: HTMLElement, text: string): void {
    const html = marked.parse(text, { async: false });
    el.innerHTML = DOMPurify.sanitize(html);
    el.classList.add("pulsar-acp-agent-markdown");
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
    this.renderMarkdown(body, text);
    for (const img of images) {
      body.appendChild(
        this.createImageCanvas(img.file, "pulsar-acp-agent-inline-image", () =>
          this.scrollToBottom(),
        ),
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
        const image = {
          id: this.nextImageId++,
          data: Buffer.from(reader.result).toString("base64"),
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
    remove.setAttribute("aria-label", "Remove image");
    const tip = atom.tooltips.add(remove, { title: "Remove image" });
    this.thumbnailTooltips.add(tip);
    remove.addEventListener("click", () => {
      tip.dispose();
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
    this.thumbnailTooltips.dispose();
    this.thumbnailTooltips = new CompositeDisposable();
    this.thumbnailStrip.innerHTML = "";
    this.thumbnailStrip.style.display = "none";
  }

  // ponytail: canvas, not <img src=blob:/data:>, to avoid the CodeQL
  // untrusted-URL-in-sink alert for user-selected images (see c29f767).
  // Don't "simplify" this back to an <img>.
  private createImageCanvas(
    file: File,
    className?: string,
    onResize?: () => void,
  ): HTMLCanvasElement {
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
        // The canvas grows from 0 height to the image height here, after the
        // message already scrolled. Re-scroll so autoscroll keeps following.
        onResize?.();
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
    this.scrollToBottom();
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
      const status = document.createElement("span");
      status.classList.add("pulsar-acp-agent-tool-status");
      const title = document.createElement("span");
      title.classList.add("pulsar-acp-agent-tool-title");
      heading.appendChild(status);
      heading.appendChild(title);
      const body = document.createElement("div");
      body.classList.add("pulsar-acp-agent-tool-body");
      const toggle = document.createElement("button");
      toggle.classList.add("pulsar-acp-agent-tool-toggle");
      toggle.style.display = "none";
      toggle.setAttribute("aria-expanded", "false");
      element.appendChild(heading);
      element.appendChild(body);
      element.appendChild(toggle);
      tool = { element, title, status, body, toggle, expanded: false };
      const view = tool;
      toggle.addEventListener("click", () => {
        view.expanded = !view.expanded;
        this.applyToolExpansion(view);
      });
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
      this.updateToolOverflow(tool);
    }
    this.scrollToBottom();
  }

  private applyToolExpansion(tool: ToolView): void {
    tool.body.classList.toggle(
      "pulsar-acp-agent-tool-body--expanded",
      tool.expanded,
    );
    tool.toggle.textContent = tool.expanded ? "Show less" : "Show more";
    tool.toggle.setAttribute("aria-expanded", String(tool.expanded));
    this.updateToolOverflow(tool);
    this.scrollToBottom();
  }

  private updateToolOverflow(tool: ToolView): void {
    // While expanded the cap is lifted, so keep the toggle visible to collapse.
    // While collapsed, only offer it when the body actually overflows the cap.
    const overflowing =
      tool.expanded || tool.body.scrollHeight > tool.body.clientHeight + 1;
    tool.toggle.style.display = overflowing ? "" : "none";
    if (!tool.expanded) tool.toggle.textContent = "Show more";
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
    for (const tool of this.toolViews.values()) {
      if (elements.some((el) => tool.body.contains(el))) {
        this.updateToolOverflow(tool);
      }
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
    const toolCall = params.toolCall;
    const toolTitle = toolCall?.title || "an action";

    this.setGeneratingState("awaiting");
    this.setAgentStatus("awaiting");

    const block = document.createElement("div");
    block.classList.add("pulsar-acp-agent-permission");
    if (toolCall?.kind) block.dataset.kind = toolCall.kind;

    const kindIcons: Record<string, string> = {
      read: "file-text",
      edit: "pencil",
      delete: "trashcan",
      move: "arrow-right",
      search: "search",
      execute: "terminal",
      think: "light-bulb",
      fetch: "cloud-download",
      switch_mode: "git-compare",
      other: "tools",
    };
    const iconName = toolCall?.kind ? (kindIcons[toolCall.kind] ?? "tools") : "tools";

    // Helper: build icon span + label text
    const makeLabel = (label: string): DocumentFragment => {
      const frag = document.createDocumentFragment();
      const iconEl = document.createElement("span");
      iconEl.classList.add("icon", `icon-${iconName}`);
      frag.appendChild(iconEl);
      frag.appendChild(document.createTextNode(` ${label}`));
      return frag;
    };

    // Header: kind icon + title
    const question = document.createElement("div");
    question.classList.add("pulsar-acp-agent-permission-question");
    question.appendChild(makeLabel(`Allow: ${toolTitle}?`));
    block.appendChild(question);

    // Affected locations
    if (toolCall?.locations && toolCall.locations.length > 0) {
      const locations = document.createElement("div");
      locations.classList.add("pulsar-acp-agent-permission-locations");
      for (const loc of toolCall.locations) {
        const entry = document.createElement("div");
        entry.classList.add("pulsar-acp-agent-permission-location");
        entry.textContent = loc.line != null ? `${loc.path}:${loc.line}` : loc.path;
        locations.appendChild(entry);
      }
      block.appendChild(locations);
    }

    // Tool content (diffs, text — not terminal, which has no output at permission time)
    if (toolCall?.content && toolCall.content.length > 0) {
      const contentEl = document.createElement("div");
      contentEl.classList.add("pulsar-acp-agent-permission-content");
      for (const item of toolCall.content) {
        if (item.type === "terminal") continue;
        contentEl.appendChild(this.renderToolContent(item));
      }
      if (contentEl.hasChildNodes()) block.appendChild(contentEl);
    }

    // Prominent command/URL extracted from rawInput
    if (toolCall?.rawInput != null && toolCall.kind != null) {
      const raw = toolCall.rawInput as Record<string, unknown>;
      const commands: string[] = [];
      if (toolCall.kind === "execute") {
        if (typeof raw["command"] === "string") {
          commands.push(raw["command"]);
        } else if (Array.isArray(raw["commands"])) {
          for (const c of raw["commands"])
            if (typeof c === "string") commands.push(c);
        }
      } else if (toolCall.kind === "fetch") {
        if (typeof raw["url"] === "string") commands.push(raw["url"]);
      }
      if (commands.length > 0) {
        const cmdEl = document.createElement("div");
        cmdEl.classList.add("pulsar-acp-agent-permission-commands");
        for (const cmd of commands) {
          const pre = document.createElement("pre");
          pre.textContent = cmd;
          cmdEl.appendChild(pre);
        }
        block.appendChild(cmdEl);
      }
    }

    // Collapsible raw input
    if (toolCall?.rawInput != null) {
      const details = document.createElement("details");
      details.classList.add("pulsar-acp-agent-permission-raw");
      const summary = document.createElement("summary");
      summary.textContent = "Raw input";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(toolCall.rawInput, null, 2);
      details.appendChild(summary);
      details.appendChild(pre);
      block.appendChild(details);
    }

    // Option buttons with kind-aware styling
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
        question.replaceChildren(makeLabel(`${option.name} \u2014 ${toolTitle}`));
        if (this.session.running) {
          this.setGeneratingState("working");
          this.setAgentStatus("working");
        }
      });
      button.dataset.optionKind = option.kind;
      if (option.kind === "reject_once" || option.kind === "reject_always")
        button.classList.add("pulsar-acp-agent-reject");
      if (option.kind === "allow_always")
        button.classList.add("pulsar-acp-agent-allow-always");
      buttons.appendChild(button);
    }
    block.appendChild(buttons);

    this.conversation.appendChild(block);
    this.scrollToBottom();
  }

  private renderSessionsList(sessions: acp.SessionInfo[]): void {
    this.knownSessions = sessions;
    this.sessionTooltips.dispose();
    this.sessionTooltips = new CompositeDisposable();
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
      this.sessionTooltips.add(
        atom.tooltips.add(titleEl, {
          title: info.title || info.sessionId,
          html: false,
          class: "pulsar-acp-agent-tooltip",
        }),
      );

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
        del.setAttribute("aria-label", "Delete session");
        this.sessionTooltips.add(
          atom.tooltips.add(del, { title: "Delete session" }),
        );
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
    const label = info?.title || id;
    atom.confirm(
      {
        type: "warning",
        message: "Delete this session?",
        detail: `"${label}" will be permanently removed. This cannot be undone.`,
        buttons: ["Delete", "Cancel"],
        defaultId: 1,
      },
      (response) => {
        if (response === 0) this.performDeleteSession(id, info?.cwd);
      },
    );
  }

  private performDeleteSession(id: string, cwd?: string): void {
    if (this.session.running || this.session.switching) return;
    const result = this.session.deleteSession(id, cwd);
    this.updateInputControls();
    this.updateSessionControls();
    result.then(({ deletedActive }) => {
      this.sessionConversationCache.delete(id);
      this.sessionLiveState.delete(id);
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

  private setLifecycleStatus(text: string): void {
    this.lifecycleStatus = text;
    this.renderPill();
  }

  private setAgentStatus(status: AgentStatus): void {
    this.reporter?.report(this, status, this.currentAgentName());
  }

  private currentAgentName(): string | null {
    const info = this.storedAgentInfo;
    return info ? info.title || info.name : null;
  }

  private renderLiveRow(): void {
    const parts = [this.currentMode, this.currentTokens].filter(
      (p): p is string => p != null && p.length > 0,
    );
    const text = parts.join(" \u00b7 ");
    this.liveStatusEl.textContent = text;
    this.liveStatusEl.style.display = text ? "" : "none";
  }

  // Mode and token usage are per-session; remember them so switching back to a
  // session restores its live row instead of showing a blank one.
  private rememberLiveState(
    sessionId: string,
    key: "mode" | "tokens",
    value: string | null,
  ): void {
    const state = this.sessionLiveState.get(sessionId) ?? {
      mode: null,
      tokens: null,
    };
    state[key] = value;
    this.sessionLiveState.set(sessionId, state);
  }

  private restoreLiveStateFor(sessionId: string | null): void {
    const state = sessionId ? this.sessionLiveState.get(sessionId) : undefined;
    this.currentMode = state?.mode ?? null;
    this.currentTokens = state?.tokens ?? null;
    this.renderLiveRow();
  }

  private attachConversationScrollListener(): void {
    // Cached conversations are re-swapped on session switch; bind each element
    // only once so listeners don't accumulate.
    if (this.scrollBoundConversations.has(this.conversation)) return;
    this.scrollBoundConversations.add(this.conversation);
    // Capture the element so each conversation's handlers reference their own
    // node rather than whichever conversation is currently active.
    const conversation = this.conversation;
    const markUser = () => {
      this.lastUserScrollAt = Date.now();
    };
    conversation.addEventListener("wheel", markUser, { passive: true });
    conversation.addEventListener("keydown", markUser);
    conversation.addEventListener("pointerdown", () => {
      this.pointerDownInConversation = true;
    });
    conversation.addEventListener("pointerup", () => {
      this.pointerDownInConversation = false;
    });

    // Only a user-driven scroll (wheel, keyboard, touch, or scrollbar drag)
    // unsticks autoscroll. Layout-induced scroll events — e.g. a late-loading
    // image canvas growing above the output — must not flip the flag, or the
    // view would freeze partway up. Reaching the bottom always re-sticks.
    conversation.addEventListener("scroll", () => {
      const distance =
        conversation.scrollHeight -
        conversation.scrollTop -
        conversation.clientHeight;
      if (distance <= 50) {
        this.stickToBottom = true;
      } else if (
        this.pointerDownInConversation ||
        Date.now() - this.lastUserScrollAt < 200
      ) {
        this.stickToBottom = false;
      }
    });
  }

  private scrollToBottom(): void {
    if (
      this.generatingIndicator &&
      this.conversation.lastElementChild !== this.generatingIndicator
    ) {
      this.conversation.appendChild(this.generatingIndicator);
    }
    if (!this.stickToBottom) return;
    this.conversation.scrollTop = this.conversation.scrollHeight;
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
    this.disconnectStartObserver();
    if (this.streamRenderHandle !== null) {
      cancelAnimationFrame(this.streamRenderHandle);
    }
    this.reporter?.clear(this);
    this.sessionTooltips.dispose();
    this.thumbnailTooltips.dispose();
    this.subscriptions.dispose();
    this.session.dispose();
    if (this.element) this.element.remove();
  }
}
