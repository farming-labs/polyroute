export async function POST(request: Request): Promise<Response> {
  const numbers: unknown = await request.json();
  if (
    !Array.isArray(numbers) ||
    numbers.length === 0 ||
    !numbers.every((value): value is number => typeof value === "number" && Number.isFinite(value))
  ) {
    return Response.json({ error: "Send a non-empty JSON array of numbers." }, { status: 400 });
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return Response.json({ count: numbers.length, mean, median });
}
