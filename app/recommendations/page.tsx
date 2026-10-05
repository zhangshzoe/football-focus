import SiteShell from "../components/SiteShell";
import TodayRecommendations from "../components/TodayRecommendations";
import ScreenshotRecommendations from "../components/ScreenshotRecommendations";

export default function RecommendationsPage() {
  return (
    <SiteShell view="recommendations">
      <section className="warning">
        <span>理性参与</span>
        历史模拟不代表未来收益。只使用能够承受全部损失的娱乐预算。
      </section>
      <ScreenshotRecommendations />
      <TodayRecommendations />
    </SiteShell>
  );
}
