#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper and print {"text", "duration"} as JSON."""
import json
import os
import sys

from faster_whisper import WhisperModel

model = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], vad_filter=True)
text = " ".join(segment.text.strip() for segment in segments)
print(json.dumps({"text": text, "duration": info.duration}))
