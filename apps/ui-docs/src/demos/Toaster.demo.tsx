import Toaster from "@openuptime/ui/toaster";
import { toast } from "@openuptime/ui/toast";

export default function ToasterDemo() {
  return (
    <div className="demo-row">
      <Toaster />
      <button className="btn sm" onClick={() => toast("Monitor saved")}>toast()</button>
      <button className="btn sm" onClick={() => toast("Check failed: timeout", "err")}>kind "err"</button>
      <button className="btn sm" onClick={() => toast("Monitor paused", "ok", { action: { label: "Undo", run: () => toast("Resumed") } })}>with action</button>
      <button className="btn sm" onClick={() => toast("Stays until closed", "ok", { sticky: true })}>sticky</button>
      <button className="btn sm" onClick={() => toast(`Saved at ${new Date().toLocaleTimeString()}`, "ok", { key: "save" })}>same key replaces</button>
    </div>
  );
}
