import type { ComponentType } from "react";

// Every file in src/demos is a live example for the export it is named after (Select.demo.tsx → Select).
const modules = import.meta.glob<{ default: ComponentType }>("../demos/*.demo.tsx", { eager: true });
export const demos = Object.fromEntries(Object.entries(modules).map(([p, m]) => [p.match(/([^/]+)\.demo\.tsx$/)![1], m.default]));

export default function Demo({ name }: { name: string }) {
  const C = demos[name];
  return C ? <C /> : null;
}
