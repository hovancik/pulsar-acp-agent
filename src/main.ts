import { CommandEvent, CompositeDisposable, Disposable, TextEditor } from "atom";
import type { StatusBar, Tile } from "atom/status-bar";
import {
  AgentStatus,
  AgentStatusReporter,
  migrateAgentsConfigStore,
  PULSAR_ACP_AGENT_URI,
  PulsarAcpAgentView,
} from "./agent-view";

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "Idle",
  connecting: "Connecting\u2026",
  ready: "Ready",
  working: "Working\u2026",
  awaiting: "Awaiting confirmation\u2026",
  error: "Error",
};

class StatusIndicator implements AgentStatusReporter {
  private element: HTMLElement;
  private nameEl: HTMLElement;
  private dotEl: HTMLElement;
  private tile: Tile | null = null;
  private tooltip: Disposable;
  private active: PulsarAcpAgentView | null = null;
  private status: AgentStatus = "idle";
  private name: string | null = null;

  constructor() {
    this.element = document.createElement("a");
    this.element.classList.add("pulsar-acp-agent-status-tile", "inline-block");
    this.element.addEventListener("click", () => {
      atom.workspace.open(PULSAR_ACP_AGENT_URI, { searchAllPanes: true });
    });

    const icon = document.createElement("span");
    icon.classList.add("icon", "icon-hubot");

    this.nameEl = document.createElement("span");
    this.nameEl.classList.add("pulsar-acp-agent-status-tile-name");

    this.dotEl = document.createElement("span");
    this.dotEl.classList.add("pulsar-acp-agent-status-tile-dot");

    this.element.appendChild(icon);
    this.element.appendChild(this.nameEl);
    this.element.appendChild(this.dotEl);
    this.tooltip = atom.tooltips.add(this.element, {
      title: () => this.title(),
      html: false,
    });
    this.render();
  }

  setStatusBar(statusBar: StatusBar): void {
    this.tile?.destroy();
    this.tile = statusBar.addRightTile({ item: this.element, priority: 100 });
  }

  report(
    view: PulsarAcpAgentView,
    status: AgentStatus,
    name: string | null,
  ): void {
    this.active = view;
    this.status = status;
    this.name = name;
    this.render();
  }

  clear(view: PulsarAcpAgentView): void {
    if (this.active !== view) return;
    this.active = null;
    this.status = "idle";
    this.name = null;
    this.render();
  }

  destroy(): void {
    this.tooltip.dispose();
    this.tile?.destroy();
    this.tile = null;
  }

  private render(): void {
    this.nameEl.textContent = this.name || "Agent";
    this.dotEl.dataset.status = this.status;
  }

  private title(): string {
    const label = STATUS_LABELS[this.status];
    return this.name
      ? `${this.name} \u00b7 ${label}`
      : `Pulsar ACP Agent \u00b7 ${label}`;
  }
}

let subscriptions: CompositeDisposable;
let indicator: StatusIndicator | null = null;
const views = new Set<PulsarAcpAgentView>();

// The docked panel can be deserialized before activate() runs, so the indicator
// must exist on first use from any entry point, not just activate().
function getIndicator(): StatusIndicator {
  return (indicator ??= new StatusIndicator());
}

function createView(): PulsarAcpAgentView {
  const view = new PulsarAcpAgentView(getIndicator());
  const destroy = view.destroy.bind(view);
  view.destroy = () => {
    views.delete(view);
    destroy();
  };
  views.add(view);
  return view;
}

// Resolve the editor a context command was dispatched on (its target, falling
// back to the center pane's active editor), open/focus the panel, and stage the
// requested attachment. The attachment is validated again when the prompt sends.
async function addEditorContext(
  event: CommandEvent,
  kind: "file" | "selection",
): Promise<void> {
  const element = event.currentTarget as unknown as {
    getModel?: () => TextEditor | undefined;
  };
  const editor =
    element.getModel?.() ?? atom.workspace.getCenter().getActiveTextEditor();
  if (!editor) return;
  const item = await atom.workspace.open(PULSAR_ACP_AGENT_URI, {
    searchAllPanes: true,
  });
  if (!(item instanceof PulsarAcpAgentView)) return;
  if (kind === "file") await item.addActiveFileContext(editor);
  else await item.addSelectionContext(editor);
}

