from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from theta_agent_bridge.dataset.explorer import explore_dataset
from theta_agent_bridge.dataset.readers import load_dataset


class DatasetExplorerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='theta-dataset-explorer-')
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_large_csv_uses_bounded_deterministic_reservoir(self) -> None:
        path = self.root / 'large.csv'
        with path.open('w', encoding='utf-8', newline='') as handle:
            handle.write('id,text\n')
            for index in range(10050):
                handle.write(f'{index},record-{index}\n')

        first = load_dataset(path, seed='fixed-seed')
        second = load_dataset(path, seed='fixed-seed')

        self.assertEqual(first.row_count, 10050)
        self.assertEqual(len(first.rows), 5000)
        self.assertTrue(first.rows_truncated)
        self.assertEqual(first.rows, second.rows)
        self.assertEqual(first.head_rows[0]['id'], '0')

    def test_explore_redacts_secrets_and_bounds_remote_sample(self) -> None:
        path = self.root / 'sensitive.jsonl'
        records = [
            {
                'text': f'user-{index} email person{index}@example.com token sk-secretvalue{index:04d}',
                'account_name': f'person-{index}',
                'ip': '192.168.1.10',
            }
            for index in range(30)
        ]
        path.write_text(
            '\n'.join(json.dumps(record, ensure_ascii=False) for record in records),
            encoding='utf-8',
        )

        result = explore_dataset({
            'filePath': str(path),
            'datasetRef': 'dataset_test',
            'datasetHash': 'a' * 64,
            'sampleSize': 100,
            'selectedColumns': ['text', 'account_name', 'ip'],
        })

        self.assertEqual(result['samplePolicy']['requestedRows'], 20)
        self.assertLessEqual(len(result['sample']), 20)
        self.assertTrue(result['redaction']['applied'])
        serialized = json.dumps(result['head'] + result['sample'], ensure_ascii=False)
        self.assertNotIn('@example.com', serialized)
        self.assertNotIn('sk-secretvalue', serialized)
        self.assertNotIn('192.168.1.10', serialized)
        self.assertNotIn('person-0', serialized)
        self.assertLessEqual(len(serialized.encode('utf-8')), 50 * 1024)

    def test_unknown_selected_column_is_rejected(self) -> None:
        path = self.root / 'dataset.csv'
        path.write_text('text\nhello\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Selected columns were not found'):
            explore_dataset({
                'filePath': str(path),
                'datasetRef': 'dataset_test',
                'datasetHash': 'b' * 64,
                'selectedColumns': ['missing'],
            })


if __name__ == '__main__':
    unittest.main()
