import { For, Show, type JSX } from "solid-js";
import type { CollabPresence } from "@/types/annotation";

interface PresenceBadgeProps {
  peers: CollabPresence[];
  connected: boolean;
}

/**
 * Compact presence indicator next to the annotation tool button: one colored
 * dot per remote participant (name on hover), gray when the collab connection
 * is down. Only rendered while a collab room is joined.
 */
export function PresenceBadge(props: PresenceBadgeProps): JSX.Element {
  const title = () => {
    if (!props.connected) return "Verbinding met de gedeelde sessie verbroken";
    if (props.peers.length === 0) return "Gedeelde sessie — nog geen andere deelnemers";
    return props.peers.map((p) => p.user.name).join(", ");
  };

  return (
    <div class="flex items-center gap-1 px-1.5" title={title()}>
      <For each={props.peers.slice(0, 5)}>
        {(peer) => (
          <span
            class="h-2.5 w-2.5 rounded-full ring-1 ring-white"
            style={{ "background-color": props.connected ? peer.user.color : "#9ca3af" }}
          />
        )}
      </For>
      <Show when={props.peers.length > 5}>
        <span class="text-[11px] text-gray-500">+{props.peers.length - 5}</span>
      </Show>
      <span
        class={`h-2 w-2 rounded-full ${props.connected ? "bg-green-500" : "bg-gray-300"}`}
        aria-hidden
      />
    </div>
  );
}
