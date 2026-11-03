"""Kokoro text-to-speech sidecar for Zamolxis, using the Claude Voice app's own engine and models.

Started by src/core/voice/kokoroSidecar.ts with Claude Voice's venv python, in isolated mode (-I), so
neither PYTHONPATH nor the current folder can inject modules; the Claude Voice source folder is added
to sys.path here. It never writes Claude Voice's config or models.

Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
  {"id": 1, "op": "synth", "text": "...", "voice": "af_heart", "speed": 1.0, "max_chars": 700}
      -> {"id": 1, "ok": true, "wav_b64": "...", "chars": 123}
  {"id": 2, "op": "voices"}  -> {"id": 2, "ok": true, "voices": [["af_heart", "Heart, female, American English"], ...]}
  {"id": 3, "op": "ping"}    -> {"id": 3, "ok": true, "loaded": false}
Errors: {"id": n, "ok": false, "error": "..."}. Log lines go to stderr.
"""
import argparse
import base64
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="Claude Voice source folder (holds the claude_voice package)")
    ap.add_argument("--models", default="", help="Claude Voice models folder (blank = its default)")
    args = ap.parse_args()

    # The protocol owns the real stdout; anything a library prints goes to stderr instead. Both
    # directions are UTF-8 whatever the console code page (the requests are ASCII-escaped anyway).
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    out = sys.stdout
    sys.stdout = sys.stderr
    if args.repo not in sys.path:
        sys.path.insert(0, args.repo)

    cfg = {"speech": {"models_dir": args.models}} if args.models else None
    tts = None
    textutil = None
    load_error = None
    try:
        from claude_voice import tts as _tts
        from claude_voice import textutil as _textutil
        tts, textutil = _tts, _textutil
    except Exception as e:  # missing venv packages, moved repo
        load_error = "cannot import claude_voice: %s" % e

    def reply(obj):
        out.write(json.dumps(obj) + "\n")
        out.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        op = req.get("op")
        try:
            if op == "ping":
                reply({"id": rid, "ok": tts is not None, "loaded": bool(tts and tts._kokoro is not None), "error": load_error})
                continue
            if tts is None:
                raise RuntimeError(load_error or "claude_voice is not available")
            if op == "voices":
                if tts._load_kokoro(cfg) is None:
                    raise RuntimeError("Kokoro voice is not downloaded (Claude Voice models folder)")
                reply({"id": rid, "ok": True, "voices": [list(v) for v in tts.kokoro_voices()]})
            elif op == "synth":
                text = str(req.get("text") or "")
                max_chars = max(1, min(5000, int(req.get("max_chars") or 700)))
                text = textutil.markdown_to_speech(text, max_chars)
                if not text:
                    raise RuntimeError("nothing to say")
                wav = tts.synth_kokoro(text, req.get("voice") or "af_heart", float(req.get("speed") or 1.0), cfg)
                reply({"id": rid, "ok": True, "wav_b64": base64.b64encode(wav).decode("ascii"), "chars": len(text)})
            else:
                raise RuntimeError("unknown op %r" % op)
        except Exception as e:
            reply({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
