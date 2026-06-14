"""Local speech-to-text via faster-whisper (CTranslate2).

Runs entirely on-device, which is the whole point for a confidential interview:
no audio leaves the machine and no API key is needed. ``int8`` compute keeps it
quick on a CPU-only box, and because we already cut audio into tight utterances
upstream we transcribe each chunk greedily (``beam_size=1``) for low latency.
"""

from __future__ import annotations

import numpy as np


class Transcriber:
    def __init__(
        self,
        model_size: str = "base",
        device: str = "cpu",
        compute_type: str = "int8",
        language: str | None = None,
        beam_size: int = 1,
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.beam_size = beam_size
        self._model = None

    def load(self) -> None:
        """Load (and on first ever run, download) the model. Slow; call once."""
        if self._model is not None:
            return
        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            self.model_size, device=self.device, compute_type=self.compute_type
        )

    def transcribe(self, audio_f32: np.ndarray) -> str:
        """Transcribe one utterance-sized chunk into a single text line."""
        if self._model is None:
            self.load()
        if audio_f32.dtype != np.float32:
            audio_f32 = audio_f32.astype(np.float32)
        segments, _info = self._model.transcribe(
            audio_f32,
            language=self.language,
            beam_size=self.beam_size,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        return " ".join(seg.text.strip() for seg in segments).strip()