function editorHasSelection(): boolean {
  const editor = atom.workspace.getCenter().getActiveTextEditor();
  return !!editor && editor.getSelections().some((s) => !s.isEmpty());
}

export function activate(): void {
  // Seed/migrate the agent registry once before views start resolving it, then
  // refresh any panel already deserialized (a docked panel can be restored
  // before activate runs).
  migrateAgentsConfigStore();
  for (const view of views) view.refreshAfterMigration();

  subscriptions = new CompositeDisposable();
  subscriptions.add(
    atom.workspace.addOpener((uri: string) => {
      if (uri === PULSAR_ACP_AGENT_URI) return createView();
    }),
    atom.commands.add("atom-workspace", {
      "pulsar-acp-agent:toggle": {
        displayName: "Pulsar ACP Agent: Toggle Panel",
        didDispatch: () => atom.workspace.toggle(PULSAR_ACP_AGENT_URI),
      },
      "pulsar-acp-agent:focus": {
        displayName: "Pulsar ACP Agent: Focus Panel",
        didDispatch: () =>
          atom.workspace.open(PULSAR_ACP_AGENT_URI, { searchAllPanes: true }),
      },
      "pulsar-acp-agent:edit-agents": {
        displayName: "Pulsar ACP Agent: Edit Agents",
        didDispatch: () => atom.workspace.open(atom.config.getUserConfigPath()),
      },
    }),
    atom.commands.add(".pulsar-acp-agent", {
      // Pulsar only wires copy inside text editors, so chat selections can't be
      // copied. The platform copy shortcut and the context menu already dispatch
      // core:copy; handle it here, copying the panel's selection. Fall through
      // (abortKeyBinding) when the selection is empty or outside the panel so a
      // focused input still copies natively.
      "core:copy": (event) => {
        const selection = window.getSelection();
        const text = selection?.toString() ?? "";
        const target = event.currentTarget as HTMLElement;
        if (text && selection?.anchorNode && target.contains(selection.anchorNode)) {
          atom.clipboard.write(text);
          event.stopPropagation();
        } else {
          event.abortKeyBinding();
        }
      },
    }),
    atom.commands.add("atom-text-editor", {
      "pulsar-acp-agent:add-active-file-to-prompt": {
        displayName: "Pulsar ACP Agent: Add Active File to Prompt",
        didDispatch: (event) => {
          void addEditorContext(event, "file");
        },
      },
      "pulsar-acp-agent:add-selection-to-prompt": {
        displayName: "Pulsar ACP Agent: Add Selection to Prompt",
        didDispatch: (event) => {
          void addEditorContext(event, "selection");
        },
      },
    }),
    atom.contextMenu.add({
      "atom-text-editor": [
        {
          label: "Add Active File to ACP Prompt",
          command: "pulsar-acp-agent:add-active-file-to-prompt",
        },
        {
          label: "Add Selection to ACP Prompt",
          command: "pulsar-acp-agent:add-selection-to-prompt",
          shouldDisplay: () => editorHasSelection(),
        },
      ],
    }),
  );
}

export function consumeStatusBar(statusBar: StatusBar): Disposable {
  getIndicator().setStatusBar(statusBar);
  return new Disposable(() => {
    indicator?.destroy();
    indicator = null;
  });
}

// Registered through the package.json "deserializers" field so Pulsar can
// restore a docked panel on startup, before an activation command runs.
export function deserializePulsarAcpAgentView(): PulsarAcpAgentView {
  return createView();
}

export function deactivate(): void {
  subscriptions.dispose();
  indicator?.destroy();
  indicator = null;
  for (const view of Array.from(views)) view.destroy();
  views.clear();
}
