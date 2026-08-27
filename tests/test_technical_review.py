import unittest

from video_factory.technical_review import target_duration_tolerance


class TechnicalReviewPolicyTest(unittest.TestCase):
    def test_short_video_duration_tolerance_preserves_natural_narration(self):
        self.assertEqual(target_duration_tolerance(8), 2.0)
        self.assertAlmostEqual(target_duration_tolerance(24), 4.8)


if __name__ == "__main__":
    unittest.main()
