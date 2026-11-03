#!/usr/bin/env python3
"""Launch the installed app with a short-lived owner pairing token, without CLI secrets.

The private backend mints a token. Save the JSON response or raw token to a mode-600
file outside this repo, then pass its path here. The app exchanges it for a normal
HttpOnly session cookie. No password is embedded in the app or written to defaults.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--token-file", type=Path, required=True)
parser.add_argument("--device", default="00008150-00062DD41408401C")
args = parser.parse_args()

try:
    fd = os.open(args.token_file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError("Pairing file must be owned by you and readable only by you (chmod 600).")
        raw = stream.read(8193).strip()
    if len(raw) > 8192:
        raise ValueError("Pairing file is too large.")
    token = json.loads(raw)["token"] if raw.startswith("{") else raw
    if not isinstance(token, str) or not token or len(token) > 4096 or any(c.isspace() for c in token):
        raise ValueError("Invalid pairing token format.")
except (OSError, ValueError, KeyError, TypeError) as error:
    print(f"Could not read pairing file: {error}", file=sys.stderr)
    sys.exit(1)

child_env = os.environ.copy()
child_env["DEVICECTL_CHILD_JAKESDATA_PAIRING_TOKEN"] = token
result = subprocess.run([
    "xcrun", "devicectl", "device", "process", "launch", "--device", args.device,
    "--terminate-existing", "--timeout", "60", "com.jakebeau.jakesdata"
], env=child_env, capture_output=True, text=True)
child_env.pop("DEVICECTL_CHILD_JAKESDATA_PAIRING_TOKEN", None)
if result.returncode:
    print("Could not launch the paired app. Check that the iPhone is connected and unlocked.", file=sys.stderr)
    sys.exit(result.returncode)
args.token_file.unlink()
print("Launched Jake's Brain with one-time pairing. Local token file removed.")
