/** Validation-only projection; the frozen prediction model remains unchanged. */
export function expectedHalfFullDistribution(points, parameters = {}) {
  const input = parameters.firstHalfGoalShare;
  if (input !== undefined && (typeof input !== "number" || !Number.isFinite(input)))
    throw new Error("半全场模型参数无效");
  const share = Math.max(.35, Math.min(.55, input || .45));
  const outcome = (h, a) => h > a ? 0 : h === a ? 1 : 2;
  const values = Array(9).fill(0);
  // Use the closed-form binomial PMF, independently of the model recurrence.
  const binomial = (n, k) => {
    let choose = 1;
    for (let i = 1; i <= k; i++) choose = choose * (n - i + 1) / i;
    return choose * share ** k * (1 - share) ** (n - k);
  };
  for (const point of points) {
    const [home, away] = point.score.split(":").map(Number);
    for (let h = 0; h <= home; h++) for (let a = 0; a <= away; a++)
      values[outcome(h, a) * 3 + outcome(home, away)] += point.probability * binomial(home, h) * binomial(away, a);
  }
  return values;
}
