/// <reference types="vite/client" />

// Keep Worker bindings typed without replacing the browser DOM's global types.
// Sites injects the real DB binding; this declaration does not provision it.
declare module "cloudflare:workers" {
  export const env: {
    DB?: import("@cloudflare/workers-types/index").D1Database;
    RESEARCH_OBJECTS?: import("@cloudflare/workers-types/index").R2Bucket;
    RESEARCH_CAPTURE_TOKEN?: string;
    PREDICTION_OPERATOR_EMAIL?: string;
  };
}

declare const __FF_FORWARD_CODE_HASHES__: Record<string, string>;
