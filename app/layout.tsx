import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./extras.css";
import "./markets.css";
import "./detail.css";
import "./fund-tool.css";
import "./sky-field.css";
import "./density.css";
import "./ai-detail.css";
import "./reference-ui.css";
import "./mobile-ui.css";
import BrowserStorageNotice from "./components/BrowserStorageNotice";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "竞彩研习室｜个人足球研究与复盘",
  description: "个人使用的足球竞彩研究、组合模拟与投注复盘工具。",
  applicationName: "竞彩研习室",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "竞彩研习室",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#eaf7fd",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <BrowserStorageNotice />
      </body>
    </html>
  );
}
