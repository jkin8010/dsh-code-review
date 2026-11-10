// @ts-ignore
export function normalize(value: any): any {
  const payload = value as any;
  return payload;
}

export function toStringValue(value: unknown): string {
  return String(value ?? '');
}
