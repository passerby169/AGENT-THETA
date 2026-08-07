from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


SUPPORTED_SUFFIXES = {'.csv', '.tsv', '.txt', '.json', '.jsonl', '.xlsx', '.xls', '.parquet'}


@dataclass
class DatasetReader:
    path: Path
    suffix: str
    columns: list[str]
    encoding: str
    delimiter: str | None
    row_count: int
    rows: list[dict[str, Any]]


def load_dataset(path: Path) -> DatasetReader:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise ValueError(f"Unsupported dataset suffix '{suffix}'. Supported: {sorted(SUPPORTED_SUFFIXES)}")
    if suffix in {'.xlsx', '.xls', '.parquet'}:
        return _load_dataframe(path, suffix)
    text, encoding = _read_text(path)
    if suffix in {'.csv', '.tsv'}:
        delimiter = '\t' if suffix == '.tsv' else _sniff_delimiter(text)
        reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
        columns = [str(value).strip() for value in (reader.fieldnames or [])]
        rows = [
            {str(key).strip(): value for key, value in row.items() if key is not None}
            for row in reader
        ]
        return DatasetReader(path, suffix, columns, encoding, delimiter, len(rows), rows)
    if suffix == '.jsonl':
        rows = []
        columns: set[str] = set()
        for line in text.splitlines():
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError('JSONL records must be objects')
            rows.append(value)
            columns.update(str(key) for key in value)
        return DatasetReader(path, suffix, sorted(columns), encoding, None, len(rows), rows)
    if suffix == '.json':
        value = json.loads(text)
        records = value.get('data') or value.get('records') or value.get('items') if isinstance(value, dict) else value
        if not isinstance(records, list):
            raise ValueError('JSON dataset must be a list or contain data/records/items')
        rows = [item for item in records if isinstance(item, dict)]
        columns = sorted({str(key) for row in rows for key in row})
        return DatasetReader(path, suffix, columns, encoding, None, len(rows), rows)
    rows = [{'text': line.strip()} for line in text.splitlines() if line.strip()]
    return DatasetReader(path, suffix, ['text'], encoding, None, len(rows), rows)


def _load_dataframe(path: Path, suffix: str) -> DatasetReader:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError(
            f"Reading {suffix} requires the optional pandas adapter and its format engine."
        ) from exc
    if suffix == '.parquet':
        frame = pd.read_parquet(path)
    else:
        frame = pd.read_excel(path)
    frame = frame.where(frame.notna(), None)
    rows = frame.to_dict(orient='records')
    return DatasetReader(
        path,
        suffix,
        [str(column) for column in frame.columns],
        'binary',
        None,
        len(rows),
        rows,
    )


def _read_text(path: Path) -> tuple[str, str]:
    for encoding in ('utf-8-sig', 'utf-8', 'gb18030', 'gbk', 'latin-1'):
        try:
            return path.read_text(encoding=encoding), encoding
        except UnicodeDecodeError:
            continue
    raise ValueError(f'Unable to decode dataset: {path.name}')


def _sniff_delimiter(text: str) -> str:
    try:
        return csv.Sniffer().sniff('\n'.join(text.splitlines()[:20]), delimiters=',\t;|').delimiter
    except csv.Error:
        return ','
