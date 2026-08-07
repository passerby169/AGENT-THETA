from __future__ import annotations

from pathlib import Path
from typing import Any

from .profiler import profile
from .readers import load_dataset
from .redactor import RULES, redact_rows
from .samplers import deterministic_sample


MAX_SAMPLE_SIZE = 100


def explore_dataset(payload: dict[str, Any]) -> dict[str, Any]:
    path = Path(str(payload.get('filePath') or '')).resolve()
    if not path.is_file():
        raise FileNotFoundError(f'Dataset file not found: {path}')
    dataset_ref = str(payload.get('datasetRef') or '').strip()
    dataset_hash = str(payload.get('datasetHash') or '').strip()
    if not dataset_ref or not dataset_hash:
        raise ValueError('datasetRef and datasetHash are required')
    size = max(1, min(MAX_SAMPLE_SIZE, int(payload.get('sampleSize') or 20)))
    seed = str(payload.get('sampleSeed') or dataset_hash[:16])
    table = load_dataset(path)
    head, head_redactions = redact_rows(table.rows[: min(5, size)])
    sample, sample_redactions = redact_rows(deterministic_sample(table.rows, size, seed))
    analysis = profile(table.rows, table.columns)
    return {
        'datasetRef': dataset_ref,
        'datasetHash': dataset_hash,
        'fileName': str(payload.get('fileName') or path.name),
        'format': table.suffix.lstrip('.'),
        'sizeBytes': int(payload.get('sizeBytes') or path.stat().st_size),
        'rowCount': table.row_count,
        'columns': table.columns,
        'profiles': analysis['profiles'],
        'head': head,
        'sample': sample,
        'sampleSeed': seed,
        'sampleTruncated': table.row_count > len(sample),
        'redaction': {
            'applied': head_redactions + sample_redactions > 0,
            'redactedValueCount': head_redactions + sample_redactions,
            'rules': list(RULES),
        },
        'columnRoles': analysis['columnRoles'],
        'languageDistribution': analysis['languageDistribution'],
        'duplicateRatio': analysis['duplicateRatio'],
        'timeCoverage': analysis['timeCoverage'],
        'inferredDomain': analysis['inferredDomain'],
        'qualityWarnings': analysis['qualityWarnings'],
    }
