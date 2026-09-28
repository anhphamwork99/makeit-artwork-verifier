#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
SKILL_ROOT = SCRIPT_PATH.parents[1]
REPOSITORY_ROOT = SCRIPT_PATH.parents[4]
RUNS_ROOT = SKILL_ROOT / "evidence" / "runs"
SCRATCH_PREFIX = "makeit-artwork-verification-"
READINESS_TIMEOUT_SECONDS = 120


class VerificationError(RuntimeError):
    def __init__(self, classification: str, message: str):
        super().__init__(message)
        self.classification = classification


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_run_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{timestamp}-{random.randrange(0x10000):04x}"


def scratch_dir(run_id: str) -> Path:
    return Path(os.getenv("TMPDIR", "/tmp")) / f"{SCRATCH_PREFIX}{run_id}"


def evidence_dir(run_id: str) -> Path:
    return RUNS_ROOT / run_id


def state_path(run_id: str) -> Path:
    return scratch_dir(run_id) / "state.json"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def choose_owned_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_is_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_for_http(url: str, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + READINESS_TIMEOUT_SECONDS
    last_error = "no response"

    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise VerificationError(
                "ENVIRONMENT_FAILURE",
                f"Owned Next.js process exited with code {process.returncode} before readiness.",
            )
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 400:
                    return
                last_error = f"HTTP {response.status}"
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = str(error)
        time.sleep(0.5)

    raise VerificationError(
        "ENVIRONMENT_FAILURE",
        f"Owned Artwork Editor did not become ready within {READINESS_TIMEOUT_SECONDS}s: {last_error}",
    )


def launch(run_id: str, case_path: Path) -> tuple[subprocess.Popen[str], dict[str, Any]]:
    if not (REPOSITORY_ROOT / "package.json").is_file():
        raise VerificationError(
            "ENVIRONMENT_FAILURE",
            f"Repository root could not be resolved from {SCRIPT_PATH}.",
        )
    if not (REPOSITORY_ROOT / "node_modules").is_dir():
        raise VerificationError(
            "ENVIRONMENT_FAILURE",
            "node_modules is missing. Run pnpm install --frozen-lockfile before verification.",
        )
    if not case_path.is_file():
        raise VerificationError("HARNESS_BLOCKED", f"Test case does not exist: {case_path}")

    run_scratch = scratch_dir(run_id)
    run_evidence = evidence_dir(run_id)
    if run_scratch.exists():
        raise VerificationError(
            "HARNESS_BLOCKED",
            f"Owned scratch state already exists for run id {run_id}. Use cleanup first.",
        )
    if run_evidence.exists():
        raise VerificationError(
            "HARNESS_BLOCKED",
            f"Evidence already exists for run id {run_id}. Choose a new run id.",
        )

    run_scratch.mkdir(parents=True)
    run_evidence.mkdir(parents=True)
    port = choose_owned_port()
    base_url = f"http://127.0.0.1:{port}"
    server_log_path = run_evidence / "server.log"
    server_log = server_log_path.open("w", encoding="utf-8")
    env = os.environ.copy()
    env.update(
        {
            "NEXT_PUBLIC_MOCK_API": "true",
            "NEXT_PUBLIC_ARTWORK_VERIFICATION": "true",
            "NEXT_PUBLIC_APP_URL": base_url,
        }
    )
    command = [
        "pnpm",
        "exec",
        "next",
        "dev",
        "--turbopack",
        "--hostname",
        "127.0.0.1",
        "--port",
        str(port),
    ]
    try:
        process = subprocess.Popen(
            command,
            cwd=REPOSITORY_ROOT,
            env=env,
            stdout=server_log,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    except Exception:
        server_log.close()
        shutil.rmtree(run_scratch)
        raise
    finally:
        server_log.close()
    state = {
        "runId": run_id,
        "repository": str(REPOSITORY_ROOT),
        "case": str(case_path),
        "pid": process.pid,
        "processGroupId": process.pid,
        "port": port,
        "baseUrl": base_url,
        "startedAt": utc_now(),
        "evidenceDir": str(run_evidence),
        "scratchDir": str(run_scratch),
        "command": command,
    }
    write_json(state_path(run_id), state)
    write_json(
        run_evidence / "manifest.json",
        {
            **state,
            "phase": "launching",
            "cleanup": {"attempted": False, "complete": False},
        },
    )
    try:
        wait_for_http(f"{base_url}/artwork/editor", process)
    except Exception:
        cleanup = stop_owned_process(state)
        manifest = read_json(run_evidence / "manifest.json")
        manifest["phase"] = "launch-failed"
        manifest["cleanup"] = cleanup
        write_json(run_evidence / "manifest.json", manifest)
        raise
    manifest = read_json(run_evidence / "manifest.json")
    manifest["phase"] = "ready"
    manifest["readyAt"] = utc_now()
    write_json(run_evidence / "manifest.json", manifest)
    return process, state


def run_node(mode: str, state: dict[str, Any], case_path: Path) -> dict[str, Any]:
    evidence = Path(state["evidenceDir"])
    command = [
        "node",
        str(SKILL_ROOT / "scripts" / "drive-case.mjs"),
        mode,
        "--base-url",
        state["baseUrl"],
        "--case",
        str(case_path),
        "--evidence",
        str(evidence),
    ]
    process = subprocess.Popen(
        command,
        cwd=REPOSITORY_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout, stderr = process.communicate()
        (evidence / f"{mode}.stdout.log").write_text(stdout, encoding="utf-8")
        (evidence / f"{mode}.stderr.log").write_text(stderr, encoding="utf-8")
        raise

    completed_returncode = process.returncode
    (evidence / f"{mode}.stdout.log").write_text(stdout, encoding="utf-8")
    (evidence / f"{mode}.stderr.log").write_text(stderr, encoding="utf-8")
    if completed_returncode != 0:
        classification = "HARNESS_BLOCKED" if mode in {"doctor", "drive"} else "ENVIRONMENT_FAILURE"
        raise VerificationError(
            classification,
            f"{mode} helper exited with code {completed_returncode}. See {mode}.stderr.log.",
        )

    result_path = evidence / ("doctor.json" if mode == "doctor" else "result.json")
    if not result_path.is_file():
        raise VerificationError(
            "HARNESS_BLOCKED",
            f"{mode} helper did not create {result_path.name}.",
        )
    return read_json(result_path)


def stop_owned_process(state: dict[str, Any]) -> dict[str, Any]:
    pid = int(state["pid"])
    process_group_id = int(state["processGroupId"])
    port = int(state["port"])
    cleanup = {
        "attempted": True,
        "startedAt": utc_now(),
        "pid": pid,
        "processGroupId": process_group_id,
        "port": port,
        "terminated": False,
        "forced": False,
        "portClosed": False,
        "scratchRemoved": False,
    }

    try:
        os.killpg(process_group_id, signal.SIGTERM)
        cleanup["terminated"] = True
    except (ProcessLookupError, PermissionError):
        cleanup["terminated"] = True

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.2)
    else:
        try:
            os.killpg(process_group_id, signal.SIGKILL)
            cleanup["forced"] = True
        except (ProcessLookupError, PermissionError):
            pass

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and port_is_open(port):
        time.sleep(0.2)
    cleanup["portClosed"] = not port_is_open(port)

    run_scratch = Path(state["scratchDir"])
    if run_scratch.exists():
        shutil.rmtree(run_scratch)
    cleanup["scratchRemoved"] = not run_scratch.exists()
    cleanup["complete"] = cleanup["portClosed"] and cleanup["scratchRemoved"]
    cleanup["finishedAt"] = utc_now()
    return cleanup


def cleanup_run(run_id: str) -> dict[str, Any]:
    owned_state_path = state_path(run_id)
    if not owned_state_path.is_file():
        raise VerificationError(
            "HARNESS_BLOCKED",
            f"No owned scratch state exists for run id {run_id}.",
        )
    state = read_json(owned_state_path)
    if state.get("runId") != run_id or state.get("repository") != str(REPOSITORY_ROOT):
        raise VerificationError("HARNESS_BLOCKED", "Scratch ownership state did not match this repository.")
    cleanup = stop_owned_process(state)
    evidence = Path(state["evidenceDir"])
    manifest_path = evidence / "manifest.json"
    manifest = read_json(manifest_path) if manifest_path.is_file() else state
    manifest["cleanup"] = cleanup
    manifest["phase"] = "cleaned" if cleanup["complete"] else "cleanup-failed"
    write_json(manifest_path, manifest)
    return cleanup


def run_case(case_path: Path, run_id: str) -> int:
    process: subprocess.Popen[str] | None = None
    state: dict[str, Any] | None = None
    outcome = "ENVIRONMENT_FAILURE"
    error_message: str | None = None

    try:
        process, state = launch(run_id, case_path)
        doctor = run_node("doctor", state, case_path)
        manifest_path = Path(state["evidenceDir"]) / "manifest.json"
        manifest = read_json(manifest_path)
        manifest["phase"] = "doctor-passed"
        manifest["doctor"] = {"version": doctor["version"], "route": doctor["route"]}
        write_json(manifest_path, manifest)

        result = run_node("drive", state, case_path)
        outcome = str(result["outcome"])
        manifest = read_json(manifest_path)
        manifest["phase"] = "drive-complete"
        manifest["outcome"] = outcome
        write_json(manifest_path, manifest)
    except VerificationError as error:
        outcome = error.classification
        error_message = str(error)
    except subprocess.TimeoutExpired as error:
        outcome = "ENVIRONMENT_FAILURE"
        error_message = f"Verification command timed out: {error.cmd}"
    except Exception as error:  # noqa: BLE001 - top-level evidence boundary
        outcome = "HARNESS_BLOCKED"
        error_message = f"{type(error).__name__}: {error}"
    finally:
        cleanup: dict[str, Any] | None = None
        if state is not None:
            cleanup = stop_owned_process(state)
            evidence = Path(state["evidenceDir"])
            manifest_path = evidence / "manifest.json"
            manifest = read_json(manifest_path) if manifest_path.is_file() else state
            manifest["outcome"] = outcome
            manifest["error"] = error_message
            manifest["cleanup"] = cleanup
            manifest["phase"] = "complete" if cleanup["complete"] else "cleanup-failed"
            manifest["finishedAt"] = utc_now()
            write_json(manifest_path, manifest)
            if error_message:
                write_json(
                    evidence / "failure.json",
                    {
                        "outcome": outcome,
                        "message": error_message,
                        "runId": run_id,
                        "recordedAt": utc_now(),
                    },
                )
        elif error_message:
            fallback_evidence = evidence_dir(run_id)
            fallback_evidence.mkdir(parents=True, exist_ok=True)
            write_json(
                fallback_evidence / "failure.json",
                {
                    "outcome": outcome,
                    "message": error_message,
                    "runId": run_id,
                    "recordedAt": utc_now(),
                },
            )

    print(
        json.dumps(
            {
                "runId": run_id,
                "outcome": outcome,
                "evidence": str(evidence_dir(run_id)),
                "error": error_message,
            }
        )
    )
    return 0 if outcome == "PASS" else 2


def main() -> int:
    parser = argparse.ArgumentParser(description="Owned MakeIt Artwork Editor verification runner")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--case", required=True, type=Path)
    run_parser.add_argument("--run-id", default=default_run_id())

    cleanup_parser = subparsers.add_parser("cleanup")
    cleanup_parser.add_argument("--run-id", required=True)

    args = parser.parse_args()

    try:
        if args.command == "run":
            case_path = args.case.resolve()
            return run_case(case_path, args.run_id)
        cleanup = cleanup_run(args.run_id)
        print(json.dumps({"runId": args.run_id, "cleanup": cleanup}))
        return 0 if cleanup["complete"] else 2
    except VerificationError as error:
        print(
            json.dumps(
                {
                    "outcome": error.classification,
                    "error": str(error),
                }
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
