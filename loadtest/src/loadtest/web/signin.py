"""The tool's own sign-in: one username and password, a page to type them into, and the
form's body. Nothing here knows about a BaseCamp server."""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from html import escape
from urllib.parse import parse_qs

DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "password123"
MAX_FORM_BYTES = 4096
WRONG = "That username or password is not right."
NEED_SIGN_IN = {"code": "sign_in", "message": "Sign in to use the load test."}


@dataclass(frozen=True)
class SignIn:
    username: str
    password: str

    def matches(self, username: str, password: str) -> bool:
        """Both are always compared, in constant time, so a wrong username answers as
        fast as a wrong password."""
        user = hmac.compare_digest(username.encode("utf-8", "replace"),
                                   self.username.encode("utf-8"))
        word = hmac.compare_digest(password.encode("utf-8", "replace"),
                                   self.password.encode("utf-8"))
        return user and word

    def __repr__(self) -> str:      # never the password, in a log or a traceback
        return "SignIn(...)"


async def read_form(receive, limit: int = MAX_FORM_BYTES) -> dict[str, str] | None:
    """The fields of a urlencoded form body, or None when it is longer than `limit` or
    the client went away."""
    body = b""
    while True:
        message = await receive()
        if message["type"] != "http.request":
            return None
        body += message.get("body", b"")
        if len(body) > limit:
            return None
        if not message.get("more_body"):
            break
    fields = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
    return {name: values[-1] for name, values in fields.items()}


# The page's own tokens and theme choice (index.html), so the sign-in looks like the tool
# and follows light and dark the same way.
_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Move load test: sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geologica:wght@300;400;500;600;800&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<style>
  :root {
    --paper: #fbfcfd; --paper-line: #e4e8ee; --surface: #ffffff; --surface-2: #f5f7fa;
    --text-dark: #1b2129; --text-mute: #667085; --accent: #ffa12e; --accent-rgb: 255, 161, 46;
    --c-red: #c03540; --c-red-bg: rgba(229, 72, 77, 0.1); --c-red-bd: rgba(229, 72, 77, 0.3);
    --font-display: 'Geologica', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  :root[data-theme='dark'] {
    --paper: #10151f; --paper-line: rgba(255, 255, 255, 0.09); --surface: #161d2a;
    --surface-2: #0f1520; --text-dark: #e8edf4; --text-mute: #8a97aa;
    --c-red: #ff5d6c; --c-red-bg: rgba(255, 93, 108, 0.12); --c-red-bd: rgba(255, 93, 108, 0.25);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; background: var(--paper); color: var(--text-dark);
    font-family: var(--font-display); -webkit-font-smoothing: antialiased;
  }
  form {
    width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 16px;
    background: var(--surface); border: 1px solid var(--paper-line); border-radius: 12px;
    padding: 24px 22px 22px;
  }
  h1 { margin: 0; font-size: 19px; font-weight: 600; }
  p { margin: -8px 0 0; font-size: 13px; font-weight: 300; color: var(--text-mute); line-height: 1.5; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 12.5px; font-weight: 500; }
  input {
    width: 100%; font-family: var(--font-display); font-size: 14px; color: var(--text-dark);
    background: var(--surface-2); border: 1px solid var(--paper-line); border-radius: 9px;
    padding: 10px 12px; outline: none;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.15); }
  .err {
    margin: 0; padding: 9px 12px; font-size: 13px; font-weight: 400; color: var(--c-red);
    background: var(--c-red-bg); border: 1px solid var(--c-red-bd); border-radius: 9px;
  }
  button {
    height: 38px; border: 0; border-radius: 9px; background: var(--accent); color: #1a1205;
    font-family: var(--font-display); font-size: 13.5px; font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.05); }
</style>
<script>
  (function () {
    var t = null;
    try { t = localStorage.getItem('data-generator.theme'); } catch (e) {}
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = t;
  })();
</script>
</head>
<body>
<form method="post" action="/login" autocomplete="on">
  <h1>Move load test</h1>
  <p>Sign in to open the load test.</p>
  __ERROR__
  <div class="field">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="__USERNAME__" required __FOCUS_USER__>
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required __FOCUS_WORD__>
  </div>
  <button type="submit">Sign in</button>
</form>
</body>
</html>
"""


def sign_in_page(*, error: str = "", username: str = "") -> str:
    """The sign-in page. `username` is what was typed (shown again after a wrong try);
    the password is never sent back."""
    shown = escape(username[:200], quote=True)
    return (_PAGE
            .replace("__ERROR__", f'<div class="err" role="alert">{escape(error)}</div>'
                     if error else "")
            .replace("__USERNAME__", shown)
            .replace("__FOCUS_USER__", "" if shown else "autofocus")
            .replace("__FOCUS_WORD__", "autofocus" if shown else ""))
