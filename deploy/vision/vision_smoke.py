#!/usr/bin/env python3
"""Synthetic two-frame smoke test; does not read or persist user media."""

from __future__ import annotations

import base64
import binascii
import json
import struct
import time
import urllib.request
import zlib


def png_data_url(rgb: tuple[int, int, int]) -> str:
    width, height = 96, 64
    scanline = bytes(rgb) * width
    raw = b"".join(b"\x00" + scanline for _ in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def api_key() -> str:
    with open("/etc/canvdoai-vision.env", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("CANVDOAI_VISION_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("vision API key is missing")


payload = {
    "model": "qwen3-vl:4b",
    "messages": [
        {"role": "system", "content": "只依据可见画面输出严格JSON，不要使用Markdown。"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "shot_index=1"},
                {"type": "image_url", "image_url": {"url": png_data_url((230, 25, 25)), "detail": "low"}},
                {"type": "text", "text": "shot_index=2"},
                {"type": "image_url", "image_url": {"url": png_data_url((20, 70, 225)), "detail": "low"}},
                {"type": "text", "text": "返回对象：{\"frames\":[{\"shot_index\":整数,\"dominant_color\":字符串}]}。"},
            ],
        },
    ],
    "response_format": {"type": "json_object"},
    "temperature": 0.0,
    "max_completion_tokens": 512,
}
request = urllib.request.Request(
    "http://127.0.0.1:8000/v1/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", "authorization": f"Bearer {api_key()}"},
    method="POST",
)
started = time.monotonic()
with urllib.request.urlopen(request, timeout=600) as response:
    result = json.load(response)
content = result["choices"][0]["message"]["content"]
parsed = json.loads(content)
frames = parsed.get("frames")
if not isinstance(frames, list) or {item.get("shot_index") for item in frames if isinstance(item, dict)} != {1, 2}:
    raise RuntimeError("model did not return both frame indexes")
print(json.dumps({"ok": True, "model": result.get("model"), "elapsed_seconds": round(time.monotonic() - started, 2), "frames": frames}, ensure_ascii=False))
