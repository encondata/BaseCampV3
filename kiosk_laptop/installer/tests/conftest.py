import os
import subprocess
from pathlib import Path

import pytest

INSTALL_SH = Path(__file__).resolve().parents[1] / "install.sh"
# Exercise macOS's bash 3.2 when it is present.
BASH = "/bin/bash" if os.path.exists("/bin/bash") else "bash"


@pytest.fixture
def sh(tmp_path):
    """Run `body` in bash with install.sh sourced in library mode; returns CompletedProcess."""
    def run(body, env=None, check=True):
        full_env = {**os.environ, "KIOSK_INSTALL_LIB": "1", "HOME": str(tmp_path / "home"),
                    "KIOSK_NONINTERACTIVE": "1", "KIOSK_TEMPLATE_DIR": str(INSTALL_SH.parent),
                    **(env or {})}
        (tmp_path / "home").mkdir(exist_ok=True)
        proc = subprocess.run([BASH, "-c", f'source "{INSTALL_SH}"; {body}'],
                              capture_output=True, text=True, env=full_env, cwd=tmp_path)
        if check and proc.returncode != 0:
            raise AssertionError(f"exit {proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}")
        return proc
    return run
