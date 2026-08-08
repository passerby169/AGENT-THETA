from __future__ import annotations

from pathlib import Path
from typing import Any

from .profiler import profile
from .readers import load_dataset
from .redactor import MAX_OUTPUT_BYTES, RULES, redact_rows
from .samplers import (
    annotate_sample_rows,
    column_sample,
    deterministic_sample,
    exceptional_sample,
)


DEFAULT_SAMPLE_SIZE = 10
MAX_SAMPLE_SIZE = 20
MAX_HEAD_SIZE = 10
EXCEPTIONAL_SAMPLE_SIZE = 3
COLUMN_SAMPLE_VALUES = 3


def explore_dataset(payload: dict[str, Any]) -> dict[str, Any]:
    path = Path(str(payload.get('filePath') or '')).resolve()
    if not path.is_file():
        raise FileNotFoundError(f'Dataset file not found: {path}')
    dataset_ref = str(payload.get('datasetRef') or '').strip()
    dataset_hash = str(payload.get('datasetHash') or '').strip()
    if not dataset_ref or not dataset_hash:
        raise ValueError('datasetRef and datasetHash are required')
    size = max(1, min(MAX_SAMPLE_SIZE, int(payload.get('sampleSize') or DEFAULT_SAMPLE_SIZE)))
    head_limit = max(1, min(MAX_HEAD_SIZE, int(payload.get('headLimit') or 5)))
    seed = str(payload.get('sampleSeed') or dataset_hash[:16])
    selected_columns = _selected_columns(payload.get('selectedColumns'))
    sheet_name = str(payload.get('sheetName') or '').strip() or None
    table = load_dataset(path, seed=seed, sheet_name=sheet_name)
    unknown_columns = [column for column in selected_columns if column not in table.columns]
    if unknown_columns:
        raise ValueError(f'Selected columns were not found: {unknown_columns}')
    sample_rows = deterministic_sample(table.rows, size, seed)
    analysis = profile(table.rows, table.columns)
    role_columns = _role_sample_columns(analysis['columnRoles'])
    column_sample_columns = selected_columns or role_columns
    row_output_columns = [*selected_columns, '_theta_sample_id'] if selected_columns else []
    head, head_redactions, head_truncated = redact_rows(
        annotate_sample_rows(table.head_rows[:head_limit], kind='head', seed=seed),
        selected_columns=row_output_columns,
        byte_budget=8 * 1024,
    )
    sample, sample_redactions, sample_output_truncated = redact_rows(
        annotate_sample_rows(sample_rows, kind='uniform', seed=seed),
        selected_columns=row_output_columns,
        byte_budget=20 * 1024,
    )
    exceptional, exceptional_redactions, exceptional_output_truncated = redact_rows(
        annotate_sample_rows(
            exceptional_sample(table.rows, EXCEPTIONAL_SAMPLE_SIZE),
            kind='exceptional',
            seed=seed,
        ),
        selected_columns=row_output_columns,
        byte_budget=5 * 1024,
    )
    columns, column_redactions, column_output_truncated = redact_rows(
        column_sample(
            table.rows,
            column_sample_columns[:8],
            values_per_column=COLUMN_SAMPLE_VALUES,
        ),
        selected_columns=column_sample_columns,
        byte_budget=5 * 1024,
    )
    quality_warnings = list(analysis['qualityWarnings'])
    if table.rows_truncated:
        quality_warnings.append(
            f'列统计基于确定性蓄水池样本（最多 {len(table.rows)} 行），完整行数仍为 {table.row_count}。'
        )
    output_truncated = any((
        head_truncated,
        sample_output_truncated,
        exceptional_output_truncated,
        column_output_truncated,
    ))
    if output_truncated:
        quality_warnings.append('展示样本已按单元格、单行或 50KB 输出预算截断。')
    return {
        'datasetRef': dataset_ref,
        'datasetHash': dataset_hash,
        'fileName': str(payload.get('fileName') or path.name),
        'format': table.suffix.lstrip('.'),
        'sizeBytes': int(payload.get('sizeBytes') or path.stat().st_size),
        'encoding': table.encoding,
        'delimiter': table.delimiter,
        'sheets': table.sheets,
        'selectedSheet': table.selected_sheet,
        'rowCount': table.row_count,
        'columns': table.columns,
        'profiles': analysis['profiles'],
        'head': head,
        'sample': sample,
        'exceptionalSample': exceptional,
        'columnSamples': columns,
        'sampleSeed': seed,
        'samplePolicy': {
            'method': 'deterministic_reservoir',
            'requestedRows': size,
            'returnedRows': len(sample),
            'profileRows': len(table.rows),
            'profileTruncated': table.rows_truncated,
        },
        'sampleTruncated': table.row_count > len(sample),
        'outputTruncated': output_truncated,
        'redaction': {
            'applied': head_redactions + sample_redactions + exceptional_redactions + column_redactions > 0,
            'redactedValueCount': head_redactions + sample_redactions + exceptional_redactions + column_redactions,
            'rules': list(RULES) + ['sensitive_column'],
        },
        'columnRoles': analysis['columnRoles'],
        'languageDistribution': analysis['languageDistribution'],
        'duplicateRatio': analysis['duplicateRatio'],
        'timeCoverage': analysis['timeCoverage'],
        'inferredDomain': analysis['inferredDomain'],
        'qualityWarnings': list(dict.fromkeys(quality_warnings)),
    }


def _selected_columns(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))[:50]


def _role_sample_columns(roles: dict[str, list[dict[str, Any]]]) -> list[str]:
    ordered = [
        *(item['name'] for item in roles.get('text', [])[:2]),
        *(item['name'] for item in roles.get('time', [])[:1]),
        *(item['name'] for item in roles.get('group', [])[:3]),
        *(item['name'] for item in roles.get('evaluation', [])[:2]),
    ]
    return list(dict.fromkeys(ordered))
