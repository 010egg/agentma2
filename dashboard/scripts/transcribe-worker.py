#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-kind", choices=("url", "file"), required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--output-name", required=True)
    parser.add_argument("--result-file", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language")
    return parser.parse_args()


def safe_workspace_write(workspace, output_name, text):
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.txt", output_name):
        raise RuntimeError("invalid output name")

    root = os.path.realpath(workspace)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    root_fd = os.open(root, directory_flags | nofollow)
    try:
        try:
            os.mkdir("transcripts", mode=0o700, dir_fd=root_fd)
        except FileExistsError:
            pass
        transcripts_fd = os.open("transcripts", directory_flags | nofollow, dir_fd=root_fd)
        try:
            output_flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC | nofollow
            output_fd = os.open(output_name, output_flags, 0o600, dir_fd=transcripts_fd)
            try:
                with os.fdopen(output_fd, "w", encoding="utf-8", closefd=True) as handle:
                    handle.write(text)
                    if text and not text.endswith("\n"):
                        handle.write("\n")
            except Exception:
                try:
                    os.close(output_fd)
                except OSError:
                    pass
                raise
        finally:
            os.close(transcripts_fd)
    finally:
        os.close(root_fd)


def redact(value):
    return re.sub(r"https?://\S+", "[media-url]", value or "")[-2000:]


def main():
    args = parse_args()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg unavailable")

    with tempfile.TemporaryDirectory(prefix="agentma-transcribe-worker-") as temp_dir:
        wav_path = os.path.join(temp_dir, "audio.wav")
        command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
        if args.source_kind == "url":
            command += ["-protocol_whitelist", "https,tls,tcp,crypto"]
        command += [
            "-i", args.source,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            wav_path,
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            raise RuntimeError("ffmpeg failed: " + redact(error.stderr)) from None

        import mlx_whisper

        options = {
            "path_or_hf_repo": args.model,
            "verbose": False,
            "condition_on_previous_text": False,
        }
        if args.language:
            options["language"] = args.language
        result = mlx_whisper.transcribe(wav_path, **options)
        text = str(result.get("text") or "").strip()

    safe_workspace_write(args.workspace, args.output_name, text)
    with open(args.result_file, "w", encoding="utf-8") as handle:
        handle.write(text)
    print("AGENTMA_TRANSCRIBE_RESULT=" + json.dumps({
        "outputPath": "transcripts/" + args.output_name,
    }, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"transcribe worker failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
