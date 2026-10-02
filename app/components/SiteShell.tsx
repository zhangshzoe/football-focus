import type { ReactNode } from "react";
import ArchiveNavLink from "./ArchiveNavLink";

type SiteView =
  "matches" | "predictions" | "market-predictions" | "recommendations" | "prediction-archive";

const navigation = [
  { view: "matches", href: "/matches", icon: "▣", label: "今日比赛" },
  { view: "predictions", href: "/predictions", icon: "◉", label: "AI预测" },
  { view: "market-predictions", href: "/market-predictions", icon: "◆", label: "盘口预测" },
  { view: "recommendations", href: "/recommendations", icon: "★", label: "今日推荐" },
] as const;

/** Shared presentation only: each page owns its requests, records and effects. */
export default function SiteShell({ view, children }: { view: SiteView; children: ReactNode }) {
  return (
    <main className={`view-${view}`}>
      <div className="sky-shell">
        <header className="site-intro">
          <a className="brand" href="/matches">
            <span>球</span>
            <span className="brand-copy">
              <b>竞彩研习室</b>
              <small>理性分析 · 数据研究 · 提升认知</small>
            </span>
          </a>
          <div className="top-utility">
            <a className="mobile-preview-link" href="/mobile-preview">
              手机预览
            </a>
            <span className="avatar" aria-hidden="true">
              ●
            </span>
          </div>
        </header>
        <div className="topbar compact-nav">
          <nav aria-label="主要页面">
            {navigation.map((item) => (
              <a
                key={item.view}
                href={item.href}
                className={view === item.view ? "active" : undefined}
                aria-current={view === item.view ? "page" : undefined}
              >
                <span aria-hidden="true">{item.icon}</span>
                <b>{item.label}</b>
              </a>
            ))}
            <ArchiveNavLink active={view === "prediction-archive"} />
          </nav>
        </div>
      </div>
      {children}
      <footer className="site-footer">
        <span>竞彩研习室 · 个人研究版</span>
        <span>正式记录保留采集时刻；手动试算独立留档</span>
      </footer>
    </main>
  );
}
