"""
Zamolxis Modal sandbox runner.

Invoked by the Modal backend as:
    modal run modal_runner.py --cmd "<shell command>"

It runs the command inside a fresh Modal container and prints its output.
Requires the `modal` CLI installed and authenticated (MODAL_TOKEN_ID /
MODAL_TOKEN_SECRET). This file is shipped with Zamolxis, not generated.
"""
import subprocess

import modal

app = modal.App("zamolxis-sandbox")
image = modal.Image.debian_slim()


@app.function(image=image)
def run(cmd: str) -> str:
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    out = proc.stdout or ""
    err = proc.stderr or ""
    return f"[exit {proc.returncode}]\n{out}{err}"


@app.local_entrypoint()
def main(cmd: str) -> None:
    print(run.remote(cmd))
