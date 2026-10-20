import Link from "next/link";

/** This internal data-dependent review surface is deliberately unavailable publicly. */
export default function InternalReviewUnavailable() {
  return <main className="mvp-shell">
    <h1>内部真实场次评审未收录</h1>
    <p>公开版不附原录音、转写、经营记录或内部验收样本。此页面不请求这些数据。</p>
    <Link href="/mvp">打开合成演示场景</Link>
  </main>;
}
