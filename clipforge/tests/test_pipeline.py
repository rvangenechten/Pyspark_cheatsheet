"""Unit tests for the parts of the pipeline that do not need ffmpeg or models.

Run: python -m unittest discover -s clipforge/tests -t clipforge
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from clipforge import captions, render, score, segment, transcribe
from clipforge.model import Clip, Word
from clipforge.pipeline import Settings, select_clips, slugify, suggested_caption, words_in


def words_from(text: str, start: float = 0.0, wps: float = 2.8) -> list[Word]:
    """Build a synthetic word stream at a fixed rate."""
    step = 1.0 / wps
    out = []
    t = start
    for token in text.split():
        out.append(Word(text=token, start=round(t, 3), end=round(t + step * 0.9, 3)))
        t += step
    return out


class TestSegment(unittest.TestCase):
    def test_splits_on_terminal_punctuation(self):
        words = words_from("First one here. Second one here. Third one here.")
        sentences = segment.to_sentences(words)
        self.assertEqual(len(sentences), 3)
        self.assertTrue(sentences[0].text.endswith("here."))

    def test_splits_on_long_pause(self):
        words = [
            Word("no", 0.0, 0.4),
            Word("punctuation", 0.5, 1.0),
            Word("here", 5.0, 5.4),  # 4s gap
        ]
        sentences = segment.to_sentences(words)
        self.assertEqual(len(sentences), 2)

    def test_quoted_terminator_still_ends_sentence(self):
        words = [Word('"stop."', 0.0, 0.5), Word("Next", 0.6, 1.0)]
        self.assertEqual(len(segment.to_sentences(words, pause_split=10.0)), 2)

    def test_candidates_respect_duration_window(self):
        words = words_from(" ".join(f"this is sentence number {i} speaking." for i in range(60)))
        sentences = segment.to_sentences(words)
        clips = segment.candidates(sentences, min_seconds=20, max_seconds=40)
        self.assertTrue(clips)
        for clip in clips:
            self.assertGreaterEqual(clip.duration, 20)
            self.assertLessEqual(clip.duration, 40)

    def test_candidates_start_and_end_on_sentence_boundaries(self):
        text = " ".join(f"sentence number {i} runs for a little while here." for i in range(40))
        sentences = segment.to_sentences(words_from(text))
        boundaries_start = {round(s.start, 3) for s in sentences}
        boundaries_end = {round(s.end, 3) for s in sentences}
        for clip in segment.candidates(sentences, min_seconds=10, max_seconds=30):
            self.assertIn(round(clip.start, 3), boundaries_start)
            self.assertIn(round(clip.end, 3), boundaries_end)

    def test_max_per_start_caps_fanout(self):
        text = " ".join(f"short one {i}." for i in range(200))
        sentences = segment.to_sentences(words_from(text))
        capped = segment.candidates(sentences, min_seconds=5, max_seconds=90, max_per_start=2)
        wide = segment.candidates(sentences, min_seconds=5, max_seconds=90, max_per_start=50)
        self.assertLess(len(capped), len(wide))

    def test_overlap_suppression_keeps_best_and_drops_neighbours(self):
        a = Clip(0, 40, words_from("a b c"), score=0.9)
        b = Clip(2, 42, words_from("d e f"), score=0.8)   # ~90% IoU with a
        c = Clip(300, 340, words_from("g h i"), score=0.7)  # disjoint
        kept = segment.suppress_overlaps([a, b, c], max_iou=0.2)
        self.assertEqual([k.score for k in kept], [0.9, 0.7])


class TestScore(unittest.TestCase):
    def _clip(self, text: str, duration: float | None = None) -> Clip:
        words = words_from(text)
        clip = Clip(start=words[0].start, end=words[-1].end, words=words)
        if duration is not None:
            clip.end = clip.start + duration
        return clip

    def test_question_opener_beats_dangling_opener(self):
        strong = self._clip("Why did everyone get this wrong for ten years?")
        weak = self._clip("and then he said it was fine I guess")
        self.assertGreater(score.hook_score(strong), score.hook_score(weak))

    def test_dangling_opener_penalised_by_standalone(self):
        good = self._clip("Nobody tells founders this about their first hire.")
        bad = self._clip("So that is why he ended up doing it that way.")
        self.assertGreater(score.standalone_score(good), score.standalone_score(bad))

    def test_payoff_needs_resolution_or_terminal_punctuation(self):
        resolved = self._clip("We lost the account. That's why we rebuilt onboarding.")
        unresolved = self._clip("We lost the account and then we started to")
        self.assertGreater(score.payoff_score(resolved), score.payoff_score(unresolved))

    def test_concreteness_rewards_numbers_and_names(self):
        concrete = self._clip("We went from 400 to 12000 users after Stripe and Vercel shipped.")
        vague = self._clip("we went from not very many users to quite a lot of them later on")
        self.assertGreater(score.concreteness_score(concrete), score.concreteness_score(vague))

    def test_density_peaks_near_natural_speech_rate(self):
        words = words_from(" ".join(["word"] * 84))  # 84 words
        natural = Clip(0, 30, words)      # 2.8 wps
        too_slow = Clip(0, 84, words)     # 1.0 wps
        too_fast = Clip(0, 14, words)     # 6.0 wps
        self.assertGreater(score.density_score(natural), score.density_score(too_slow))
        self.assertGreater(score.density_score(natural), score.density_score(too_fast))

    def test_length_fit_prefers_mid_length_clips(self):
        mid = Clip(0, 34, words_from("a b"))
        long = Clip(0, 120, words_from("a b"))
        self.assertGreater(score.length_fit_score(mid), score.length_fit_score(long))

    def test_all_components_bounded_zero_to_one(self):
        samples = [
            "Why does nobody talk about the 3 biggest mistakes? That's why I quit.",
            "and uh you know maybe sort of basically it was kind of fine i guess",
            "",
        ]
        for text in samples:
            words = words_from(text) or [Word("x", 0.0, 0.1)]
            clip = Clip(words[0].start, words[-1].end, words)
            scored = score.score_clip(clip)
            for name, value in scored.components.items():
                self.assertGreaterEqual(value, 0.0, name)
                self.assertLessEqual(value, 1.0, name)
            self.assertGreaterEqual(scored.score, 0.0)
            self.assertLessEqual(scored.score, 1.0)

    def test_weights_sum_to_one(self):
        self.assertAlmostEqual(sum(score.WEIGHTS.values()), 1.0, places=6)

    def test_strong_clip_outranks_filler_end_to_end(self):
        strong = score.score_clip(
            self._clip(
                "Why did we almost lose 40000 dollars in one week? Because nobody "
                "checked the refund queue. That's why every new hire now reads it first.",
                duration=34,
            )
        )
        filler = score.score_clip(
            self._clip(
                "and so you know it was basically kind of the same thing again and "
                "then he sort of said that maybe we could probably look at it later",
                duration=34,
            )
        )
        self.assertGreater(strong.score, filler.score)

    def test_title_truncates_on_word_boundary(self):
        clip = self._clip("This is a very long opening sentence that keeps going well past the limit.")
        title = score.suggest_title(clip, max_chars=30)
        self.assertLessEqual(len(title), 31)
        self.assertTrue(title.endswith("\u2026"))


class TestCaptions(unittest.TestCase):
    def test_lines_respect_max_words(self):
        words = words_from(" ".join(["word"] * 20))
        for line in captions.group_lines(words, max_words=4, max_gap=99):
            self.assertLessEqual(len(line), 4)

    def test_ass_has_one_event_per_word(self):
        words = words_from("one two three four five six")
        ass = captions.build_ass(words)
        events = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")]
        self.assertEqual(len(events), len(words))

    def test_ass_times_are_rebased_to_clip_start(self):
        words = words_from("hello there friend", start=600.0)
        ass = captions.build_ass(words, clip_start=600.0)
        first = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")][0]
        self.assertIn("0:00:00.00", first)
        self.assertNotIn("0:10:00", first)

    def test_ass_braces_in_speech_do_not_break_override_tags(self):
        words = [Word("{drop}", 0.0, 0.5)]
        ass = captions.build_ass(words)
        self.assertIn("(drop)", ass)

    def test_srt_timecodes_are_wellformed(self):
        words = words_from("alpha beta gamma delta", start=3661.5)
        srt = captions.build_srt(words, clip_start=3600.0)
        self.assertIn("00:01:01,", srt)
        self.assertTrue(srt.startswith("1\n"))


class TestRender(unittest.TestCase):
    def test_crop_filter_uses_probed_dimensions(self):
        chain = render.build_filter("crop", source_size=(1920, 1080))
        # 1080*9/16 = 607.5 -> 606; offset (1920-606)/2 = 657 -> 656, both kept even
        self.assertIn("crop=606:1080:656:0", chain)
        self.assertIn("scale=1080:1920", chain)

    def test_crop_bias_moves_the_window(self):
        left = render.build_filter("crop", source_size=(1920, 1080), crop_x_bias=0.0)
        right = render.build_filter("crop", source_size=(1920, 1080), crop_x_bias=1.0)
        self.assertIn("crop=606:1080:0:0", left)
        self.assertIn("crop=606:1080:1314:0", right)

    def test_crop_width_never_exceeds_source(self):
        chain = render.build_filter("crop", source_size=(720, 1280))
        self.assertIn("crop=720:1280:0:0", chain)

    def test_blur_mode_builds_overlay_graph(self):
        chain = render.build_filter("blur")
        self.assertIn("boxblur", chain)
        self.assertIn("overlay=", chain)

    def test_unknown_mode_rejected(self):
        with self.assertRaises(ValueError):
            render.build_filter("sideways")

    def test_ass_path_colon_is_escaped_for_filtergraph(self):
        chain = render.build_filter("crop", ass_path="C:/out/clip.ass")
        self.assertIn(r"C\:/out/clip.ass", chain)

    def test_command_seeks_before_input_and_is_frame_accurate(self):
        cmd = render.build_command("in.mp4", "out.mp4", 12.5, 30.0, "scale=1080:1920")
        self.assertLess(cmd.index("-ss"), cmd.index("-i"))
        self.assertIn("-accurate_seek", cmd)
        self.assertEqual(cmd[cmd.index("-t") + 1], "30.000")
        self.assertEqual(cmd[-1], "out.mp4")

    def test_command_output_is_phone_playable(self):
        cmd = render.build_command("in.mp4", "out.mp4", 0, 10, "null")
        self.assertIn("yuv420p", cmd)
        self.assertIn("+faststart", cmd)


class TestTranscribeLoaders(unittest.TestCase):
    def test_srt_roundtrip_spreads_words_across_cue(self):
        srt = (
            "1\n00:00:10,000 --> 00:00:12,000\nHello there world\n\n"
            "2\n00:00:12,500 --> 00:00:14,000\nsecond cue\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.srt"
            path.write_text(srt, encoding="utf-8")
            words = transcribe.load_srt(path)
        self.assertEqual([w.text for w in words], ["Hello", "there", "world", "second", "cue"])
        self.assertAlmostEqual(words[0].start, 10.0, places=3)
        self.assertAlmostEqual(words[2].end, 12.0, places=3)
        self.assertTrue(all(w.end > w.start for w in words))

    def test_srt_strips_inline_tags(self):
        srt = "1\n00:00:00,000 --> 00:00:02,000\n<i>styled</i> text\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.srt"
            path.write_text(srt, encoding="utf-8")
            self.assertEqual([w.text for w in transcribe.load_srt(path)], ["styled", "text"])

    def test_json_roundtrip(self):
        words = words_from("round trip test")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.json"
            transcribe.save_json(words, path)
            self.assertEqual(transcribe.load_json(path), words)


class TestPipelineGlue(unittest.TestCase):
    def test_select_clips_returns_ranked_non_overlapping_clips(self):
        text = " ".join(
            f"Why does nobody mention problem number {i}? It cost us {i}000 dollars "
            f"and that's why we changed the whole process last spring."
            for i in range(30)
        )
        clips = select_clips(words_from(text), Settings(count=5, min_seconds=15, max_seconds=60))
        self.assertLessEqual(len(clips), 5)
        self.assertEqual([c.score for c in clips], sorted([c.score for c in clips], reverse=True))
        for i, a in enumerate(clips):
            for b in clips[i + 1:]:
                self.assertLessEqual(a.overlaps(b), 0.2)

    def test_words_in_is_inclusive_of_boundaries(self):
        words = words_from("one two three four five")
        subset = words_in(words, words[1].start, words[3].end)
        self.assertEqual([w.text for w in subset], ["two", "three", "four"])

    def test_slugify_is_filesystem_safe(self):
        self.assertEqual(slugify("Why 40% of founders quit!"), "why-40-of-founders-quit")
        self.assertEqual(slugify("///"), "clip")

    def test_suggested_caption_has_hook_and_tags(self):
        words = words_from("Founders underestimate retention because onboarding breaks silently.")
        clip = score.score_clip(Clip(words[0].start, words[-1].end, words))
        caption = suggested_caption(clip)
        self.assertIn(clip.title.rstrip(".\u2026"), caption)
        self.assertIn("#", caption)


if __name__ == "__main__":
    unittest.main()
