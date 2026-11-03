#!/usr/bin/env python3
"""Probe the DeepSeek Messages API rule behind `content[].thinking ...`.

The question this answers: when thinking mode is on, what exactly makes the
server reject a replayed history? Candidates were (a) any assistant turn
without a thinking block, (b) only turns that carry `tool_use`, (c) the missing
signature on a foreign thinking block.

Run it against a DeepSeek-compatible Messages endpoint. It reads the account
token (or API key) from the DSH credential file and never prints either.

    python scripts/probe-deepseek-thinking-replay.py

Output is one line per case: label, HTTP status, first bytes of the body.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.environ.get("PROBE_BASE_URL", "https://api.deepseek.com/anthropic")
MODEL = os.environ.get("PROBE_MODEL", "deepseek-flash")
CRED = os.path.expanduser(os.environ.get("PROBE_CREDENTIALS", "~/.dsh/.credentials.yaml"))

TOOLS = [
    {
        "name": "read_file",
        "description": "Read a file",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    }
]


def load_credentials() -> tuple[str | None, str | None]:
    """Return (account token, api key); either may be None."""
    try:
        text = open(CRED, "r", encoding="utf-8").read()
    except OSError:
        return None, None
    token = None
    match = re.search(r"deepseek-account-platform/default:\s*\n(?:.*\n)*?\s+token:\s*(\S+)", text)
    if match:
        token = match.group(1).strip().strip("'\"")
    key = None
    match = re.search(r"DEEPSEEK_API_KEY:\s*(\S+)", text)
    if match:
        key = match.group(1).strip().strip("'\"")
    return token, key


def call(label: str, messages: list[dict], thinking: str, token: str | None, key: str | None) -> int | None:
    body: dict = {
        "model": MODEL,
        "stream": False,
        "max_tokens": 64,
        "messages": messages,
        "thinking": {"type": thinking},
        "tools": TOOLS,
    }
    if thinking == "enabled":
        body["output_config"] = {"effort": "low"}
    headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "accept": "application/json",
    }
    if token:
        headers["x-dsh-auth-token"] = token
    elif key:
        headers["x-api-key"] = key
    else:
        print(f"[{label}] SKIP: no credential found at {CRED}")
        return None

    request = urllib.request.Request(
        BASE + "/messages",
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode("utf-8", "replace")
            print(f"[{label}] status={response.status} body={text[:220]}")
            return response.status
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        print(f"[{label}] status={error.code} body={text[:300]}")
        return error.code
    except Exception as error:  # noqa: BLE001 - report, never swallow silently
        print(f"[{label}] FAILED {type(error).__name__}: {error}")
        return None


def main() -> int:
    token, key = load_credentials()
    print(f"endpoint={BASE} model={MODEL} token={'yes' if token else 'no'} key={'yes' if key else 'no'}")

    user = lambda text: {"role": "user", "content": [{"type": "text", "text": text}]}  # noqa: E731
    assistant = lambda text: {"role": "assistant", "content": [{"type": "text", "text": text}]}  # noqa: E731
    tool_use = {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "a.txt"}}
    tool_result = {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "call_1", "content": "hello"}],
    }

    plain_tool = [user("read a.txt"), {"role": "assistant", "content": [tool_use]}, tool_result]
    unsigned_thinking = [
        user("read a.txt"),
        {"role": "assistant", "content": [{"type": "thinking", "thinking": "the user wants the file"}, tool_use]},
        tool_result,
    ]
    foreign_signature = [
        user("read a.txt"),
        {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "", "signature": "sig-from-elsewhere"},
                tool_use,
            ],
        },
        tool_result,
    ]
    text_and_tool = [
        user("read a.txt"),
        {"role": "assistant", "content": [{"type": "text", "text": "reading it now"}, tool_use]},
        tool_result,
    ]

    call("R1 assistant text, no thinking, thinking on", [user("say hi"), assistant("hi"), user("again")], "enabled", token, key)
    call("R2 same history, thinking off", [user("say hi"), assistant("hi"), user("again")], "disabled", token, key)
    call("T1 tool_use, no thinking, thinking on", plain_tool, "enabled", token, key)
    call("T2 tool_use, no thinking, thinking off", plain_tool, "disabled", token, key)
    call("T3 tool_use + unsigned thinking, thinking on", unsigned_thinking, "enabled", token, key)
    call("T4 tool_use + empty thinking with foreign signature, thinking on", foreign_signature, "enabled", token, key)
    call("T5 text + tool_use, no thinking, thinking on", text_and_tool, "enabled", token, key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
