import json
import sys

from .bridge import handle_request


def main() -> None:
    # Windows PowerShell may prefix redirected UTF-8 text with a BOM. Treat it
    # as transport encoding metadata, not as part of the JSON document.
    raw = sys.stdin.read().lstrip("\ufeff")
    try:
        request = json.loads(raw) if raw.strip() else {}
        response = handle_request(request)
    except Exception as exc:  # Keep the bridge protocol stable on unexpected errors.
        response = {
            "status": "error",
            "error": {
                "type": exc.__class__.__name__,
                "message": str(exc),
            },
        }

    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
