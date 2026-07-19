const ALLOCINE_URL_PREFIX = 'https://www.allocine.fr/';

export function isAllocineUrl(url: string): boolean {
  return url.startsWith(ALLOCINE_URL_PREFIX);
}

export function validateName(value: string): string | undefined {
  if (!value.trim()) return 'Name is required';
  if (value.trim().length > 100) return 'Name must be at most 100 characters';
  return undefined;
}

export function validateUrl(value: string): string | undefined {
  if (!value.trim()) return undefined;
  if (!isAllocineUrl(value)) return 'Must be an Allocine URL (https://www.allocine.fr/...)';
  if (value.length > 2048) return 'URL must be at most 2048 characters';
  return undefined;
}

export function validateAddress(value: string): string | undefined {
  if (value.trim() && value.length > 200) return 'Address must be at most 200 characters';
  return undefined;
}

export function validatePostalCode(value: string): string | undefined {
  if (value.trim()) {
    if (value.length > 10) return 'Postal code must be at most 10 characters';
    if (!/^[a-zA-Z0-9]+$/.test(value)) return 'Postal code must be alphanumeric';
  }
  return undefined;
}

export function validateCity(value: string): string | undefined {
  if (value.trim() && value.length > 100) return 'City must be at most 100 characters';
  return undefined;
}
