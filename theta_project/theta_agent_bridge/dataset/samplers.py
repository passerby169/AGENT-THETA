from __future__ import annotations

import hashlib
import random
from typing import Any


def deterministic_sample(
    rows: list[dict[str, Any]], size: int, seed: str
) -> list[dict[str, Any]]:
    if size <= 0 or not rows:
        return []
    limit = min(size, len(rows))
    seed_value = int(hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16], 16)
    indices = sorted(random.Random(seed_value).sample(range(len(rows)), limit))
    return [rows[index] for index in indices]
