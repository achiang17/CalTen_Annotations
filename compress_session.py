#!/usr/bin/env python3
"""
compress_session.py — Compress .MOV files in a session folder to 720p H.264 .mp4.

Supports two modes:
  1. LOCAL mode (--local): Read/write files directly from a local Dropbox sync folder.
     No API calls needed — much faster for large files.
  2. API mode (default): Download from Dropbox API, compress, upload back.

Usage:
    # Local mode (requires Dropbox desktop app):
    python3 compress_session.py 02_25_2026_16_30_court1 --local ~/Dropbox/full_dataset

    # API mode:
    python3 compress_session.py 02_25_2026_16_30_court1 [--token TOKEN] [--dropbox-folder /full_dataset]

Examples:
    python3 compress_session.py 02_25_2026_16_30_court1 --local ~/Dropbox/full_dataset
    python3 compress_session.py 02_25_2026_16_30_court1 --local ~/Dropbox/full_dataset --resolution 1080
    python3 compress_session.py 02_25_2026_16_30_court1 --token-file token.txt
    python3 compress_session.py 02_25_2026_16_30_court1 --dropbox-folder "/Team Folder/full_dataset"

If using API mode and --token is not provided, you'll be prompted to paste your Dropbox access token.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

import urllib.request
import urllib.error


def dbx_api(token, endpoint, body):
    """Make a Dropbox API POST request."""
    url = f"https://api.dropboxapi.com/2{endpoint}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"  ERROR: Dropbox API {endpoint} failed: {e.code} {e.read().decode()}")
        sys.exit(1)


def dbx_download(token, path, local_path):
    """Download a file from Dropbox."""
    url = "https://content.dropboxapi.com/2/files/download"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Dropbox-API-Arg": json.dumps({"path": path}),
    })
    try:
        with urllib.request.urlopen(req) as resp:
            with open(local_path, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)  # 1 MB chunks
                    if not chunk:
                        break
                    f.write(chunk)
    except urllib.error.HTTPError as e:
        print(f"  ERROR: Download failed for {path}: {e.code} {e.read().decode()}")
        return False
    return True


def dbx_upload(token, path, local_path):
    """Upload a file to Dropbox (supports large files via upload sessions)."""
    file_size = os.path.getsize(local_path)
    chunk_size = 100 * 1024 * 1024  # 100 MB chunks

    if file_size <= chunk_size:
        # Simple upload for smaller files
        with open(local_path, "rb") as f:
            data = f.read()
        url = "https://content.dropboxapi.com/2/files/upload"
        req = urllib.request.Request(url, data=data, headers={
            "Authorization": f"Bearer {token}",
            "Dropbox-API-Arg": json.dumps({
                "path": path,
                "mode": "overwrite",
                "autorename": False,
                "mute": False,
            }),
            "Content-Type": "application/octet-stream",
        })
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            print(f"  ERROR: Upload failed for {path}: {e.code} {e.read().decode()}")
            return None
    else:
        # Upload session for large files
        with open(local_path, "rb") as f:
            # Start session
            chunk = f.read(chunk_size)
            url = "https://content.dropboxapi.com/2/files/upload_session/start"
            req = urllib.request.Request(url, data=chunk, headers={
                "Authorization": f"Bearer {token}",
                "Dropbox-API-Arg": json.dumps({"close": False}),
                "Content-Type": "application/octet-stream",
            })
            with urllib.request.urlopen(req) as resp:
                session_id = json.loads(resp.read().decode("utf-8"))["session_id"]

            offset = len(chunk)

            # Append chunks
            while True:
                chunk = f.read(chunk_size)
                if len(chunk) == 0:
                    break

                remaining = file_size - offset - len(chunk)
                if remaining <= 0:
                    # Final chunk — commit
                    url = "https://content.dropboxapi.com/2/files/upload_session/finish"
                    req = urllib.request.Request(url, data=chunk, headers={
                        "Authorization": f"Bearer {token}",
                        "Dropbox-API-Arg": json.dumps({
                            "cursor": {"session_id": session_id, "offset": offset},
                            "commit": {
                                "path": path,
                                "mode": "overwrite",
                                "autorename": False,
                                "mute": False,
                            },
                        }),
                        "Content-Type": "application/octet-stream",
                    })
                    try:
                        with urllib.request.urlopen(req) as resp:
                            return json.loads(resp.read().decode("utf-8"))
                    except urllib.error.HTTPError as e:
                        print(f"  ERROR: Upload finish failed: {e.code} {e.read().decode()}")
                        return None
                else:
                    # Append
                    url = "https://content.dropboxapi.com/2/files/upload_session/append_v2"
                    req = urllib.request.Request(url, data=chunk, headers={
                        "Authorization": f"Bearer {token}",
                        "Dropbox-API-Arg": json.dumps({
                            "cursor": {"session_id": session_id, "offset": offset},
                            "close": False,
                        }),
                        "Content-Type": "application/octet-stream",
                    })
                    try:
                        with urllib.request.urlopen(req) as resp:
                            resp.read()
                    except urllib.error.HTTPError as e:
                        print(f"  ERROR: Upload append failed: {e.code} {e.read().decode()}")
                        return None

                offset += len(chunk)

            # If we exited the loop without committing (empty final read), commit with empty data
            url = "https://content.dropboxapi.com/2/files/upload_session/finish"
            req = urllib.request.Request(url, data=b"", headers={
                "Authorization": f"Bearer {token}",
                "Dropbox-API-Arg": json.dumps({
                    "cursor": {"session_id": session_id, "offset": offset},
                    "commit": {
                        "path": path,
                        "mode": "overwrite",
                        "autorename": False,
                        "mute": False,
                    },
                }),
                "Content-Type": "application/octet-stream",
            })
            try:
                with urllib.request.urlopen(req) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                print(f"  ERROR: Upload finish failed: {e.code} {e.read().decode()}")
                return None


def compress_video(input_path, output_path, resolution=720, crf=23):
    """Compress a video with ffmpeg."""
    cmd = [
        "ffmpeg", "-i", input_path,
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", "medium",
        "-vf", f"scale=-2:{resolution}",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",  # Enables progressive download (important for streaming)
        "-y",  # Overwrite without asking
        output_path,
    ]
    print(f"  Compressing to {resolution}p (crf {crf})...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR: ffmpeg failed:\n{result.stderr[-500:]}")
        return False
    return True


def format_size(bytes_val):
    """Format bytes to human readable."""
    for unit in ["B", "KB", "MB", "GB"]:
        if bytes_val < 1024:
            return f"{bytes_val:.1f} {unit}"
        bytes_val /= 1024
    return f"{bytes_val:.1f} TB"


def main_local(args):
    """Local mode — compress files directly from a local Dropbox sync folder."""
    local_root = os.path.expanduser(args.local)
    session_dir = os.path.join(local_root, args.session)

    if not os.path.isdir(session_dir):
        print(f"ERROR: Session folder not found: {session_dir}")
        print(f"Make sure the Dropbox desktop app is syncing and the path is correct.")
        sys.exit(1)

    # Check ffmpeg
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except FileNotFoundError:
        print("ERROR: ffmpeg not found. Install it with: brew install ffmpeg")
        sys.exit(1)

    print(f"\nLooking for .MOV files in: {session_dir}")

    all_files = os.listdir(session_dir)
    mov_files = [f for f in all_files if f.lower().endswith(".mov")]
    existing_mp4s = {f.lower() for f in all_files if f.lower().endswith(".mp4")}

    if not mov_files:
        print("No .MOV files found in this session.")
        sys.exit(0)

    # Filter out already-compressed files
    to_compress = []
    for name in sorted(mov_files):
        compressed_name = name.rsplit(".", 1)[0] + "_compressed.mp4"
        if compressed_name.lower() in existing_mp4s:
            print(f"  SKIP: {name} (compressed version already exists)")
        else:
            to_compress.append(name)

    if not to_compress:
        print("\nAll videos already have compressed versions. Nothing to do.")
        sys.exit(0)

    print(f"\nFound {len(to_compress)} video(s) to compress:")
    total_original = 0
    for name in to_compress:
        size = os.path.getsize(os.path.join(session_dir, name))
        total_original += size
        print(f"  {name} ({format_size(size)})")

    print(f"\nTotal original size: {format_size(total_original)}")
    print(f"Output: {args.resolution}p, CRF {args.crf}")
    confirm = input("\nProceed? [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        sys.exit(0)

    # Process each video
    for i, name in enumerate(to_compress, 1):
        input_path = os.path.join(session_dir, name)
        compressed_name = name.rsplit(".", 1)[0] + "_compressed.mp4"
        output_path = os.path.join(session_dir, compressed_name)

        print(f"\n[{i}/{len(to_compress)}] {name}")

        original_size = os.path.getsize(input_path)

        if not compress_video(input_path, output_path, args.resolution, args.crf):
            continue

        compressed_size = os.path.getsize(output_path)
        ratio = compressed_size / original_size * 100 if original_size > 0 else 0
        print(f"  {format_size(original_size)} → {format_size(compressed_size)} ({ratio:.1f}%)")
        print(f"  Saved to: {output_path}")
        print(f"  Dropbox will auto-sync this file.")

    print("\nAll done!")


def main_api(args):
    """API mode — download from Dropbox, compress, upload back."""
    # Get token — from --token, --token-file, or prompt
    token = args.token
    if not token and args.token_file:
        with open(args.token_file, "r") as f:
            token = f.read().strip()
    if not token:
        token = input("Paste your Dropbox access token: ").strip()
    if not token:
        print("ERROR: No token provided.")
        sys.exit(1)

    # Check ffmpeg
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except FileNotFoundError:
        print("ERROR: ffmpeg not found. Install it with: brew install ffmpeg")
        sys.exit(1)

    folder_path = f"{args.dropbox_folder}/{args.session}"
    print(f"\nLooking for .MOV files in: {folder_path}")

    # List folder contents
    result = dbx_api(token, "/files/list_folder", {"path": folder_path})
    entries = result.get("entries", [])

    mov_files = [e for e in entries if e[".tag"] == "file" and e["name"].lower().endswith(".mov")]
    existing_mp4s = {e["name"].lower() for e in entries if e[".tag"] == "file" and e["name"].lower().endswith(".mp4")}

    if not mov_files:
        print("No .MOV files found in this session.")
        sys.exit(0)

    # Filter out already-compressed files
    to_compress = []
    for vf in mov_files:
        compressed_name = vf["name"].rsplit(".", 1)[0] + "_compressed.mp4"
        if compressed_name.lower() in existing_mp4s:
            print(f"  SKIP: {vf['name']} (compressed version already exists)")
        else:
            to_compress.append(vf)

    if not to_compress:
        print("\nAll videos already have compressed versions. Nothing to do.")
        sys.exit(0)

    print(f"\nFound {len(to_compress)} video(s) to compress:")
    total_original = 0
    for vf in to_compress:
        size = vf.get("size", 0)
        total_original += size
        print(f"  {vf['name']} ({format_size(size)})")

    print(f"\nTotal original size: {format_size(total_original)}")
    print(f"Output: {args.resolution}p, CRF {args.crf}")
    confirm = input("\nProceed? [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        sys.exit(0)

    # Process each video
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, vf in enumerate(to_compress, 1):
            name = vf["name"]
            dbx_path = vf["path_display"]
            compressed_name = name.rsplit(".", 1)[0] + "_compressed.mp4"
            compressed_dbx_path = f"{folder_path}/{compressed_name}"

            print(f"\n[{i}/{len(to_compress)}] {name}")

            # Download
            local_mov = os.path.join(tmpdir, name)
            print(f"  Downloading ({format_size(vf.get('size', 0))})...")
            if not dbx_download(token, dbx_path, local_mov):
                continue

            # Compress
            local_mp4 = os.path.join(tmpdir, compressed_name)
            if not compress_video(local_mov, local_mp4, args.resolution, args.crf):
                continue

            original_size = os.path.getsize(local_mov)
            compressed_size = os.path.getsize(local_mp4)
            ratio = compressed_size / original_size * 100 if original_size > 0 else 0
            print(f"  {format_size(original_size)} → {format_size(compressed_size)} ({ratio:.1f}%)")

            # Upload
            print(f"  Uploading to {compressed_dbx_path}...")
            result = dbx_upload(token, compressed_dbx_path, local_mp4)
            if result:
                print(f"  Done!")
            else:
                print(f"  Upload failed.")

            # Clean up local files unless --keep-local
            if not args.keep_local:
                os.remove(local_mov)
                if os.path.exists(local_mp4):
                    os.remove(local_mp4)

    print("\nAll done!")


def main():
    parser = argparse.ArgumentParser(description="Compress session videos on Dropbox")
    parser.add_argument("session", help="Session folder name (e.g. 02_25_2026_16_30_court1)")
    parser.add_argument("--local", metavar="PATH",
                        help="Local Dropbox sync folder path (e.g. ~/Dropbox/full_dataset). "
                             "Compresses files directly — no API download/upload needed.")
    parser.add_argument("--token", help="Dropbox access token (API mode only)")
    parser.add_argument("--token-file", help="Path to file containing Dropbox access token (API mode only)")
    parser.add_argument("--dropbox-folder", default="/full_dataset", help="Dropbox API folder path (API mode only)")
    parser.add_argument("--resolution", type=int, default=720, help="Output resolution height (default: 720)")
    parser.add_argument("--crf", type=int, default=23, help="Quality (18=high, 23=good, 28=small; default: 23)")
    parser.add_argument("--keep-local", action="store_true", help="Keep local temp files after upload (API mode only)")
    args = parser.parse_args()

    if args.local:
        main_local(args)
    else:
        main_api(args)


if __name__ == "__main__":
    main()
