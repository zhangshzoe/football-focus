import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "竞彩研习室｜个人足球研究与复盘",
    short_name: "竞彩研习室",
    description: "赛程、赔率模型、AI复核、今日推荐与盘后回溯。",
    start_url: "/matches",
    display: "standalone",
    background_color: "#eef8fb",
    theme_color: "#eaf7fd",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ],
  };
}
