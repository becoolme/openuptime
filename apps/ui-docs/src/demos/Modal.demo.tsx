import { useState } from "react";
import Modal from "@openuptime/ui/modal";

export default function ModalDemo() {
  const [open, setOpen] = useState<"" | "plain" | "form">("");
  const [name, setName] = useState("Checkout API");
  return (
    <div className="demo-row">
      <button className="btn" onClick={() => setOpen("plain")}>Open a plain dialog</button>
      <button className="btn primary" onClick={() => setOpen("form")}>Open a sectioned form</button>
      <span className="muted mono">name: {name}</span>
      {open === "plain" && (
        <Modal as="form" title="Rename monitor" onClose={() => setOpen("")} onSubmit={(e) => { e.preventDefault(); setOpen(""); }}>
          <label className="fld">Name<input className="in" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="acts" style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
            <button type="button" className="btn" onClick={() => setOpen("")}>Cancel</button>
            <button className="btn primary">Save</button>
          </div>
        </Modal>
      )}
      {open === "form" && (
        <Modal as="form" title="New monitor" closeLabel="Close" backdropClose={false} onClose={() => setOpen("")}
          onSubmit={(e) => { e.preventDefault(); setOpen(""); }}
          footer={<div style={{ display: "flex", gap: 10, justifyContent: "flex-end", width: "100%" }}>
            <button type="button" className="btn" onClick={() => setOpen("")}>Cancel</button>
            <button className="btn primary">Create</button>
          </div>}>
          <label className="fld">Name<input className="in" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="fld">URL<input className="in mono" placeholder="https://example.com/health" /></label>
          <p className="faint">Escape or × closes it; clicking outside does not, so a long form is not lost by accident.</p>
        </Modal>
      )}
    </div>
  );
}
