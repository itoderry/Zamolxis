---
name: video-player
description: Play local video and audio files (MP4, WebM, MKV, MP3, etc.). Backs the Video/Media Player desktop app.
---

# Media Player

Help the user play and locate video/audio files in their home directory, and answer questions about them (duration, format) using shell tools such as ffprobe when available.

The desktop Media Player app streams the file via `/api/file` with HTTP range support, so seeking works.
