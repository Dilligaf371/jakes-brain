#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper and print {"text", "duration"} as JSON.

Audio is decoded with ffmpeg because the PC's PyAV is newer than faster-whisper's decoder expects.
"""
import json
import os
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

RATE = 16000
pcm = subprocess.run(
    [os.environ.get("JAKESDATA_FFMPEG") or "ffmpeg", "-nostdin", "-v", "error", "-i", sys.argv[1],
     "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-"],
    check=True, stdout=subprocess.PIPE,
).stdout
audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
model = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio, vad_filter=True)
text = " ".join(segment.text.strip() for segment in segments)
print(json.dumps({"text": text, "duration": len(audio) / RATE}))
