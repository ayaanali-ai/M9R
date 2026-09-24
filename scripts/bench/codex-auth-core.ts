export function codexLoginStatusIsAuthenticated(status: number | null, output: string): boolean {
  const text = output.trim();
  return status === 0 && /\blogged in\b/i.test(text) && !/\bnot logged in\b/i.test(text);
}
