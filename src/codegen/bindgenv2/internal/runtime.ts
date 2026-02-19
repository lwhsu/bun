export function invariant(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function inspect(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
