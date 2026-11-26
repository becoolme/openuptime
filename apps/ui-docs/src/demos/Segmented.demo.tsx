import { useState } from "react";
import Segmented from "@openuptime/ui/segmented";

export default function SegmentedDemo() {
  const [theme, setTheme] = useState<"light" | "dark" | "auto">("auto");
  const [every, setEvery] = useState(300);
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 420 }}>
      <div className="fld">Theme
        <Segmented label="Theme" value={theme} onChange={setTheme}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "auto", label: "Auto" }]} />
      </div>
      <div className="fld">Check every
        <Segmented label="Check every" value={every} onChange={setEvery} options={[
          { value: 30, label: "30 seconds", locked: true, title: "Not available on your plan" },
          { value: 60, label: "1 minute", dim: true, title: "Needs a paid plan" },
          { value: 300, label: "5 minutes" },
          { value: 900, label: "15 minutes" },
        ]} />
      </div>
      <span className="muted mono">value: {theme} / {every}s</span>
    </div>
  );
}
