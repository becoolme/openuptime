import PageHeader from "@openuptime/ui/page-header";

export default function PageHeaderDemo() {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <PageHeader title="Monitors" description="Everything is up."
        actions={<><button className="btn">Import</button><button className="btn primary">+ New monitor</button></>} />
      <PageHeader level={2} title="Authorized agents" description="Apps you let manage your workspace on your behalf." />
    </div>
  );
}
