import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { Need, Needs } from "../../shared/types";
import { PixelIcon } from "./icons";

export function RetroDialog({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-shade" />
        <Dialog.Content className={`retro-dialog ${wide ? "retro-dialog-wide" : ""}`}>
          <div className="window-title">
            <PixelIcon name="app" size={15} />
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="window-button" aria-label="Close dialog">
              ×
            </Dialog.Close>
          </div>
          <div className="dialog-content">
            <Dialog.Description className="dialog-description">{description}</Dialog.Description>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DesktopMenu({ label, children }: { label: string; children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && root.current) root.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.current?.open) {
        event.preventDefault();
        event.stopPropagation();
        root.current.open = false;
        root.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    root.current?.addEventListener("keydown", escape);
    const element = root.current;
    return () => {
      document.removeEventListener("pointerdown", close);
      element?.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <details
      ref={root}
      className="desktop-menu"
      onToggle={(event) => {
        const element = event.currentTarget;
        setOpen(element.open);
        const menu = element.querySelector<HTMLElement>(".menu-items");
        if (element.open && menu) {
          menu.style.left = "0px";
          const bounds = menu.getBoundingClientRect();
          const shift = Math.min(0, window.innerWidth - 8 - bounds.right);
          menu.style.left = `${Math.max(8 - bounds.left, shift)}px`;
        }
      }}
    >
      <summary>{label}</summary>
      <div
        className="menu-items"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button:not(:disabled)") && root.current)
            root.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}

export const CORE_NEEDS: { id: Need; label: string }[] = [
  { id: "food", label: "Fed" },
  { id: "joy", label: "Amused" },
  { id: "clean", label: "Clean" },
];
export function NeedMeters({
  needs,
  name,
  advanced = false,
}: {
  needs: Needs | null;
  name: string;
  advanced?: boolean;
}) {
  const fields = advanced
    ? [
        { id: "rest" as const, label: "Rest" },
        { id: "social" as const, label: "Social" },
      ]
    : CORE_NEEDS;
  return (
    <div className={`need-readout ${advanced ? "need-readout-advanced" : ""}`}>
      {fields.map(({ id, label }) => {
        const value = needs ? Math.max(0, Math.min(100, Math.round(needs[id]))) : 0;
        return (
          <div className="need-item" key={id}>
            <span>{label}</span>
            <div
              className={`need-gauge ${value < 25 ? "need-low" : value < 50 ? "need-mid" : ""}`}
              role="meter"
              aria-label={`${name}: ${label}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={value}
              aria-valuetext={needs ? `${value} percent satisfied` : "No creatures yet"}
            >
              <i style={{ width: `${value}%` }} />
            </div>
            <span className="need-value" aria-hidden="true">
              {needs ? value : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
