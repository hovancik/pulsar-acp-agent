import { CompositeDisposable, Disposable } from "atom";
import * as acp from "@agentclientprotocol/sdk";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { AgentEvent, AgentSession, LaunchTarget } from "./agent-session";
import {
  AgentsConfig,
  isLaunchedAgentStale,
  migrateAgentsConfig,
  normalizeAgentsConfig,
  resolveActiveAgent,
} from "./agent-config";
import {
  completedPlanEntries,
  configOptionLabel,
  flattenConfigSelectOptions,
  flattenInfoRows,
  nextTurnActivePlanEntries,
} from "./util";

marked.setOptions({ breaks: true });

export const PULSAR_ACP_AGENT_URI = "atom://pulsar-acp-agent";

// Config glue. The agent registry lives under our namespace as three sibling
// keys (matching the legacy scalar settings already there); the pure
// agent-config module owns all the logic, this layer only reads/writes.
const CFG_NS = "pulsar-acp-agent";
const CFG_VERSION = "pulsar-acp-agent.version";
const CFG_ACTIVE = "pulsar-acp-agent.activeAgentId";
const CFG_AGENTS = "pulsar-acp-agent.agents";
const CFG_LEGACY_COMMAND = "pulsar-acp-agent.command";
let nextAgentMenuId = 1;

function rawAgentsConfig(): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const version = atom.config.get(CFG_VERSION);
  if (version !== undefined) raw.version = version;
  const activeAgentId = atom.config.get(CFG_ACTIVE);
  if (activeAgentId !== undefined) raw.activeAgentId = activeAgentId;
  const agents = atom.config.get(CFG_AGENTS);
  if (agents !== undefined) raw.agents = agents;
  return raw;
}

export function readAgentsConfig(): AgentsConfig {
  return normalizeAgentsConfig(rawAgentsConfig());
}

function writeAgentsConfig(config: AgentsConfig): void {
  atom.config.set(CFG_VERSION, config.version);
  atom.config.set(CFG_AGENTS, config.agents);
  if (config.activeAgentId) atom.config.set(CFG_ACTIVE, config.activeAgentId);
  else atom.config.unset(CFG_ACTIVE);
}

// Runs once in activate(): seed/migrate the registry and drop the superseded
// legacy `command` scalar. Persists only when something changed.
export function migrateAgentsConfigStore(): void {
  const legacy = atom.config.get(CFG_LEGACY_COMMAND);
  const { config, changed } = migrateAgentsConfig(
    rawAgentsConfig(),
    typeof legacy === "string" ? legacy : undefined,
  );
  if (changed) writeAgentsConfig(config);
  if (legacy !== undefined) atom.config.unset(CFG_LEGACY_COMMAND);
}

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

type SelectConfigOption = Extract<acp.SessionConfigOption, { type: "select" }>;

// In-flight lock key, scoped per session so an option set in one session can't
// disable the same-id option in another.
function configLockKey(sessionId: string | null, configId: string): string {
  return `${sessionId}\u0000${configId}`;
}

// A single dropdown for one session config option; re-rendered on each update to
// track the agent's authoritative option set.
class ConfigSelector {
  readonly element: HTMLElement;
  private button: HTMLButtonElement;
  private menu: HTMLElement;
  private tooltips = new CompositeDisposable();
  private menuVisible = false;

  constructor(
    private readonly onSelect: (configId: string, value: string) => void,
    private readonly disabled: () => boolean,
    private readonly closeSiblings: () => void,
  ) {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-acp-agent-config");

    this.menu = document.createElement("div");
    this.menu.classList.add("pulsar-acp-agent-config-menu");
    this.menu.setAttribute("role", "menu");
    this.menu.style.display = "none";

    this.button = document.createElement("button");
    this.button.classList.add("btn", "pulsar-acp-agent-config-trigger");
    this.button.setAttribute("aria-haspopup", "true");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMenu();
    });

    this.element.appendChild(this.menu);
    this.element.appendChild(this.button);
  }

  contains(node: Node): boolean {
    return this.element.contains(node);
  }

  focusButton(): void {
    this.button.focus();
  }

  get isOpen(): boolean {
    return this.menuVisible;
  }

  toggleMenu(): void {
    if (this.menuVisible) this.closeMenu();
    else this.openMenu();
  }

  openMenu(): void {
    if (this.button.disabled) return;
    this.closeSiblings();
    this.menuVisible = true;
    this.menu.style.display = "";
    this.button.setAttribute("aria-expanded", "true");
  }

  closeMenu(): void {
    if (!this.menuVisible) return;
    this.menuVisible = false;
    this.menu.style.display = "none";
    this.button.setAttribute("aria-expanded", "false");
  }

  updateDisabled(): void {
    this.button.disabled = this.disabled();
  }

  render(option: SelectConfigOption): void {
    this.button.textContent = configOptionLabel(option);

    this.menu.replaceChildren();
    this.tooltips.dispose();
    this.tooltips = new CompositeDisposable();

    if (option.description) {
      this.tooltips.add(
        atom.tooltips.add(this.button, {
          title: option.description,
          html: false,
          class: "pulsar-acp-agent-tooltip",
        }),
      );
    }

    for (const choice of flattenConfigSelectOptions(option.options)) {
      const item = document.createElement("button");
      item.classList.add("pulsar-acp-agent-config-item");
      item.setAttribute("role", "menuitemradio");
      const isActive = choice.value === option.currentValue;
      item.setAttribute("aria-checked", String(isActive));
      if (isActive) item.classList.add("is-active");

      const name = document.createElement("span");
      name.classList.add("pulsar-acp-agent-config-name");
      name.textContent = choice.name;
      item.appendChild(name);

      if (choice.description) {
        this.tooltips.add(
          atom.tooltips.add(item, {
            title: choice.description,
            html: false,
            class: "pulsar-acp-agent-tooltip",
          }),
        );
      }

      item.addEventListener("click", () => {
        this.closeMenu();
        this.onSelect(option.id, choice.value);
      });
      this.menu.appendChild(item);
    }

    this.updateDisabled();
  }

  dispose(): void {
    this.closeMenu();
    this.tooltips.dispose();
    this.element.remove();
  }
}

