import EmptyState from "@openuptime/ui/empty-state";

export default function EmptyStateDemo() {
  return (
    <div className="card">
      <EmptyState title="No monitors yet" description="Add a URL and we’ll check it every minute."
        action={<button className="btn primary">+ Add your first monitor</button>} />
    </div>
  );
}
