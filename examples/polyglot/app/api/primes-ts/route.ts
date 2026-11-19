// The same trial-division workload as the Rust route, for paired benchmarks.
export function GET(request: Request): Response {
  const value = new URL(request.url).searchParams.get("limit");
  const parsed = value !== null && /^\+?\d+$/.test(value) ? Number(value) : NaN;
  const limit = Math.min(
    Number.isInteger(parsed) && parsed <= 0xffff_ffff ? parsed : 10_000,
    5_000_000,
  );
  let primes = 0;
  for (let candidate = 2; candidate < limit; candidate++) {
    let prime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
      if (candidate % divisor === 0) {
        prime = false;
        break;
      }
    }
    if (prime) primes++;
  }
  return Response.json({ limit, primes });
}
