import {
  Show,
  createContext,
  useContext,
  onMount,
  onCleanup,
  splitProps,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";

import { cn } from "@/lib/utils";

/**
 * A centered modal with a dimmed backdrop, portalled to the document body (the
 * app's other "windows" are absolutely-positioned cards; this is the first true
 * modal). No open/close scale animation — MapLibre maps mounted inside must
 * measure their final size.
 *
 * Replaces the Base UI Dialog. Base UI supplied the portal, the focus trap and
 * the dismiss behaviour; those are the three things implemented by hand below.
 */

interface DialogContextValue {
  open(): boolean;
  setOpen(open: boolean): void;
}

const DialogContext = createContext<DialogContextValue>();

function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("Dialog parts must be rendered inside a <DialogRoot>");
  return ctx;
}

/** Elements that can hold focus, in DOM order, for the Tab trap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface DialogRootProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: JSX.Element;
}

function DialogRoot(props: DialogRootProps): JSX.Element {
  return (
    <DialogContext.Provider
      value={{
        open: () => props.open,
        setOpen: (open) => props.onOpenChange(open),
      }}
    >
      {props.children}
    </DialogContext.Provider>
  );
}

interface DialogContentProps {
  class?: string;
  children: JSX.Element;
}

function DialogContent(props: DialogContentProps): JSX.Element {
  const dialog = useDialog();
  const [local] = splitProps(props, ["class", "children"]);

  return (
    <Show when={dialog.open()}>
      {(() => {
        let popup!: HTMLDivElement;

        onMount(() => {
          // Restore focus to whatever opened the dialog once it closes, so
          // keyboard users are not dropped back at the top of the document.
          const opener = document.activeElement as HTMLElement | null;
          popup.focus();
          onCleanup(() => opener?.focus());
        });

        function handleKeyDown(event: KeyboardEvent) {
          if (event.key === "Escape") {
            event.stopPropagation();
            dialog.setOpen(false);
            return;
          }
          if (event.key !== "Tab") return;
          // Focus trap: wrap from last to first and back, so Tab can never
          // reach the page behind the backdrop.
          const focusable = Array.from(
            popup.querySelectorAll<HTMLElement>(FOCUSABLE),
          ).filter((el) => el.offsetParent !== null);
          if (focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        }

        return (
          <Portal>
            <div
              class="fixed inset-0 z-40 bg-black/40"
              onClick={() => dialog.setOpen(false)}
            />
            <div
              ref={popup}
              role="dialog"
              aria-modal="true"
              tabindex={-1}
              onKeyDown={handleKeyDown}
              class={cn(
                "fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[min(64rem,calc(100vw-2rem))]",
                "-translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-lg outline-none",
                local.class,
              )}
            >
              {local.children}
            </div>
          </Portal>
        );
      })()}
    </Show>
  );
}

interface DialogTextProps {
  class?: string;
  children: JSX.Element;
}

function DialogTitle(props: DialogTextProps): JSX.Element {
  const [local] = splitProps(props, ["class", "children"]);
  return (
    <h2 class={cn("text-2xl font-bold text-gray-900", local.class)}>{local.children}</h2>
  );
}

function DialogDescription(props: DialogTextProps): JSX.Element {
  const [local] = splitProps(props, ["class", "children"]);
  return <p class={cn("text-sm text-gray-600", local.class)}>{local.children}</p>;
}

export { DialogRoot, DialogContent, DialogTitle, DialogDescription };
