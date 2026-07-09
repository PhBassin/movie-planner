export function parseStrictInt(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return NaN;
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : NaN;
  }

  const strValue = String(value).trim();

  if (!/^-?\d+$/.test(strValue)) {
    return NaN;
  }

  const parsed = Number(strValue);

  if (!Number.isSafeInteger(parsed)) {
    return NaN;
  }

  return parsed;
}
