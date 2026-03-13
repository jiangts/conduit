#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sound_file="$script_dir/../assets/failure.wav"

play_with_afplay() {
  if [[ ! -f "$sound_file" ]]; then
    return 1
  fi

  if ! command -v afplay >/dev/null 2>&1; then
    return 1
  fi

  afplay "$sound_file" >/dev/null 2>&1
}

play_with_ffplay() {
  if [[ ! -f "$sound_file" ]]; then
    return 1
  fi

  if ! command -v ffplay >/dev/null 2>&1; then
    return 1
  fi

  ffplay -autoexit -nodisp -loglevel error "$sound_file" >/dev/null 2>&1
}

play_with_canberra() {
  if ! command -v canberra-gtk-play >/dev/null 2>&1; then
    return 1
  fi

  canberra-gtk-play -i dialog-error >/dev/null 2>&1
}

play_with_afplay || play_with_ffplay || play_with_canberra
