export function randomDelay(minMs: number, maxMs: number, verbose = false): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  if (verbose) {
    console.log(`⏳ Esperando ${delay}ms para evitar bloqueos...`);
  }
  return new Promise(resolve => setTimeout(resolve, delay));
}
