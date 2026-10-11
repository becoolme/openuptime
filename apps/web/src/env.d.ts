/// <reference path="../.astro/types.d.ts" />
declare namespace App {
  interface Locals {
    lang?: "en" | "zh-CN";
  }
}

declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
