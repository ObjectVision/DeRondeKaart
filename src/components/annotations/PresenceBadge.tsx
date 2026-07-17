import type { CollabPresence } from "@/types/annotation";

/**
 * Compact presence indicator next to the annotation tool button: one colored
 * dot per remote participant (name on hover), gray when the collab connection
 * is down. Only rendered while a collab room is joined.
 */
export function PresenceBadge({
  peers,
  connected,
}: {
  peers: CollabPresence[];
  connected: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1 px-1.5"
      title={
        connected
          ? peers.length > 0
            ? peers.map((p) => p.user.name).join(", ")
            : "Gedeelde sessie — nog geen andere deelnemers"
          : "Verbinding met de gedeelde sessie verbroken"
      }
    >
      {peers.slice(0, 5).map((peer, i) => (
        <span
          key={`${peer.user.name}-${i}`}
          className="h-2.5 w-2.5 rounded-full ring-1 ring-white"
          style={{ backgroundColor: connected ? peer.user.color : "#9ca3af" }}
        />
      ))}
      {peers.length > 5 && (
        <span className="text-[11px] text-gray-500">+{peers.length - 5}</span>
      )}
      <span
        className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-gray-300"}`}
        aria-hidden
      />
    </div>
  );
}
