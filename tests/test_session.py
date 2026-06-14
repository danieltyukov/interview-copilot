from datetime import datetime

from interview_copilot.session import Session, State, fmt_clock


def test_recording_gates_utterances():
    s = Session()
    assert s.add_utterance(1.0, "A", "before start") is None  # idle -> ignored
    s.start()
    assert s.is_recording
    assert s.add_utterance(1.0, "A", "hello") is not None
    assert s.add_utterance(2.0, "A", "   ") is None  # empty ignored
    assert len(s.utterances) == 1


def test_latest_question_prefers_interviewer():
    s = Session()
    s.start()
    s.add_utterance(1.0, "A", "I am the candidate")
    s.add_utterance(2.0, "B", "Why do you want this job?")
    s.add_utterance(3.0, "A", "Because…")
    s.set_me("A")
    q = s.latest_question()
    assert q.text == "Why do you want this job?"  # most recent non-me


def test_latest_question_fallback_without_me_label():
    s = Session()
    s.start()
    s.add_utterance(1.0, "A", "first")
    s.add_utterance(2.0, "B", "second")
    assert s.latest_question().text == "second"


def test_speaker_naming():
    s = Session()
    s.set_me("A")
    assert s.speaker_name("A") == "Me"
    assert s.speaker_name("B") == "Interviewer"
    s.set_me(None)
    assert s.speaker_name("A") == "Speaker A"


def test_export_markdown_and_file(tmp_path):
    s = Session()
    s.start(now=datetime(2026, 6, 14, 10, 0, 0))
    s.add_utterance(0.0, "B", "Tell me about this project.")
    s.add_utterance(5.0, "A", "It is an interview copilot.")
    s.add_assist(6.0, "Tell me about this project.", "I built an interview copilot…")
    s.set_me("A")
    s.end(now=datetime(2026, 6, 14, 10, 1, 30))

    md = s.export_markdown(tmp_path)
    assert "# Interview transcript" in md
    assert "Tell me about this project." in md
    assert "Copilot assists" in md
    assert "Duration:** 01:30" in md

    dest = s.write_export(tmp_path)
    assert dest.exists()
    assert dest.name.startswith("interview-")
    assert dest.read_text().strip() == md.strip()


def test_fmt_clock():
    assert fmt_clock(0) == "00:00"
    assert fmt_clock(75) == "01:15"
