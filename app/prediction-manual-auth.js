// The Sites dispatcher supplies verified identity headers. Anonymous visitors
// and other signed-in users cannot execute shared prediction computations.
export function authorizedManualPrediction(request, operatorEmail) {
  if (typeof operatorEmail !== "string" || !operatorEmail.trim()) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return !!request.headers.get("oai-authenticated-user-id") &&
    request.headers.get("oai-authenticated-user-email")?.toLowerCase() === operatorEmail.trim().toLowerCase();
}
