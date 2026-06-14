import numpy as np

from interview_copilot.diarize import Diarizer, embedding, _pitch

SR = 16000


def make_voice(f0: float, dur: float = 1.0, formant: float = 1000.0, seed: int = 0) -> np.ndarray:
    """Synthesise a crude voiced sound at fundamental ``f0`` with a formant peak."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(SR * dur)) / SR
    sig = np.zeros_like(t)
    for k in range(1, 25):
        fk = k * f0
        if fk > SR / 2:
            break
        # Resonance: boost harmonics near the formant frequency.
        gain = 1.0 / (1.0 + ((fk - formant) / 400.0) ** 2) / k
        sig += gain * np.sin(2 * np.pi * fk * t + rng.uniform(0, np.pi))
    sig += 0.01 * rng.standard_normal(len(t))
    return (sig / (np.max(np.abs(sig)) + 1e-9)).astype(np.float32)


def test_pitch_detection():
    f, voiced = _pitch(make_voice(150.0))
    assert abs(f - 150.0) < 20.0
    assert voiced > 0.5


def test_embedding_shape():
    emb = embedding(make_voice(120.0))
    assert emb.shape == (28,)
    assert np.isfinite(emb).all()


def test_separates_two_distinct_voices():
    a = lambda s: make_voice(115.0, formant=900.0, seed=s)   # low voice
    b = lambda s: make_voice(225.0, formant=1600.0, seed=s)  # high voice
    d = Diarizer()
    order = [a(1), b(2), a(3), b(4), a(5), b(6)]
    labels = [d.assign(x) for x in order]
    final = d.labels()
    # Two clusters discovered, and same-voice utterances share a label.
    assert len(set(final)) == 2
    assert final[0] == final[2] == final[4]      # all 'a' voices together
    assert final[1] == final[3] == final[5]      # all 'b' voices together
    assert final[0] != final[1]


def test_single_voice_stays_one_speaker():
    d = Diarizer()
    for s in range(5):
        d.assign(make_voice(150.0, seed=s))
    # Nearly identical voices: silhouette gate should keep them as one speaker.
    assert set(d.labels()) == {"A"}


def test_disabled_returns_unknown():
    d = Diarizer(enabled=False)
    assert d.assign(make_voice(150.0)) == "?"
