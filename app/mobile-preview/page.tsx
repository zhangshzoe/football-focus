"use client";

import { useState } from "react";

const previews = [
  { href: "/matches", label: "今日比赛" },
  { href: "/predictions", label: "AI预测" },
  { href: "/market-predictions", label: "盘口预测" },
  { href: "/recommendations", label: "今日推荐" },
  { href: "/prediction-archive", label: "盘后回溯" },
];

export default function MobilePreviewPage() {
  const [route, setRoute] = useState(previews[0].href);

  return (
    <main className="mobile-preview-page">
      <header className="mobile-preview-header">
        <div>
          <small>MOBILE PREVIEW</small>
          <h1>手机端预览</h1>
          <p>以常用手机宽度检查真实页面；预览高度随窗口调整，页面内可继续滚动。</p>
        </div>
        <a href={route} target="_blank" rel="noreferrer">
          在新窗口打开
        </a>
      </header>

      <nav className="mobile-preview-tabs" aria-label="选择预览页面">
        {previews.map((item) => (
          <button
            type="button"
            key={item.href}
            className={route === item.href ? "active" : ""}
            onClick={() => setRoute(item.href)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="mobile-preview-workspace">
        <div className="phone-frame" aria-label="手机页面预览">
          <div className="phone-speaker" aria-hidden="true" />
          <iframe key={route} src={route} title={`${previews.find((item) => item.href === route)?.label}手机预览`} />
        </div>
        <aside>
          <h2>手机访问方式</h2>
          <ol>
            <li>发布后在手机浏览器打开站点地址。</li>
            <li>登录同一账号即可访问私有站点。</li>
            <li>浏览器菜单中选择“添加到主屏幕”，可获得接近 App 的入口。</li>
          </ol>
          <p>竞彩数据仍以官方销售状态和更新时间为准；移动版不会缓存或补造赔率。</p>
        </aside>
      </section>
    </main>
  );
}
