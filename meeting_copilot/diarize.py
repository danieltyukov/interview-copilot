"""Best-effort two-speaker diarization.

True speaker diarization needs a trained neural embedder; that's heavy on a
CPU-only box and overkill for "tell me apart from everyone else". Instead we
build a cheap per-utterance fingerprint from the MFCC envelope plus median
pitch and voicing ratio (pitch is the single most useful cue for separating two
people), then cluster utterances into two groups.

The clustering is re-fit on every new utterance and *gated*: if the two
proposed clusters aren't well separated (low silhouette), we fall back to a
single speaker. Labels are anchored so the first speaker is always "A". This is
explicitly heuristic — the rest of the app stays useful even when it's wrong.
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 16000


# --------------------------------------------------------------------------- #
# Feature extraction (NumPy-only MFCC + pitch)
# --------------------------------------------------------------------------- #
def _hz_to_mel(hz: np.ndarray) -> np.ndarray:
    return 2595.0 * np.log10(1.0 + hz / 700.0)


def _mel_to_hz(mel: np.ndarray) -> np.ndarray:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def _mel_filterbank(sr: int, n_fft: int, n_mels: int) -> np.ndarray:
    n_bins = n_fft // 2 + 1
    mel_pts = np.linspace(_hz_to_mel(np.array(0.0)), _hz_to_mel(np.array(sr / 2)), n_mels + 2)
    hz_pts = _mel_to_hz(mel_pts)
    bin_idx = np.floor((n_fft + 1) * hz_pts / sr).astype(int)
    bin_idx = np.clip(bin_idx, 0, n_bins - 1)
    fb = np.zeros((n_mels, n_bins), dtype=np.float32)
    for m in range(1, n_mels + 1):
        left, center, right = bin_idx[m - 1], bin_idx[m], bin_idx[m + 1]
        for k in range(left, center):
            if center > left:
                fb[m - 1, k] = (k - left) / (center - left)
        for k in range(center, right):
            if right > center:
                fb[m - 1, k] = (right - k) / (right - center)
    return fb


_N_FFT = 512
_HOP = 160
_WIN = 400
_N_MELS = 26
_N_MFCC = 13
_FB = _mel_filterbank(SAMPLE_RATE, _N_FFT, _N_MELS)
_HAMMING = np.hamming(_WIN).astype(np.float32)
# DCT-II matrix (n_mfcc x n_mels)
_k = np.arange(_N_MFCC)[:, None]
_n = np.arange(_N_MELS)[None, :]
_DCT = np.cos(np.pi * _k * (2 * _n + 1) / (2 * _N_MELS)).astype(np.float32)


def _frame(sig: np.ndarray) -> np.ndarray:
    if len(sig) < _WIN:
        return np.empty((0, _WIN), dtype=np.float32)
    n = 1 + (len(sig) - _WIN) // _HOP
    idx = np.arange(_WIN)[None, :] + _HOP * np.arange(n)[:, None]
    return sig[idx]


def _mfcc(sig: np.ndarray) -> np.ndarray | None:
    frames = _frame(sig)
    if frames.shape[0] == 0:
        return None
    emphasized = frames * _HAMMING
    spec = np.fft.rfft(emphasized, n=_N_FFT, axis=1)
    power = (np.abs(spec) ** 2) / _N_FFT
    mel = power @ _FB.T
    logmel = np.log(mel + 1e-8)
    return logmel @ _DCT.T  # (n_frames, n_mfcc)


def _pitch(sig: np.ndarray) -> tuple[float, float]:
    """Return (median voiced pitch in Hz, voiced ratio) via autocorrelation."""
    frames = _frame(sig)
    if frames.shape[0] == 0:
        return 0.0, 0.0
    min_lag = SAMPLE_RATE // 350  # ~45
    max_lag = SAMPLE_RATE // 70   # ~228
    pitches: list[float] = []
    for fr in frames:
        fr = fr - fr.mean()
        energy = float(np.dot(fr, fr))
        if energy < 1e-3:
            continue
        ac = np.correlate(fr, fr, mode="full")[len(fr) - 1:]
        if len(ac) <= max_lag:
            continue
        seg = ac[min_lag:max_lag]
        if seg.size == 0:
            continue
        lag = int(np.argmax(seg)) + min_lag
        if ac[lag] / (ac[0] + 1e-9) > 0.3:
            pitches.append(SAMPLE_RATE / lag)
    if not pitches:
        return 0.0, 0.0
    return float(np.median(pitches)), len(pitches) / frames.shape[0]


def embedding(audio_f32: np.ndarray) -> np.ndarray:
    """28-dim voice fingerprint for a single utterance."""
    mf = _mfcc(audio_f32)
    if mf is None or mf.shape[0] == 0:
        return np.zeros(_N_MFCC * 2 + 2, dtype=np.float32)
    mean = mf.mean(axis=0)
    std = mf.std(axis=0)
    pitch, voiced = _pitch(audio_f32)
    return np.concatenate([mean, std, [pitch, voiced]]).astype(np.float32)


# --------------------------------------------------------------------------- #
# Clustering
# --------------------------------------------------------------------------- #
class Diarizer:
    """Accumulates utterance fingerprints and labels them A/B (best effort)."""

    def __init__(self, enabled: bool = True, min_silhouette: float = 0.25) -> None:
        self.enabled = enabled
        self.min_silhouette = min_silhouette
        self._embs: list[np.ndarray] = []

    def reset(self) -> None:
        self._embs = []

    def assign(self, audio_f32: np.ndarray) -> str:
        if not self.enabled:
            return "?"
        self._embs.append(embedding(audio_f32))
        return self.labels()[-1]

    def labels(self) -> list[str]:
        n = len(self._embs)
        if not self.enabled:
            return ["?"] * n
        if n < 3:
            # Not enough evidence to split confidently — defer to one speaker.
            return ["A"] * n

        from sklearn.cluster import KMeans
        from sklearn.metrics import silhouette_score
        from sklearn.preprocessing import StandardScaler

        X = np.vstack(self._embs)
        Xs = StandardScaler().fit_transform(X)
        km = KMeans(n_clusters=2, n_init=10, random_state=0)
        raw = km.fit_predict(Xs)
        if len(set(raw)) < 2:
            return ["A"] * n
        try:
            sil = silhouette_score(Xs, raw)
        except ValueError:
            sil = 0.0
        if sil < self.min_silhouette:
            return ["A"] * n  # clusters too weak; treat as one speaker
        # Anchor: whichever cluster the first utterance is in becomes "A".
        first = raw[0]
        return ["A" if c == first else "B" for c in raw]
