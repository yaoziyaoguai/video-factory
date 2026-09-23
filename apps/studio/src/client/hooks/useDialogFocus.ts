import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element instanceof HTMLInputElement && element.type === "hidden") return false;
    return visibleInDialog(element, dialog);
  });
}

function visibleInDialog(element: HTMLElement, dialog: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (node.tagName === "DETAILS" && !node.hasAttribute("open") && node.querySelector(":scope > summary") !== element) return false;
    if (node === dialog) break;
  }
  return true;
}

export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  closeBlocked = false,
  focusKey?: unknown,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const closeBlockedRef = useRef(closeBlocked);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeBlockedRef.current = closeBlocked;
  });

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeBlockedRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current ? focusableElements(dialogRef.current) : [];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const candidates = dialog ? focusableElements(dialog) : [];
    const initial = dialog && Array.from(dialog.querySelectorAll<HTMLElement>("[data-dialog-initial-focus]"))
      .find((element) => visibleInDialog(element, dialog));
    (initial ?? candidates[0] ?? dialog)?.focus();
  }, [focusKey, open]);

  return dialogRef;
}
