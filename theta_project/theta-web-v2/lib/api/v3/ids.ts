export const createClientId = (prefix: 'command' | 'message'): string => {
  const value = globalThis.crypto?.randomUUID?.();
  if (value) return `${prefix}.${value}`;
  return `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
};
