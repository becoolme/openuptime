/** Title row at the top of a page: heading and one line of context on the left, the page's actions on the right. */
export default function PageHeader({
  title, description, actions, level = 1, className = "", style, children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons and links; they wrap below the title on narrow screens. */
  actions?: React.ReactNode;
  /** 2 for a section header further down a page. */
  level?: 1 | 2;
  className?: string;
  style?: React.CSSProperties;
  /** Anything else under the description, such as a row of chips. */
  children?: React.ReactNode;
}) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <div className={`ph${className ? ` ${className}` : ""}`} style={style}>
      <div>
        <H>{title}</H>
        {description && <p className="muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="ph-actions">{actions}</div>}
    </div>
  );
}
