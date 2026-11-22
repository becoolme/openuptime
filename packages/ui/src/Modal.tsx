import { useEffect, useId, useRef } from "react";

// Open dialogs, innermost last: Escape closes only the top one.
const stack: symbol[] = [];

/**
 * A dialog over a dimmed backdrop: centred on wide screens, a bottom sheet on phones. Escape and a click on the backdrop
 * close it, focus moves into it and goes back where it was afterwards. Give `closeLabel` for the sectioned layout
 * (fixed header with a × button, scrolling body, fixed `footer`) that long forms use.
 */
export default function Modal({
  onClose, title, label, closeLabel, footer, as = "div", onSubmit, dismissable = true, backdropClose = true, className = "", style, children,
}: {
  onClose: () => void;
  /** Heading at the top; it also names the dialog for screen readers. */
  title?: React.ReactNode;
  /** Accessible name when there is no `title`. */
  label?: string;
  /** Accessible name of the × button. Giving it switches to the sectioned layout. */
  closeLabel?: string;
  /** Pinned below the scrolling body in the sectioned layout; ignored otherwise. */
  footer?: React.ReactNode;
  /** "form" makes the card the form, so a submit button anywhere inside it submits. */
  as?: "div" | "form";
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  /** False while work is in flight: Escape, the backdrop and × do nothing. */
  dismissable?: boolean;
  /** Close on a click outside the card. Long forms turn this off so a stray click keeps what was typed. */
  backdropClose?: boolean;
  /** Extra classes on the card. */
  className?: string;
  /** Styles on the card, e.g. a wider `width`. */
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const card = useRef<HTMLElement>(null);
  const downOnBackdrop = useRef(false);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const canClose = useRef(dismissable);
  canClose.current = dismissable;

  useEffect(() => {
    const me = Symbol();
    stack.push(me);
    const before = document.activeElement as HTMLElement | null;
    // a field with autoFocus already has focus by now; otherwise the dialog itself takes it
    if (!card.current?.contains(document.activeElement)) card.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || stack.at(-1) !== me || !canClose.current) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(me), 1);
      if (before?.isConnected) before.focus();
    };
  }, []);

  const sectioned = closeLabel !== undefined;
  const cls = `card${sectioned ? " mform" : ""}${className ? ` ${className}` : ""}`;
  const a11y = { role: "dialog", "aria-modal": true, "aria-labelledby": title ? titleId : undefined, "aria-label": title ? undefined : label, tabIndex: -1 } as const;
  const body = sectioned ? (
    <>
      <div className="mhead">
        {title && <h2 className="modal-t" id={titleId}>{title}</h2>}
        <button type="button" className="mclose" aria-label={closeLabel} title={closeLabel} disabled={!dismissable} onClick={onClose}>×</button>
      </div>
      <div className="mbody">{children}</div>
      {footer && <div className="mfoot">{footer}</div>}
    </>
  ) : (
    <>
      {title && <h2 className="modal-t" id={titleId}>{title}</h2>}
      {children}
    </>
  );

  return (
    <div
      className="modal"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        // both ends of the click on the backdrop: a text selection dragged out of a field does not close it
        if (backdropClose && dismissable && downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      {as === "form"
        ? <form ref={card as React.RefObject<HTMLFormElement>} className={cls} style={style} onSubmit={onSubmit} {...a11y}>{body}</form>
        : <div ref={card as React.RefObject<HTMLDivElement>} className={cls} style={style} {...a11y}>{body}</div>}
    </div>
  );
}
