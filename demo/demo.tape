# VHS tape for the sandbox demo GIF — https://github.com/charmbracelet/vhs
#
#   npm run build            (run-demo.mjs imports ../dist)
#   vhs demo/demo.tape       (from the repo root)
#
# ⚠️  DOES NOT WORK ON WINDOWS as of vhs 0.11.0. Verified on Windows 11 with
# vhs, ttyd 1.7.7 and ffmpeg all installed and on PATH, and Chrome present:
# vhs prints the parsed tape, then hangs indefinitely — no ttyd process, no
# ffmpeg process, zero frames in its temp directory, no error on stderr, still
# idle at 0.3s CPU after 85 seconds. Reproduced with a two-line tape and with
# `Set Shell powershell`, so it is neither this tape nor the shell setting.
#
# On Windows record with ScreenToGif (winget install NickeManarin.ScreenToGif)
# or ffmpeg's gdigrab. This tape stays because it works on Linux and macOS, and
# is the reproducible option wherever it runs.
#
# Scripted rather than screen-captured on purpose: the output is re-recordable
# after any copy change instead of being a take you have to reproduce by hand,
# and it never accidentally films the rest of your desktop.
#
# Safe to publish. Act 1 reads the real environment of whoever runs it — that is
# the point — but values are redacted unless they are the planted DEMO_* fakes.
# See renderSecret() in demo/evil-mcp-server.mjs.

Output demo/sandbox-demo.gif

Set Shell bash
Set FontSize 15
Set Width 1080
Set Height 720
Set Padding 24
Set TypingSpeed 45ms
# Playback pauses so a reader can take in each act rather than seeing the whole
# thing resolve instantly — the demo itself finishes in about two seconds.
Set PlaybackSpeed 1.0

Hide
Type "clear" Enter
Show

Type "node demo/run-demo.mjs"
Sleep 700ms
Enter

# Act 1 lands almost immediately; hold on the leaked secrets.
Sleep 4s
# Act 2 and the takeaway.
Sleep 6s
Sleep 3s
