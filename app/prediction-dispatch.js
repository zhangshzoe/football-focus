const JOB_ID = /^prediction-[a-f0-9]{64}$/;

// Caller selects a lane and cursor, never the trusted build hash or a clock.
export function parsePredictionDispatchQuery(url) {
  const params = new URL(url).searchParams;
  if (
    [...params.keys()].some((key) => !["kind", "namespace", "limit", "cursor"].includes(key)) ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)
  )
    throw new TypeError("INVALID_DISPATCH_QUERY");
  const kind = params.get("kind"),
    namespace = params.get("namespace") || "official";
  const rawLimit = params.get("limit") || "25";
  if (
    !/^(?:[1-9]|1[0-9]|2[0-5])$/.test(rawLimit) ||
    !["unit", "batch"].includes(kind) ||
    !["official", "research"].includes(namespace) ||
    (kind === "batch" && namespace !== "official")
  )
    throw new TypeError("INVALID_DISPATCH_QUERY");
  const rawCursor = params.get("cursor");
  if (rawCursor && rawCursor.length > 256) throw new TypeError("INVALID_DISPATCH_CURSOR");
  const after = rawCursor ? JSON.parse(rawCursor) : null;
  if (
    after !== null &&
    (!after ||
      Array.isArray(after) ||
      Object.keys(after).length !== 2 ||
      !Number.isSafeInteger(after.createdAtEpoch) ||
      after.createdAtEpoch < 0 ||
      typeof after.id !== "string" ||
      !JOB_ID.test(after.id))
  )
    throw new TypeError("INVALID_DISPATCH_CURSOR");
  return { kind, namespace, limit: Number(rawLimit), after };
}
