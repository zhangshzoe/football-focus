// Asian prices are Hong Kong (net) odds. Quarter lines split the stake equally.
// This pricing layer is separate from the score probability model.
export function optionalNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validAsianLine(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value * 4 - Math.round(value * 4)) < 1e-8
  );
}

export function splitAsianLine(line) {
  if (!validAsianLine(line)) throw new Error("Invalid Asian quarter-goal line");
  const quarters = Math.round(line * 4);
  return Math.abs(quarters % 2) === 1
    ? [Math.floor(quarters / 2) / 2, Math.ceil(quarters / 2) / 2]
    : [quarters / 4];
}

export function asianSettlement(value, line, kind = "handicap") {
  if (!Number.isFinite(value) || !["handicap", "total"].includes(kind)) {
    throw new Error("Invalid Asian settlement input");
  }
  const parts = splitAsianLine(line);
  const result = { win: 0, push: 0, loss: 0 };
  for (const part of parts) {
    const margin = kind === "handicap" ? value + part : value - part;
    result[margin > 0 ? "win" : margin < 0 ? "loss" : "push"] += 1 / parts.length;
  }
  return result;
}

export function asianNetReturn(value, line, netOdds, kind = "handicap") {
  if (!(netOdds > 0) || !Number.isFinite(netOdds)) throw new Error("Invalid net odds");
  const result = asianSettlement(value, line, kind);
  return result.win * netOdds - result.loss;
}

export function deVig(odds, count = odds?.length) {
  if (
    !Array.isArray(odds) ||
    odds.length !== count ||
    !odds.length ||
    !odds.every((value) => typeof value === "number" && Number.isFinite(value) && value > 1)
  )
    return null;
  const inverse = odds.map((value) => 1 / value);
  const sum = inverse.reduce((a, b) => a + b, 0);
  return inverse.map((value) => value / sum);
}

export function asianMarketTarget(firstPrice, secondPrice) {
  if (!(firstPrice > 0) || !(secondPrice > 0)) return null;
  return deVig([1 + firstPrice, 1 + secondPrice], 2)?.[0] ?? null;
}

export function priceAsianDistribution(points, line, kind = "handicap") {
  let win = 0,
    loss = 0,
    push = 0,
    mass = 0;
  for (const point of points) {
    const result = asianSettlement(point.value, line, kind);
    if (!Number.isFinite(point.probability) || point.probability < 0)
      throw new Error("Invalid probability");
    mass += point.probability;
    win += result.win * point.probability;
    loss += result.loss * point.probability;
    push += result.push * point.probability;
  }
  if (!(mass > 0)) throw new Error("Empty distribution");
  return {
    win: win / mass,
    loss: loss / mass,
    push: push / mass,
    riskProbability: win + loss > 0 ? win / (win + loss) : null,
    fairNetOdds: win > 0 ? loss / win : null,
  };
}
