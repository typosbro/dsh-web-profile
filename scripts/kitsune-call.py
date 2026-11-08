#!/usr/bin/env python3
"""Call the Kitsune live-browser MCP server without a harness MCP client.

Fallback for when the `kitsune` server is not mounted as native tools: this
speaks MCP over stdio to the pinned `kitsune-browser-mcp` server, makes one tool
call, prints the result, and exits. One call per invocation is deliberate — it
gives the agent a re-read between interactions instead of a blind chain.

    scripts/kitsune-call.py tools
    scripts/kitsune-call.py tabs
    scripts/kitsune-call.py call browser_snapshot '{"tab_id": 11}'
    scripts/kitsune-call.py --mode draft call browser_type '{"tab_id": 11, ...}'

Modes mirror KITSUNE_MODE: read (default, cannot click or type), draft (fills
forms, cannot submit), act (everything the server publishes). The bridge also
reports the connected browser; if the extension is not connected the call fails
with the server's own hint.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

SERVER_VERSION = "kitsune-browser-mcp==0.7.3"
EXTRA_PATH = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
ERR_FILE = os.path.join(os.environ.get("TMPDIR", "/tmp"), "kitsune-call.err")


def find_uvx() -> str:
    explicit = os.environ.get("KITSUNE_UVX")
    if explicit:
        return os.path.expanduser(explicit)
    found = shutil.which("uvx")
    if found:
        return found
    for candidate in EXTRA_PATH:
        path = os.path.expanduser(os.path.join(candidate, "uvx"))
        if os.access(path, os.X_OK):
            return path
    sys.exit("uvx not found: install uv, or set KITSUNE_UVX to its path")


class Server:
    def __init__(self, mode: str, timeout: float):
        self.timeout = timeout
        self.next_id = 0
        self.err = open(ERR_FILE, "w")
        env = dict(os.environ)
        env["KITSUNE_MODE"] = mode
        self.proc = subprocess.Popen(
            [find_uvx(), "--from", SERVER_VERSION, "kitsune"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.err,
            text=True,
            bufsize=1,
            env=env,
        )

    def _send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def notify(self, method: str) -> None:
        self._send({"jsonrpc": "2.0", "method": method})

    def request(self, method: str, params: dict) -> dict:
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        deadline = time.time() + self.timeout
        assert self.proc.stdout is not None
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise SystemExit("kitsune server exited; stderr:\n" + tail_err())
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == self.next_id:
                return message
        raise SystemExit(f"no reply to {method} within {self.timeout}s")

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            pass


def tail_err(limit: int = 2000) -> str:
    try:
        with open(ERR_FILE) as handle:
            return handle.read()[-limit:]
    except OSError:
        return "(no stderr)"


def main() -> int:
    parser = argparse.ArgumentParser(description="One MCP call against the Kitsune live browser.")
    parser.add_argument("--mode", default="read", choices=["read", "draft", "act"])
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("command", choices=["tools", "tabs", "call"])
    parser.add_argument("tool", nargs="?")
    parser.add_argument("arguments", nargs="?", default="{}")
    args = parser.parse_args()

    server = Server(args.mode, args.timeout)
    try:
        init = server.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "kitsune-call", "version": SERVER_VERSION},
            },
        )
        info = init.get("result", {}).get("serverInfo", {})
        if not info:
            print(json.dumps(init, indent=2), file=sys.stderr)
            return 1
        server.notify("notifications/initialized")

        if args.command == "tools":
            listing = server.request("tools/list", {})
            for tool in listing.get("result", {}).get("tools", []):
                print(tool["name"])
            return 0

        if args.command == "tabs":
            tool, payload = "browser_tab_list", {}
        else:
            if not args.tool:
                parser.error("call needs a tool name")
            tool, payload = args.tool, json.loads(args.arguments)

        reply = server.request("tools/call", {"name": tool, "arguments": payload})
        result = reply.get("result", reply.get("error"))
        if isinstance(result, dict) and result.get("isError"):
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 1
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    finally:
        server.close()


if __name__ == "__main__":
    sys.exit(main())