export class PulsarAcpAgentView {
  element!: HTMLElement;
  private subscriptions: CompositeDisposable;
  private session: AgentSession;
  private eventSubscription!: { dispose: () => void };
  private toolViews = new Map<string, ToolView>();
  private terminalOutputs = new Map<string, string>();
  private activePlanEntries: acp.PlanEntry[] = [];
  private activePlanSessionId: string | null = null;
  private planExpanded = false;
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

  private runtimeStatusEl!: HTMLElement;
  private liveStatusEl!: HTMLElement;
  private agentPicker!: HTMLButtonElement;
  private agentMenu!: HTMLElement;
  private readonly agentMenuId = `pulsar-acp-agent-picker-menu-${nextAgentMenuId++}`;
  private agentMenuOpen = false;
  private agentsConfig!: AgentsConfig;
  // The agent we last asked to launch (display snapshot + stale-detection id).
  private activeTarget: LaunchTarget | null = null;
  private infoButton!: HTMLButtonElement;
  private restartButton!: HTMLButtonElement;
  private infoPanel!: HTMLElement;
  private infoPanelOpen = false;
  private storedAgentInfo: acp.Implementation | null = null;
  private storedCapabilities: acp.AgentCapabilities | null = null;
  private currentTokens: string | null = null;
  private lifecycleStatus = "";
  private agentExited = false;
  private input!: HTMLTextAreaElement;
  private fileInput!: HTMLInputElement;
  private attachButton!: HTMLButtonElement;
  private thumbnailStrip!: HTMLElement;
  private conversation!: HTMLElement;
  private conversationWrapper!: HTMLElement;
  private planBar!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private scrollToBottomButton!: HTMLButtonElement;
  private generatingIndicator: HTMLElement | null = null;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private autoApproveButton!: HTMLButtonElement;
  private autoApprovePermissions = false;
  private newSessionButton!: HTMLButtonElement;
  private sessionsToggle!: HTMLButtonElement;
  private sessionsList!: HTMLElement;
  private sessionTooltips = new CompositeDisposable();
  private thumbnailTooltips = new CompositeDisposable();
  private sessionsListVisible = false;
  private knownSessions: acp.SessionInfo[] = [];
  private sessionConversationCache = new Map<string, HTMLElement>();
  private sessionLiveState = new Map<string, { tokens: string | null }>();
  private sessionPlanState = new Map<string, acp.PlanEntry[]>();
  private configSelectorsContainer!: HTMLElement;
  private configSelectors: ConfigSelector[] = [];
  private settingConfig = new Set<string>();

  private pendingImages: PendingImage[] = [];
  private pendingImageLoads = 0;
  private imageLoadGeneration = 0;
  private nextImageId = 1;
  private preparingPrompt = false;
  private imageSupportKnown = false;
  private supportsImages = false;
  private startObserver: IntersectionObserver | null = null;
  private startAttempted = false;
  private reporter: AgentStatusReporter | null;

