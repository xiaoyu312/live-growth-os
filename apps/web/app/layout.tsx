import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";
import "./advice.css";
import "./mvp.css";

export const metadata: Metadata = {
  title: "Live Growth OS｜实时驾驶舱",
  description: "直播经营确定性模拟与实时状态驾驶舱"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><body>{children}</body></html>;
}
