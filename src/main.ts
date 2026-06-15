import { CompositeDisposable } from "atom";
import { PULSAR_ACP_AGENT_URI, PulsarAcpAgentView } from "./agent-view";

let subscriptions: CompositeDisposable;
const views = new Set<PulsarAcpAgentView>();

function createView(): PulsarAcpAgentView {
  const view = new PulsarAcpAgentView();
  const destroy = view.destroy.bind(view);
  view.destroy = () => {
    views.delete(view);
    destroy();
  };
  views.add(view);
  return view;
}

export function activate(): void {
  subscriptions = new CompositeDisposable();
  subscriptions.add(
    atom.workspace.addOpener((uri: string) => {
      if (uri === PULSAR_ACP_AGENT_URI) return createView();
    }),
    atom.commands.add("atom-workspace", {
      "pulsar-acp-agent:toggle": () =>
        atom.workspace.toggle(PULSAR_ACP_AGENT_URI),
      "pulsar-acp-agent:focus": () =>
        atom.workspace.open(PULSAR_ACP_AGENT_URI, { searchAllPanes: true }),
    }),
    atom.deserializers.add({
      name: "PulsarAcpAgentView",
      deserialize: () => createView(),
    }),
  );
}

export function deactivate(): void {
  subscriptions.dispose();
  for (const view of Array.from(views)) view.destroy();
  views.clear();
}
