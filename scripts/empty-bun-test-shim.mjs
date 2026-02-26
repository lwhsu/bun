export function expect(value) {
  return {
    toEndWith(suffix) {
      const text = String(value ?? "");
      const end = String(suffix ?? "");
      if (!text.endsWith(end)) {
        throw new Error(`expected "${text}" to end with "${end}"`);
      }
    },
  };
}
