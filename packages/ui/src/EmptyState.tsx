/** The dashed box a list shows before it has anything in it: what is missing, why it matters, and the way to add one. */
export default function EmptyState({
  title, description, action, className = "", style,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Usually the primary button that creates the first item. */
  action?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`empty${className ? ` ${className}` : ""}`} style={style}>
      {title && <h3>{title}</h3>}
      {description && <p className="muted">{description}</p>}
      {action}
    </div>
  );
}
