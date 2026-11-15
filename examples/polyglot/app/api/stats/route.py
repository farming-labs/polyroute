import statistics

from polyroute import Request, Response


def POST(request: Request) -> Response:
    numbers = request.json()
    if (
        not isinstance(numbers, list)
        or not numbers
        or not all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in numbers)
    ):
        return Response.json({"error": "Send a non-empty JSON array of numbers."}, status=400)
    return Response.json(
        {
            "count": len(numbers),
            "mean": statistics.fmean(numbers),
            "median": statistics.median(numbers),
        }
    )
