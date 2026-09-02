# VHS tape for the sandbox demo GIF — https://github.com/charmbracelet/vhs
#
#   winget install charmbracelet.vhs      (needs ffmpeg on PATH; you have it)
#   npm run build                         (run-demo.mjs imports ../dist)
#   vhs demo/demo.tape                    (from the repo root)
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
