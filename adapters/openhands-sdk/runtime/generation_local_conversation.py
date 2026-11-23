#!/usr/bin/env python3
"""OpenHands SDK generation glue (W9, DD-HOST-002).

The kernel spawns this script exactly like any other declared CLI entry. The
script drives the real SDK `LocalConversation` API and prints one JSON object
on stdout:

    {"result": "<assistant text>"}

Model, base URL and API key come from the user's OpenHands Agent Server
persistence settings (`settings.json` under ``$OPENHANDS_SETTINGS``,
``$OH_PERSISTENCE_DIR`` or ``~/.openhands``). Nothing is hard-coded and the
credential is never printed, echoed or written anywhere. Missing or incomplete
settings fail closed with a named JSON error on stdout and a non-zero exit.

This file declares no capability of its own. The kernel records the actual
evidence stage from the probe; a successful generation is not a probe.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

SCHEMA_VERSION = "evoplug.openhands_generation/1"


def emit_error(code: str, message: str) -> int:
    sys.stdout.write(json.dumps({"error": {"code": code, "message": message}}) + "\n")
    return 2


def settings_path() -> Path:
    explicit = os.environ.get("OPENHANDS_SETTINGS")
    if explicit:
        return Path(explicit).expanduser()
    persistence = os.environ.get("OH_PERSISTENCE_DIR")
    if persistence:
        return Path(persistence).expanduser() / "settings.json"
    return Path.home() / ".openhands" / "settings.json"


def read_settings(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(str(path))
    with path.open("r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    if not isinstance(parsed, dict):
        raise ValueError("settings_root_not_object")
    return parsed


def llm_config(settings: dict) -> dict:
    for candidate in (settings.get("llm"), settings.get("agent", {}).get("llm") if isinstance(settings.get("agent"), dict) else None):
        if isinstance(candidate, dict):
            return candidate
    return settings


def main() -> int:
    prompt = sys.stdin.read()
    if prompt.strip() == "":
        return emit_error("openhands_prompt_empty", "no prompt was supplied on stdin")

    path = settings_path()
    try:
        settings = read_settings(path)
    except FileNotFoundError:
        return emit_error("openhands_settings_missing", f"settings not found at {path}")
    except (OSError, ValueError) as exc:
        return emit_error("openhands_settings_unreadable", str(exc))

    config = llm_config(settings)
    model = config.get("model")
    base_url = config.get("base_url")
    api_key = config.get("api_key")
    missing = [
        name
        for name, value in (("model", model), ("base_url", base_url), ("api_key", api_key))
        if not isinstance(value, str) or value == ""
    ]
    if missing:
        return emit_error("openhands_settings_incomplete", "missing: " + ",".join(missing))

    if os.environ.get("EVOPLUG_OPENHANDS_DRY_RUN") == "1":
        # Composition smoke test: never constructs an SDK client, never
        # contacts a provider, and still proves the settings were readable.
        sys.stdout.write(
            json.dumps(
                {
                    "schema_version": SCHEMA_VERSION,
                    "result": "",
                    "dry_run": True,
                    "settings_path": str(path),
                    "model": model,
                }
            )
            + "\n"
        )
        return 0

    try:
        from pydantic import SecretStr
        from openhands.sdk.agent import Agent
        from openhands.sdk.conversation.impl.local_conversation import LocalConversation
        from openhands.sdk.llm import LLM
    except ImportError as exc:  # pragma: no cover - depends on the pinned SDK
        return emit_error("openhands_sdk_import_failed", str(exc))

    workspace = os.environ.get("EVOPLUG_GENERATION_WORKSPACE") or os.getcwd()
    assistant_texts: list[str] = []

    def on_event(event: object) -> None:
        if type(event).__name__ != "MessageEvent":
            return
        message = getattr(event, "llm_message", None)
        role = getattr(message, "role", None)
        if role != "assistant":
            return
        content = getattr(message, "content", None) or []
        text = "".join(str(getattr(part, "text", "")) for part in content)
        if text:
            assistant_texts.append(text)

    try:
        llm = LLM(
            usage_id="agent",
            model=str(model),
            base_url=str(base_url),
            api_key=SecretStr(str(api_key)),
            num_retries=0,
            stream=False,
        )
        agent = Agent(llm=llm, tools=[], include_default_tools=[], mcp_config={}, agent_context=None)
        conversation = LocalConversation(
            agent=agent,
            workspace=workspace,
            persistence_dir=os.environ.get("OH_PERSISTENCE_DIR"),
            callbacks=[on_event],
            visualizer=None,
            max_iteration_per_run=2,
            delete_on_close=False,
        )
        try:
            conversation.send_message(prompt)
            conversation.run()
        finally:
            conversation.close()
    except BaseException as exc:  # noqa: BLE001 - surface a named failure, not a traceback
        return emit_error("openhands_conversation_failed", f"{type(exc).__name__}: {exc}")

    sys.stdout.write(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "result": "\n".join(assistant_texts),
                "message_count": len(assistant_texts),
            }
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
