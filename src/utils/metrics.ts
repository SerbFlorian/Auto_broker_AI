export const metrics = {
  httpRequests: 0,
  proxyFallbacks: 0,
  playwrightRequests: 0,
  playwrightNavigations: 0,
};

export function incr(key: keyof typeof metrics, n = 1) {
  if (metrics[key] !== undefined) metrics[key] += n as any;
}

export function report() {
  return { ...metrics };
}
