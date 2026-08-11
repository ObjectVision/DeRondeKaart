import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { PresenceBadge } from "@/components/annotations/PresenceBadge";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import type { CollabPresence } from "@/types/annotation";
import type { AnnotationToolKind } from "@/hooks/use-annotation-tool";

/** One drawing tool: the icon it shows and the labels it announces. */
const DRAW_TOOLS: { tool: AnnotationToolKind; icon: string; label: string }[] = [
  { tool: "circle", icon: "circle", label: "Cirkel plaatsen" },
  { tool: "polygon", icon: "pentagon", label: "Polygoon plaatsen" },
  { tool: "pin", icon: "location_on", label: "Pin plaatsen" },
];

export interface AnnotationToolbarProps {
  /** Whether annotation mode is on — the drawing tools only exist inside it. */
  active: boolean;
  /** Armed tool, or null. Arming one places a single shape, then disarms. */
  drawTool: AnnotationToolKind | null;
  onSetTool: (tool: AnnotationToolKind | null) => void;
  /** Enters/leaves annotation mode. App also disarms the area-select tool here. */
  onToggleMode: () => void;
  /** Presence is shown only once a collaborative room exists. */
  collabRoomId: string | null;
  collabPeers: CollabPresence[];
  collabConnected: boolean;
}

/**
 * The annotation tool card: the drawing tools (circle / polygon / pin), the
 * mode toggle that opens and closes annotation mode, and the collaborator
 * presence badge.
 *
 * Presentational only — every piece of state it shows is owned by
 * `useAnnotationTool` and `useCollab` in App. It is deliberately just this card
 * and not the whole top-right stack: that stack also holds the statistics-panel
 * restore button, an unrelated control that merely shares the same positioning
 * wrapper (whose offset shifts the stack left when the statistics panel occupies
 * the corner). App keeps the wrapper so that coupling stays visible where the
 * layout decision is made.
 */
export function AnnotationToolbar({
  active,
  drawTool,
  onSetTool,
  onToggleMode,
  collabRoomId,
  collabPeers,
  collabConnected,
}: AnnotationToolbarProps) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
      {/* Drawing toolbar — left of the mode toggle, only in the mode. */}
      {active && (
        <>
          {DRAW_TOOLS.map(({ tool, icon, label }) => {
            const armed = drawTool === tool;
            return (
              <Button
                key={tool}
                variant="ghost"
                size="icon-sm"
                onClick={() => onSetTool(armed ? null : tool)}
                title={label}
                aria-label={label}
                aria-pressed={armed}
              >
                <Icon
                  name={icon}
                  size={chromeIconSize()}
                  color={armed ? chromeIconColor() : undefined}
                  className={armed ? undefined : "text-gray-400"}
                />
              </Button>
            );
          })}
          <div className="h-4 w-px bg-gray-200" aria-hidden />
        </>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleMode}
        title={active ? "Annotaties sluiten" : "Annotaties"}
        aria-label={active ? "Annotaties sluiten" : "Annotaties"}
        aria-pressed={active}
      >
        {/* Two literal `name` props rather than one ternary: the icon-font
            subsetter scans for `name="…"` and would miss the second string. */}
        {active ? (
          <Icon name="edit_off" size={chromeIconSize()} color={chromeIconColor()} />
        ) : (
          <Icon name="edit" size={chromeIconSize()} className="text-gray-400" />
        )}
      </Button>
      {active && collabRoomId && (
        <PresenceBadge peers={collabPeers} connected={collabConnected} />
      )}
    </div>
  );
}
