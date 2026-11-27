/**
 * A small "?" beside a form label. The explanation shows on hover or keyboard focus, so the form itself stays short.
 * The text is also the icon's accessible name, which screen readers announce with the label.
 */
export default function Hint({ text }: { text: string }) {
  return <span className="info" tabIndex={0} role="img" aria-label={text} data-tip={text} onClick={(e) => e.preventDefault()}>?</span>;
}
