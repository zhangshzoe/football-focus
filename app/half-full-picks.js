const labels = ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"];
export function topHalfFullPicks(values) {
  if (!Array.isArray(values) || values.length !== 9 || values.some(value => !Number.isFinite(value) || value < 0 || value > 100)) return [];
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) > 0.1) return [];
  return values.map((probability, index) => ({label: labels[index], probability, index}))
    .sort((a, b) => b.probability - a.probability || a.index - b.index).slice(0, 2);
}
