import { env } from "cloudflare:workers";
import { cloudResearchStore } from "./cloud-research-store.js";

export const getCloudResearchStore = () => cloudResearchStore({ database: env.DB, objects: env.RESEARCH_OBJECTS });
