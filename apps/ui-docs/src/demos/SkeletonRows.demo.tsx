import { SkeletonRows } from "@openuptime/ui/skeleton";

export default function SkeletonRowsDemo() {
  return (
    <div className="card demo-table">
      <SkeletonRows cols={3} rows={3} rowClassName="demo-tr" />
    </div>
  );
}
