from __future__ import annotations

import re
from typing import Any


RULES = {
    'email': re.compile(r'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', re.IGNORECASE),
    'phone': re.compile(r'(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)'),
    'identity_number': re.compile(r'(?<!\d)\d{17}[\dXx](?!\d)'),
}


def redact_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    count = 0
    redacted: list[dict[str, Any]] = []
    for row in rows:
        next_row: dict[str, Any] = {}
        for key, value in row.items():
            if not isinstance(value, str):
                next_row[str(key)] = value
                continue
            next_value = value
            for name, pattern in RULES.items():
                next_value, replacements = pattern.subn(f'[REDACTED_{name.upper()}]', next_value)
                count += replacements
            next_row[str(key)] = next_value
        redacted.append(next_row)
    return redacted, count
