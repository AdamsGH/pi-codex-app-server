# Record the shared-session demonstration

The README animation shows native Pi and Codex CLI sharing one session in two Herdr panes. It does not certify the Codex desktop or ChatGPT Remote Control interfaces.

Use a dark terminal at 160 columns by 40 rows. The accepted recording used Rio, Herdr 0.9.5, asciinema 3.2.1, Pi 1.2.0 and Codex CLI 0.162.1 in Arch WSL. Build the checkout on the Linux filesystem before recording.

Start recording in a clean working directory:

```sh
asciinema rec -c "herdr --session bridge-showcase" showcase.cast
```

In Herdr, start Pi with the built checkout:

```sh
pi -ne -ns -np --no-context-files -e /absolute/path/to/pi-codex-app-server
```

1. In Pi, send `Remember the code BRIDGE-42. Reply exactly: Pi connected.`
2. Run `/codex-server status`.
3. Split vertically with Ctrl+b followed by v, using Herdr's default bindings.
4. In the other pane, run the exact `codex --remote ... resume ...` command from status. Keep the same session ID.
5. In Codex, send `What code did I ask you to remember? Reply with only the code.` Verify that both clients show `BRIDGE-42`.
6. In Pi, send `Reply exactly: Both clients share this session.` Verify that both clients show the reply.
7. Detach with Ctrl+b followed by q to end recording.

Render with agg 1.9.0 and the same font family configured in Rio:

```sh
agg showcase.cast pi-codex-session.gif \
  --text-font-family "JetBrainsMono Nerd Font" \
  --font-size 20 --line-height 1.2 --theme dracula \
  --idle-time-limit 2 --fps-cap 15
```

Install the font where agg can discover it. Inspect the complete rendered animation at native resolution; selected-frame rendering can introduce artifacts absent from a full render. Keep the original cast so that font and playback changes do not require another recording.
