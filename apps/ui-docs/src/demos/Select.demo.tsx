import { useState } from "react";
import Select from "@openuptime/ui/select";

export default function SelectDemo() {
  const [region, setRegion] = useState("eu");
  const [range, setRange] = useState(24);
  const regions = [{ value: "eu", label: "Europe" }, { value: "us", label: "United States" }, { value: "ap", label: "Asia Pacific" }];
  const ranges = [{ value: 1, label: "Last hour" }, { value: 24, label: "Last 24 hours" }, { value: 168, label: "Last 7 days" }];
  return (
    <div className="demo-row">
      <label className="fld" style={{ width: 240 }}>Region<Select className="in" value={region} options={regions} onChange={setRegion} /></label>
      <Select compact label="Time range" value={range} options={ranges} onChange={setRange} />
      <span className="muted mono">value: {region} / {range}</span>
    </div>
  );
}
