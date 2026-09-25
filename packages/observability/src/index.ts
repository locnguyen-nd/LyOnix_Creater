export const redact = (value: string, visibleCharacters = 4): string =>
  value.length <= visibleCharacters ? "••••" : `${value.slice(0, visibleCharacters)}••••`;