  constructor(reporter: AgentStatusReporter | null = null) {
    this.reporter = reporter;
    this.subscriptions = new CompositeDisposable();
    this.agentsConfig = readAgentsConfig();
    this.session = new AgentSession();

    this.buildUI();
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);
    this.subscriptions.add(
      atom.config.onDidChange(CFG_NS, () => this.refreshFromConfig()),
    );
    this.renderAgentPicker();
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
    this.startAttempted = true;
    const target = this.resolveTarget();
    if (!target) {
      this.renderNoAgentIdle();
      return;
    }
    this.activeTarget = target;
    this.renderAgentPicker();
    this.startTarget(target);
  }

  private startTarget(target: LaunchTarget): void {
    this.disconnectStartObserver();
    const currentSession = this.session;
    this.session.start(target).catch((error) => {
      if (this.session !== currentSession) return;
      this.handleStartupError(error);
    });
  }

  // STRICT launch resolution from the latest config. Returns null when no agent
  // is launchable (caller shows a neutral idle state — never auto-guesses).
  private resolveTarget(): LaunchTarget | null {
    this.agentsConfig = readAgentsConfig();
    const resolved = resolveActiveAgent(this.agentsConfig);
    if (resolved.reason === "ok" && resolved.agent && resolved.id) {
      return {
        id: resolved.id,
        name: resolved.agent.name,
        command: resolved.agent.command,
      };
    }
    return null;
  }

  private renderNoAgentIdle(): void {
    const reason = resolveActiveAgent(this.agentsConfig).reason;
    this.setLifecycleStatus(
      reason === "no-agents"
        ? "No agents configured \u2014 use the agent picker to add one."
        : "No agent selected \u2014 pick one from the agent menu.",
    );
    this.setAgentStatus("idle");
    this.renderAgentPicker();
    this.updateInputControls();
  }

  private handleStartupError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.hideLoadingOverlay();
    this.setGeneratingState(null);
    this.appendError(message);
    this.agentExited = true;
    this.currentTokens = null;
    this.renderLiveRow();
    this.setLifecycleStatus("Startup failed.");
    this.setAgentStatus("error");
    this.openInfoPanel();
    this.resetSessionsChrome();
    this.stopButton.disabled = true;
    this.updateInputControls();
    this.endStreamingBlocks();
  }

  private buildUI(): void {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-acp-agent");
    // Focusable so a mouse selection focuses the panel and core:copy dispatches
    // from inside it (bubbling up to the handler), not from body. Matches
    // Markdown Preview.
    this.element.tabIndex = -1;

    const header = document.createElement("div");
    header.classList.add("pulsar-acp-agent-header");

    const row1 = document.createElement("div");
    row1.classList.add("pulsar-acp-agent-header-row1");

    const pickerWrap = document.createElement("div");
    pickerWrap.classList.add("pulsar-acp-agent-picker-wrap");
    this.agentPicker = document.createElement("button");
    this.agentPicker.classList.add("pulsar-acp-agent-picker");
    this.agentPicker.setAttribute("aria-haspopup", "menu");
    this.agentPicker.setAttribute("aria-controls", this.agentMenuId);
    this.agentPicker.setAttribute("aria-expanded", "false");
    this.agentPicker.addEventListener("click", () => this.toggleAgentMenu());
    this.subscriptions.add(
      atom.tooltips.add(this.agentPicker, {
        title: () =>
          isLaunchedAgentStale(this.agentsConfig, this.session.launchedAgent?.id)
            ? "This agent was removed from config; pick another to switch."
            : "Switch agent",
        placement: "right",
      }),
    );
    this.agentMenu = document.createElement("div");
    this.agentMenu.classList.add("pulsar-acp-agent-picker-menu");
    this.agentMenu.id = this.agentMenuId;
    this.agentMenu.setAttribute("role", "menu");
    this.agentMenu.setAttribute("aria-label", "Agents");
    this.agentMenu.style.display = "none";
    const onPickerKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.agentMenuOpen) {
        this.closeAgentMenu();
        this.agentPicker.focus();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!this.agentMenuOpen) this.openAgentMenu();
        this.focusAgentMenuItem("next");
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!this.agentMenuOpen) this.openAgentMenu();
        this.focusAgentMenuItem("previous");
        return;
      }
      if (event.key === "Home" && this.agentMenuOpen) {
        event.preventDefault();
        this.focusAgentMenuItem("first");
        return;
      }
      if (event.key === "End" && this.agentMenuOpen) {
        event.preventDefault();
        this.focusAgentMenuItem("last");
      }
    };
    this.agentPicker.addEventListener("keydown", onPickerKey);
    this.agentMenu.addEventListener("keydown", onPickerKey);
    pickerWrap.appendChild(this.agentPicker);
    pickerWrap.appendChild(this.agentMenu);
    // Close the menu when clicking anywhere outside the picker.
    const onDocMouseDown = (event: MouseEvent) => {
      if (this.agentMenuOpen && !pickerWrap.contains(event.target as Node)) {
        this.closeAgentMenu();
      }
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    this.subscriptions.add(
      new Disposable(() =>
        document.removeEventListener("mousedown", onDocMouseDown, true),
      ),
    );

    this.restartButton = this.makeButton("Restart", () => this.restart());
    this.restartButton.classList.add("pulsar-acp-agent-restart");
    this.subscriptions.add(
      atom.tooltips.add(this.restartButton, { title: "Restart agent" }),
    );
    row1.appendChild(pickerWrap);

    this.sessionsToggle = document.createElement("button");
    this.sessionsToggle.classList.add(
      "pulsar-acp-agent-sessions-toggle",
      "icon",
      "icon-history",
    );
    this.sessionsToggle.setAttribute("aria-label", "Sessions");
    this.sessionsToggle.setAttribute("aria-expanded", "false");
    this.sessionsToggle.style.display = "none";
    this.subscriptions.add(
      atom.tooltips.add(this.sessionsToggle, { title: "Sessions" }),
    );
    this.sessionsToggle.addEventListener("click", () => {
      this.sessionsListVisible = !this.sessionsListVisible;
      if (this.sessionsListVisible) {
        this.sessionsList.style.display = "";
        const delta = this.sessionsList.offsetHeight; // force reflow
        this.conversation.scrollTop += delta;
        const active = this.sessionsList.querySelector<HTMLElement>(".pulsar-acp-agent-session-row.is-active");
        active?.scrollIntoView({ block: "nearest" });
      } else {
        const delta = this.sessionsList.offsetHeight;
        const savedScrollTop = this.conversation.scrollTop;
        this.sessionsList.style.display = "none";
        void this.conversation.offsetHeight; // force reflow
        this.conversation.scrollTop = Math.max(0, savedScrollTop - delta);
      }
      this.sessionsToggle.setAttribute(
        "aria-expanded",
        String(this.sessionsListVisible),
      );
    });

    this.newSessionButton = document.createElement("button");
    this.newSessionButton.classList.add(
      "pulsar-acp-agent-new-session",
      "icon",
      "icon-plus",
    );
    this.newSessionButton.setAttribute("aria-label", "New session");
    this.newSessionButton.style.display = "none";
    this.subscriptions.add(
      atom.tooltips.add(this.newSessionButton, { title: "New session" }),
    );
    this.newSessionButton.addEventListener("click", () => this.startNewSession());

    this.sessionsList = document.createElement("div");
    this.sessionsList.classList.add("pulsar-acp-agent-sessions-list");
    this.sessionsList.style.display = "none";

    this.infoButton = document.createElement("button");
    this.infoButton.classList.add("pulsar-acp-agent-info-toggle");
    this.infoButton.textContent = "More\u2026";
    this.infoButton.setAttribute("aria-label", "Agent details");
    this.infoButton.setAttribute("aria-expanded", "false");
    this.infoButton.style.display = "none";
    this.infoButton.addEventListener("click", () =>
      this.setInfoPanelOpen(!this.infoPanelOpen),
    );
    this.subscriptions.add(
      atom.tooltips.add(this.infoButton, {
        title: "Show agent details and actions",
        placement: "bottom",
      }),
    );

    this.runtimeStatusEl = document.createElement("div");
    this.runtimeStatusEl.classList.add("pulsar-acp-agent-header-row2");
    this.liveStatusEl = document.createElement("span");
    this.liveStatusEl.classList.add("pulsar-acp-agent-token-usage");

    const rightGroup = document.createElement("div");
    rightGroup.classList.add("pulsar-acp-agent-header-right");
    rightGroup.appendChild(this.sessionsToggle);
    rightGroup.appendChild(this.newSessionButton);

    this.runtimeStatusEl.appendChild(this.infoButton);
    this.runtimeStatusEl.appendChild(this.liveStatusEl);

    row1.appendChild(rightGroup);
    header.appendChild(row1);
    header.appendChild(this.runtimeStatusEl);

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

    this.planBar = document.createElement("div");
    this.planBar.classList.add("pulsar-acp-agent-plan-bar");
    this.planBar.style.display = "none";

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
    this.attachButton.style.display = "none";
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
    this.autoApproveButton = document.createElement("button");
    this.autoApproveButton.classList.add(
      "btn",
      "pulsar-acp-agent-auto-approve",
    );
    this.autoApproveButton.textContent = "Permissions: Ask";
    this.autoApproveButton.setAttribute("aria-pressed", "false");
    this.autoApproveButton.addEventListener("click", () => {
      this.autoApprovePermissions = !this.autoApprovePermissions;
      this.updateAutoApproveButton();
    });
    this.subscriptions.add(
      atom.tooltips.add(this.autoApproveButton, {
        title:
          "Auto-approve permission prompts for this session using allow once.",
      }),
    );
    actions.appendChild(this.buildConfigSelectors());
    actions.appendChild(this.attachButton);
    actions.appendChild(this.autoApproveButton);
    actions.appendChild(this.stopButton);
    actions.appendChild(this.sendButton);

    footer.appendChild(this.fileInput);
    footer.appendChild(this.thumbnailStrip);
    footer.appendChild(this.input);
    footer.appendChild(actions);

    this.element.appendChild(header);
    this.element.appendChild(this.infoPanel);
    this.element.appendChild(this.sessionsList);
    this.conversationWrapper.appendChild(this.conversation);
    this.conversationWrapper.appendChild(this.loadingOverlay);

    this.scrollToBottomButton = document.createElement("button");
    this.scrollToBottomButton.classList.add(
      "pulsar-acp-agent-scroll-to-bottom",
      "icon",
      "icon-chevron-down",
    );
    this.scrollToBottomButton.textContent = "Scroll to bottom";
    this.scrollToBottomButton.setAttribute("aria-label", "Scroll to bottom");
    this.scrollToBottomButton.style.display = "none";
    this.scrollToBottomButton.addEventListener("click", () => {
      this.stickToBottom = true;
      this.updateScrollToBottomButton();
      this.scrollToBottom();
    });
    this.conversationWrapper.appendChild(this.scrollToBottomButton);

    this.element.appendChild(this.conversationWrapper);
    this.element.appendChild(this.planBar);
    this.element.appendChild(footer);
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.classList.add("btn");
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private buildConfigSelectors(): HTMLElement {
    const container = document.createElement("div");
    container.classList.add("pulsar-acp-agent-config-selectors");
    container.style.display = "none";
    this.configSelectorsContainer = container;

    const onDocClick = (event: MouseEvent) => {
      for (const selector of this.configSelectors) {
        if (selector.isOpen && !selector.contains(event.target as Node)) {
          selector.closeMenu();
        }
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const selector of this.configSelectors) {
        if (selector.isOpen) {
          selector.closeMenu();
          selector.focusButton();
        }
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    this.subscriptions.add({
      dispose: () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKeyDown);
      },
    });

    return container;
  }

  private closeAllConfigMenus(): void {
    for (const selector of this.configSelectors) selector.closeMenu();
  }

  private updateConfigSelectorsDisabled(): void {
    for (const selector of this.configSelectors) selector.updateDisabled();
  }

  private renderConfigSelectors(): void {
    const options = this.session.currentSessionConfigOptions();
    const selects = (options ?? []).filter(
      (o): o is SelectConfigOption => o.type === "select",
    );

    // Rebuild so the rendered selectors match the agent's current option list.
    for (const selector of this.configSelectors) selector.dispose();
    this.configSelectors = [];
    this.configSelectorsContainer.replaceChildren();

    if (selects.length === 0) {
      this.configSelectorsContainer.style.display = "none";
      return;
    }
    this.configSelectorsContainer.style.display = "";

    for (const option of selects) {
      const configId = option.id;
      const selector = new ConfigSelector(
        (id, value) => this.selectConfigOption(id, value),
        () =>
          this.session.switching ||
          this.settingConfig.has(
            configLockKey(this.session.sessionId, configId),
          ),
        () => this.closeAllConfigMenus(),
      );
      selector.render(option);
      this.configSelectors.push(selector);
      this.configSelectorsContainer.appendChild(selector.element);
    }
  }

  private selectConfigOption(configId: string, value: string): void {
    const options = this.session.currentSessionConfigOptions();
    const option = options?.find(
      (o): o is SelectConfigOption => o.id === configId && o.type === "select",
    );
    if (!option || option.currentValue === value) return;
    const sessionId = this.session.sessionId;
    const lockKey = configLockKey(sessionId, configId);
    if (this.session.switching || this.settingConfig.has(lockKey)) return;

    const previous = option.currentValue;
    // Optimistic update with revert on failure. Revert the captured option if
    // it still holds our value (even after a session switch); guard the error
    // and re-render on the active session so a switch or a concurrent
    // config_option_update can't desync the UI.
    option.currentValue = value;
    this.settingConfig.add(lockKey);
    this.renderConfigSelectors();
    this.session
      .setConfigOption(configId, value)
      .catch((error) => {
        if (option.currentValue === value) option.currentValue = previous;
        if (this.session.sessionId === sessionId) {
          this.appendError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        this.settingConfig.delete(lockKey);
        if (this.session.sessionId === sessionId) {
          this.renderConfigSelectors();
        } else {
          this.updateConfigSelectorsDisabled();
        }
      });
  }

  private updateAutoApproveButton(): void {
    this.autoApproveButton.setAttribute(
      "aria-pressed",
      String(this.autoApprovePermissions),
    );
    if (this.autoApprovePermissions) {
      this.autoApproveButton.textContent = "Permissions: Allow all";
      this.autoApproveButton.classList.add(
        "pulsar-acp-agent-auto-approve--on",
      );
    } else {
      this.autoApproveButton.textContent = "Permissions: Ask";
      this.autoApproveButton.classList.remove(
        "pulsar-acp-agent-auto-approve--on",
      );
    }
  }

  private openInfoPanel(): void {
    this.setInfoPanelOpen(true);
  }

  private setInfoPanelOpen(open: boolean): void {
    if (open && !this.storedAgentInfo && !this.agentExited) return;
    if (open === this.infoPanelOpen) {
      if (open) this.renderInfoPanel();
      return;
    }
    this.infoPanelOpen = open;
    if (open) {
      this.renderInfoPanel();
      this.infoPanel.style.display = "";
      // Reading offsetHeight forces a synchronous reflow so scrollTop correction
      // lands in the same frame — no visual jump.
      const delta = this.infoPanel.offsetHeight;
      this.conversation.scrollTop += delta;
    } else {
      // Capture both values before hiding so the browser can't clamp them first.
      const delta = this.infoPanel.offsetHeight;
      const savedScrollTop = this.conversation.scrollTop;
      this.infoPanel.style.display = "none";
      void this.conversation.offsetHeight; // force reflow
      this.conversation.scrollTop = Math.max(0, savedScrollTop - delta);
    }
    this.infoButton.setAttribute("aria-expanded", String(this.infoPanelOpen));
  }

  // Runtime identity disclosure. Turn state lives in the status bar tile; token
  // usage shares this live row when the agent reports it for the active session.
  private renderPill(): void {
    const info = this.storedAgentInfo;
    const hasPanel = info != null || this.agentExited;
    this.infoButton.style.display = hasPanel ? "" : "none";
    this.renderLiveRow();
  }

  private renderInfoPanel(): void {
    this.infoPanel.innerHTML = "";
    const info = this.storedAgentInfo;
    const caps = this.storedCapabilities;

    const header = document.createElement("div");
    header.classList.add("pulsar-acp-agent-info-header");
    const title = document.createElement("span");
    title.classList.add("pulsar-acp-agent-info-title");
    title.textContent = "Agent details";
    const actions = document.createElement("div");
    actions.classList.add("pulsar-acp-agent-info-actions");
    actions.appendChild(this.restartButton);
    header.appendChild(title);
    header.appendChild(actions);
    this.infoPanel.appendChild(header);

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
      addRow("Status", statusContent);
      return;
    }

    const agentName = info.title || info.name;
    if (agentName) addRow("Agent", agentName);

    const versionValue = document.createElement("span");
    versionValue.classList.add("pulsar-acp-agent-info-value");
    versionValue.textContent = info.version;
    const versionContent = document.createElement("div");
    versionContent.classList.add("pulsar-acp-agent-info-version");
    versionContent.appendChild(versionValue);
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

    // A live session stays on its current agent — prompting never silently
    // switches (a hand-edited activeAgentId applies on the next Switch/Restart).
    // Only resolve from config when starting fresh or reconnecting after exit.
    const live = this.session.sessionId != null && !this.agentExited;
    let target: LaunchTarget | null = live ? this.session.currentTarget : null;
    if (!target) {
      target = this.resolveTarget();
      if (!target) {
        this.appendError(
          "No agent configured. Use the agent picker to add or select one.",
        );
        this.setAgentStatus("error");
        return;
      }
    }
    this.activeTarget = target;
    this.renderAgentPicker();

    const currentSession = this.session;
    this.preparingPrompt = true;
    this.updateInputControls();
    try {
      await this.session.start(target);
      if (this.session !== currentSession) return;
      if (this.pendingImages.length > 0 && !this.session.supportsImages()) {
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

  // Disposes the running session and resets all conversation/agent chrome to a
  // clean idle state. Shared by restart() and switchAgent(); does not start.
  private resetSessionForRelaunch(): void {
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
    this.attachButton.style.display = "none";
    this.resetAgentChrome();
    this.resetSessionsChrome();
    this.setAgentStatus("idle");
    this.renderLiveRow();
    this.stopButton.disabled = true;
    this.autoApprovePermissions = false;
    this.updateAutoApproveButton();
  }

  private restart(): void {
    this.resetSessionForRelaunch();
    this.setLifecycleStatus("Idle \u2014 type a message to start the agent.");
    this.updateInputControls();

    // Restart is user-initiated on a visible panel, so reconnect immediately
    // rather than waiting for the panel to be shown again. ensureStarted()
    // re-resolves the LATEST command from config (so live edits apply) and shows
    // the idle "pick an agent" state when nothing is launchable.
    this.ensureStarted();
  }

  // The only path that performs a process switch (distinct from Restart, which
  // relaunches the active agent).
  private switchAgent(id: string): void {
    const config = readAgentsConfig();
    this.agentsConfig = config;
    const agent = config.agents[id];
    if (!agent) {
      this.renderAgentPicker();
      return;
    }
    const target: LaunchTarget = {
      id,
      name: agent.name,
      command: agent.command,
    };

    // No-op only when this exact agent is already live with the same command
    // (key on the running snapshot, so a hand-edited activeAgentId or command
    // still applies when you pick the agent).
    const launched = this.session.launchedAgent;
    const liveSameAgent =
      launched?.id === id &&
      launched.command === agent.command &&
      this.session.sessionId != null &&
      !this.agentExited;
    if (liveSameAgent) {
      if (config.activeAgentId !== id) this.setActiveAgentId(id);
      this.renderAgentPicker();
      return;
    }

    if (this.session.running) {
      atom.confirm(
        {
          type: "warning",
          message: `Switch to ${agent.name}?`,
          detail:
            "The current agent is still responding. Switching stops it and clears this conversation.",
          buttons: ["Switch", "Cancel"],
          defaultId: 1,
        },
        (response) => {
          if (response === 0) this.performSwitch(target);
        },
      );
      return;
    }

    this.performSwitch(target);
  }

  private performSwitch(target: LaunchTarget): void {
    if (readAgentsConfig().activeAgentId !== target.id) {
      this.setActiveAgentId(target.id);
    }
    this.resetSessionForRelaunch();
    this.setLifecycleStatus("Idle \u2014 starting agent\u2026");
    this.updateInputControls();
    this.activeTarget = target;
    this.renderAgentPicker();
    this.startTarget(target);
  }

  private setActiveAgentId(id: string): void {
    atom.config.set(CFG_ACTIVE, id);
  }

  // Re-read config and refresh the picker. Purely a UI refresh: never starts,
  // stops, or switches a process, so it cannot loop with our own writes.
  refreshFromConfig(): void {
    this.agentsConfig = readAgentsConfig();
    this.renderAgentPicker();
  }

  // Called once after activate() seeds/migrates config. Picks up the migrated
  // shape and, if this panel already tried to start while config was still
  // unmigrated (and nothing launched), retries now that an agent may resolve.
  // Panels that were never shown keep their lazy start-on-visible behavior.
  refreshAfterMigration(): void {
    this.refreshFromConfig();
    const idle =
      this.startAttempted &&
      this.activeTarget == null &&
      this.session.sessionId == null &&
      !this.agentExited;
    if (idle) this.ensureStarted();
  }

  private agentPickerLabel(): string {
    if (this.activeTarget) return this.activeTarget.name;
    const resolved = resolveActiveAgent(this.agentsConfig);
    if (resolved.reason === "ok" && resolved.agent) return resolved.agent.name;
    if (resolved.reason === "no-agents") return "No agents";
    return "Select agent";
  }

  private renderAgentPicker(): void {
    this.agentPicker.textContent = this.agentPickerLabel();
    const stale = isLaunchedAgentStale(
      this.agentsConfig,
      this.session.launchedAgent?.id,
    );
    this.agentPicker.classList.toggle("is-stale", stale);

    this.agentMenu.innerHTML = "";
    const entries = Object.entries(this.agentsConfig.agents);
    for (const [id, agent] of entries) {
      const item = document.createElement("button");
      item.classList.add("pulsar-acp-agent-picker-item");
      item.setAttribute("role", "menuitem");
      if (id === this.agentsConfig.activeAgentId) {
        item.classList.add("is-active");
        item.setAttribute("aria-current", "true");
      }
      item.textContent = agent.name;
      item.addEventListener("click", () => {
        this.closeAgentMenu();
        this.switchAgent(id);
      });
      this.agentMenu.appendChild(item);
    }
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.classList.add("pulsar-acp-agent-picker-empty");
      empty.textContent = "No agents configured";
      this.agentMenu.appendChild(empty);
    }
    const separator = document.createElement("div");
    separator.classList.add("pulsar-acp-agent-picker-separator");
    separator.setAttribute("role", "separator");
    this.agentMenu.appendChild(separator);
    const edit = document.createElement("button");
    edit.classList.add(
      "pulsar-acp-agent-picker-item",
      "pulsar-acp-agent-picker-edit",
    );
    edit.setAttribute("role", "menuitem");
    edit.textContent = "Edit agents\u2026";
    edit.addEventListener("click", () => {
      this.closeAgentMenu();
      atom.commands.dispatch(this.element, "pulsar-acp-agent:edit-agents");
    });
    this.agentMenu.appendChild(edit);
  }

  private agentMenuItems(): HTMLButtonElement[] {
    return Array.from(
      this.agentMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
  }

  private focusAgentMenuItem(
    direction: "first" | "last" | "next" | "previous",
  ): void {
    const items = this.agentMenuItems();
    if (items.length === 0) return;
    const active = document.activeElement;
    const currentIndex = items.indexOf(active as HTMLButtonElement);
    let nextIndex = 0;
    if (direction === "last") {
      nextIndex = items.length - 1;
    } else if (direction === "next") {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0;
    } else if (direction === "previous") {
      nextIndex =
        currentIndex >= 0
          ? (currentIndex - 1 + items.length) % items.length
          : items.length - 1;
    }
    items[nextIndex].focus();
  }

  private toggleAgentMenu(): void {
    if (this.agentMenuOpen) this.closeAgentMenu();
    else this.openAgentMenu();
  }

  private openAgentMenu(): void {
    this.renderAgentPicker();
    this.agentMenu.style.display = "";
    this.agentMenuOpen = true;
    this.agentPicker.setAttribute("aria-expanded", "true");
  }

  private closeAgentMenu(): void {
    this.agentMenu.style.display = "none";
    this.agentMenuOpen = false;
    this.agentPicker.setAttribute("aria-expanded", "false");
  }

  private resetSessionsChrome(): void {
    this.sessionTooltips.dispose();
    this.sessionTooltips = new CompositeDisposable();
    this.sessionsToggle.style.display = "none";
    this.newSessionButton.style.display = "none";
    const rows = this.sessionsList.querySelectorAll(".pulsar-acp-agent-session-row");
    rows.forEach((r) => r.remove());
    this.sessionsList.style.display = "none";
    this.knownSessions = [];
    this.sessionsListVisible = false;
    this.sessionsToggle.setAttribute("aria-expanded", "false");
    this.sessionConversationCache.clear();
    this.sessionLiveState.clear();
    this.sessionPlanState.clear();
  }

  private resetAgentChrome(): void {
    this.storedAgentInfo = null;
    this.storedCapabilities = null;
    this.currentTokens = null;
    this.agentExited = false;
    this.settingConfig.clear();
    this.renderLiveRow();
    this.renderConfigSelectors();
    this.renderPill();
    this.infoPanel.style.display = "none";
    this.infoPanel.innerHTML = "";
    this.infoPanelOpen = false;
    this.infoButton.setAttribute("aria-expanded", "false");
  }

  private clearConversation(): void {
    this.conversation.innerHTML = "";
    this.resetConversationState();
  }

  private resetConversationState(): void {
    this.toolViews.clear();
    this.terminalOutputs.clear();
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    this.renderPlanBar();
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
    this.autoApprovePermissions = false;
    this.updateAutoApproveButton();
    // Cache the outgoing conversation: the agent keeps it loaded, so returning
    // to it must restore this DOM rather than re-load (which the agent rejects).
    const currentId = this.session.sessionId;
    if (currentId) {
      this.rememberPlanStateFor(currentId);
      this.sessionConversationCache.set(currentId, this.conversation);
      this.swapInFreshConversation();
    }
    this.session.newSession().catch((error) => {
      // Roll back to the previous conversation if creating the session failed.
      if (currentId) {
        const prev = this.sessionConversationCache.get(currentId);
        if (prev) {
          this.swapInConversation(prev);
          this.restorePlanStateFor(currentId);
        }
      }
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  private switchToSession(id: string): void {
    if (this.session.running || this.session.switching) return;
    this.autoApprovePermissions = false;
    this.updateAutoApproveButton();
    this.hideLoadingOverlay();
    const currentId = this.session.sessionId;
    const info = this.knownSessions.find((s) => s.sessionId === id);

    // Save current conversation DOM node (preserves canvas pixels etc.)
    if (currentId) {
      this.rememberPlanStateFor(currentId);
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
      this.restorePlanStateFor(id);
      this.session.activateCachedSession(id);
      return;
    }

    this.resetConversationState();
    // session/load replays history asynchronously; cover the blank pane with a
    // pulsing overlay until the "ready" event reveals the restored conversation.
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
        if (prev) {
          this.swapInConversation(prev);
          this.restorePlanStateFor(currentId);
        }
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
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    this.renderPlanBar();
    this.stickToBottom = true;
    this.updateScrollToBottomButton();
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
    this.updateScrollToBottomButton();
    this.attachConversationScrollListener();
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "status":
        this.setLifecycleStatus(event.text);
        this.setAgentStatus("connecting");
        break;
      case "initialized":
        this.agentExited = false;
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
        this.renderConfigSelectors();
        if (event.source === "new") {
          this.clearConversation();
        }
        if (event.source === "load") {
          this.endStreamingBlocks();
          this.snapshotCompletedPlan();
          this.stickToBottom = true;
          this.conversation.scrollTop = this.conversation.scrollHeight;
        }
        this.sessionsToggle.style.display = this.session.canListSessions()
          ? ""
          : "none";
        this.newSessionButton.style.display = "";
        this.updateSessionControls();
        this.updateInputControls();
        break;
      case "session-list":
        this.renderSessionsList(event.sessions);
        break;
      case "turn-start":
        this.clearCompletedActivePlanEntries();
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
        this.snapshotCompletedPlan();
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
        if (this.agentExited) break;
        this.hideLoadingOverlay();
        this.setGeneratingState(null);
        const detail = `exited${event.code != null ? ` (code ${event.code})` : ""}`;
        this.agentExited = true;
        this.currentTokens = null;
        this.renderLiveRow();
        this.renderConfigSelectors();
        this.setLifecycleStatus(`Agent ${detail}.`);
        this.setAgentStatus("error");
        // Auto-open details so Restart stays reachable even if the agent died
        // before reporting any identity (e.g. a bad agent command).
        this.openInfoPanel();
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
        this.setActivePlan(update.entries || [], sessionId);
        break;
      case "config_option_update":
        this.renderConfigSelectors();
        break;
      case "usage_update":
        if (
          typeof update.used === "number" &&
          typeof update.size === "number"
        ) {
          this.currentTokens = `${update.used}\u202f/\u202f${update.size} tokens`;
          this.rememberLiveState(sessionId, this.currentTokens);
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
      this.imageSupportKnown &&
      this.supportsImages
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
    this.updateConfigSelectorsDisabled();
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

  private clonePlanEntries(entries: acp.PlanEntry[]): acp.PlanEntry[] {
    return entries.map((entry) => ({ ...entry }));
  }

  private rememberPlanStateFor(sessionId: string): void {
    if (this.activePlanEntries.length > 0) {
      this.sessionPlanState.set(
        sessionId,
        this.clonePlanEntries(this.activePlanEntries),
      );
    } else {
      this.sessionPlanState.delete(sessionId);
    }
  }

  private restorePlanStateFor(sessionId: string | null): void {
    this.activePlanEntries = sessionId
      ? this.clonePlanEntries(this.sessionPlanState.get(sessionId) ?? [])
      : [];
    this.activePlanSessionId =
      this.activePlanEntries.length > 0 ? sessionId : null;
    this.renderPlanBar();
  }

  private setActivePlan(
    entries: acp.PlanEntry[],
    sessionId: string | null,
  ): void {
    this.activePlanEntries = this.clonePlanEntries(entries);
    this.activePlanSessionId =
      this.activePlanEntries.length > 0 ? sessionId : null;
    if (sessionId) {
      if (this.activePlanEntries.length > 0) {
        this.sessionPlanState.set(
          sessionId,
          this.clonePlanEntries(this.activePlanEntries),
        );
      } else {
        this.sessionPlanState.delete(sessionId);
      }
    }
    this.renderPlanBar();
  }

  private clearActivePlan(sessionId: string | null): void {
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    if (sessionId) this.sessionPlanState.delete(sessionId);
    this.renderPlanBar();
  }

  // The live plan is a pinned bar above the composer (matching Zed and VS
  // Code) so it stays glanceable while the conversation scrolls; only the
  // completed plan is snapshotted into the transcript.
  private renderPlanBar(): void {
    const entries = this.activePlanEntries;
    this.planBar.innerHTML = "";
    if (entries.length === 0) {
      this.planBar.style.display = "none";
      return;
    }
    this.planBar.style.display = "";

    const total = entries.length;
    const completed = entries.filter((e) => e.status === "completed").length;
    const inProgress = entries.find((e) => e.status === "in_progress");

    const header = document.createElement("div");
    header.classList.add("pulsar-acp-agent-plan-bar-header");

    const twisty = document.createElement("span");
    twisty.classList.add(
      "pulsar-acp-agent-plan-bar-twisty",
      "icon",
      this.planExpanded ? "icon-chevron-down" : "icon-chevron-right",
    );

    const title = document.createElement("span");
    title.classList.add("pulsar-acp-agent-plan-bar-title");
    title.textContent =
      !this.planExpanded && inProgress
        ? `Current: ${inProgress.content}`
        : "Plan";

    const count = document.createElement("span");
    count.classList.add("pulsar-acp-agent-plan-bar-count");
    count.textContent =
      completed === total
        ? "All done"
        : completed === 0
          ? `${total} tasks`
          : `${completed}/${total}`;

    const dismiss = document.createElement("button");
    dismiss.classList.add("pulsar-acp-agent-plan-bar-dismiss", "icon", "icon-x");
    dismiss.setAttribute("aria-label", "Clear plan");
    dismiss.addEventListener("click", (event) => {
      event.stopPropagation();
      this.clearActivePlan(this.activePlanSessionId);
    });

    header.appendChild(twisty);
    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(dismiss);
    header.addEventListener("click", () => {
      this.planExpanded = !this.planExpanded;
      this.renderPlanBar();
    });
    this.planBar.appendChild(header);

    if (this.planExpanded) {
      const body = document.createElement("div");
      body.classList.add("pulsar-acp-agent-plan-bar-body");
      this.appendPlanEntries(body, entries);
      this.planBar.appendChild(body);
    }
  }

  private appendPlanEntries(
    container: HTMLElement,
    entries: acp.PlanEntry[],
  ): void {
    const marks: Record<string, string> = {
      pending: "\u25cb",
      in_progress: "\u25d0",
      completed: "\u2713",
    };
    for (const entry of entries) {
      const row = document.createElement("div");
      row.classList.add("pulsar-acp-agent-plan-entry");
      row.dataset.status = entry.status;
      row.textContent = `${marks[entry.status] || "\u25cb"} ${entry.content}`;
      container.appendChild(row);
    }
  }

  private snapshotCompletedPlan(): void {
    if (!completedPlanEntries(this.activePlanEntries)) {
      return;
    }

    const card = document.createElement("div");
    card.classList.add(
      "pulsar-acp-agent-plan",
      "pulsar-acp-agent-plan--completed",
    );
    const heading = document.createElement("div");
    heading.classList.add("pulsar-acp-agent-plan-heading");
    heading.textContent = "Completed Plan";
    card.appendChild(heading);
    this.appendPlanEntries(card, this.activePlanEntries);
    this.conversation.appendChild(card);

    const sessionId = this.activePlanSessionId;
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    if (sessionId) this.sessionPlanState.delete(sessionId);
    this.renderPlanBar();
    this.scrollToBottom();
  }

  private clearCompletedActivePlanEntries(): void {
    if (this.activePlanEntries.length === 0) return;
    const entries = nextTurnActivePlanEntries(this.activePlanEntries);
    if (entries.length === this.activePlanEntries.length) return;
    this.setActivePlan(entries, this.session.sessionId);
  }

  private renderPermission(
    params: acp.RequestPermissionRequest,
    respond: (outcome: acp.RequestPermissionResponse) => void,
  ): void {
    const toolCall = params.toolCall;
    const toolTitle = toolCall?.title || "an action";

    if (this.autoApprovePermissions) {
      const option =
        params.options?.find((o) => o.kind === "allow_once");
      if (option) {
        respond({ outcome: { outcome: "selected", optionId: option.optionId } });
        if (this.session.running) {
          this.setGeneratingState("working");
          this.setAgentStatus("working");
        }
        return;
      }
    }

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
    // Remove existing session rows
    const rows = this.sessionsList.querySelectorAll(".pulsar-acp-agent-session-row");
    rows.forEach((r) => r.remove());

    for (const info of sessions) {
      const row = document.createElement("div");
      row.classList.add("pulsar-acp-agent-session-row");
      row.dataset.sessionId = info.sessionId;
      if (info.sessionId === this.session.sessionId) {
        row.classList.add("is-active");
      }

      const entry = document.createElement("button");
      entry.classList.add("pulsar-acp-agent-session-entry");
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

      const canDelete = this.session.canDeleteSession();
      const del = document.createElement("button");
      del.classList.add("pulsar-acp-agent-session-delete", "icon", "icon-trashcan");
      del.setAttribute("aria-label", "Delete session");
      del.style.display = canDelete ? "" : "none";
      this.sessionTooltips.add(
        atom.tooltips.add(del, { title: "Delete session" }),
      );
      del.disabled = this.session.running || this.session.switching || !canDelete;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteSession(info.sessionId);
      });

      row.appendChild(entry);
      row.appendChild(del);
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
      this.sessionPlanState.delete(id);
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
    const canDelete = this.session.canDeleteSession();
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
      if (del) del.disabled = busy || !canDelete;
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
    let text = this.currentTokens ?? "";
    if (!text && (!this.storedAgentInfo || this.agentExited)) {
      text = this.lifecycleStatus || (this.agentExited ? "Agent exited" : "Starting\u2026");
    }
    this.liveStatusEl.textContent = text;
    this.liveStatusEl.style.display = text ? "" : "none";
    const hasDetails = this.infoButton.style.display !== "none";
    this.runtimeStatusEl.style.display = hasDetails || text ? "" : "none";
  }

  // Token usage is per-session; remember it so switching back to a session
  // restores its live row instead of showing a blank one.
  private rememberLiveState(sessionId: string, tokens: string | null): void {
    this.sessionLiveState.set(sessionId, { tokens });
  }

  private restoreLiveStateFor(sessionId: string | null): void {
    const state = sessionId ? this.sessionLiveState.get(sessionId) : undefined;
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
      this.updateScrollToBottomButton();
    });
  }

  private updateScrollToBottomButton(): void {
    this.scrollToBottomButton.style.display = this.stickToBottom ? "none" : "";
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
    for (const selector of this.configSelectors) selector.dispose();
    this.configSelectors = [];
    this.subscriptions.dispose();
    this.session.dispose();
    if (this.element) this.element.remove();
  }
}
