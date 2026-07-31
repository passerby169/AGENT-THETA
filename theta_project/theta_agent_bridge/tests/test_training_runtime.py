from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from theta_agent_bridge import bridge


class TrainingRuntimeRecoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="theta-runtime-test-")
        root = Path(self.temp.name)
        self.state_dir_patch = patch.object(bridge, "STATE_DIR", root)
        self.state_db_patch = patch.object(
            bridge, "STATE_DB_PATH", root / "state.sqlite"
        )
        self.runs_dir_patch = patch.object(bridge, "RUNS_DIR", root / "runs")
        self.spawn_patch = patch.object(
            bridge, "spawn_training_runner", return_value=999_999_991
        )
        for active_patch in (
            self.state_dir_patch,
            self.state_db_patch,
            self.runs_dir_patch,
            self.spawn_patch,
        ):
            active_patch.start()

    def tearDown(self) -> None:
        patch.stopall()
        self.temp.cleanup()

    def training_payload(self, idempotency_key: str) -> dict:
        plan_id = "plan_" + "1" * 16
        plan_hash = "2" * 64
        plan_review_id = "approval_" + "3" * 20
        training_review_id = "approval_" + "4" * 20
        dry_run_hash = "5" * 64
        return {
            "plan": {"planId": plan_id, "planHash": plan_hash},
            "planReview": {
                "approvalId": plan_review_id,
                "approvalType": "human_plan_review",
                "planId": plan_id,
                "planHash": plan_hash,
            },
            "dryRun": {
                "dryRunHash": dry_run_hash,
                "planId": plan_id,
                "planHash": plan_hash,
                "planReviewApprovalId": plan_review_id,
                "passed": True,
                "commands": [
                    {
                        "step": "simulate",
                        "cwd": self.temp.name,
                        "argv": ["python", "-c", "print('ok')"],
                        "sideEffect": "external_effect",
                    }
                ],
                "expectedArtifacts": [],
            },
            "trainingReview": {
                "approvalId": training_review_id,
                "approvalType": "human_training_review",
                "planId": plan_id,
                "planHash": plan_hash,
                "dryRunHash": dry_run_hash,
            },
            "idempotencyKey": idempotency_key,
        }

    def test_missing_runner_is_quarantined_and_failed_retry_is_explicit(self) -> None:
        first = bridge.training_start(self.training_payload("runtime-recovery"))
        repeated = bridge.training_start(self.training_payload("runtime-recovery"))
        self.assertEqual(repeated["trainingRunId"], first["trainingRunId"])
        self.assertEqual(repeated["status"], "quarantined")
        status = bridge.training_status({"trainingRunId": first["trainingRunId"]})
        self.assertEqual(status["status"], "quarantined")
        self.assertIn("runner is absent", status["receipt"]["quarantineReason"])

        source = bridge.training_start(self.training_payload("runtime-retry-source"))
        with bridge.connect_state_db() as conn:
            bridge.init_state_db(conn)
            conn.execute(
                """
                UPDATE training_runs
                SET status = 'failed', error_message = 'simulated failure'
                WHERE training_run_id = ?
                """,
                (source["trainingRunId"],),
            )

        with self.assertRaisesRegex(ValueError, "new idempotencyKey"):
            bridge.training_start(self.training_payload("runtime-retry-source"))

        retry_payload = self.training_payload("runtime-retry-attempt-2")
        retry_payload["retryOfTrainingRunId"] = source["trainingRunId"]
        retry_payload["retryReason"] = "Operator approved a corrected retry."
        retry = bridge.training_start(retry_payload)
        self.assertEqual(retry["attempt"], 2)
        self.assertEqual(retry["retryOfTrainingRunId"], source["trainingRunId"])

    def test_expected_artifacts_follow_dtm_preparation_layout(self) -> None:
        dtm_artifacts = bridge.expected_training_artifacts(
            {
                "datasetId": "dataset",
                "modelId": "dtm",
                "userId": "local_user",
            }
        )
        self.assertEqual(
            dtm_artifacts[0]["path"],
            "THETA/result/baseline/dataset/data",
        )
        self.assertEqual(
            dtm_artifacts[1]["path"],
            "THETA/result/local_user/dataset/dtm",
        )

        baseline_artifacts = bridge.expected_training_artifacts(
            {
                "datasetId": "dataset",
                "modelId": "btm",
                "userId": "local_user",
            }
        )
        self.assertEqual(
            baseline_artifacts[0]["path"],
            "THETA/data/workspace/dataset/local_user",
        )


if __name__ == "__main__":
    unittest.main()
