# device-screenshot (Codex)

A panel with a button for each device that is connected or running, such as **iPhone 14** and **Android Emulator**. Press one to screenshot that device: the picture is added to the message you are writing, as an attachment. Nothing is sent until you send it.

The Codex desktop app draws the panel. A black-and-white Apple or Android logo stands before each device's name:

```
[ ↻ ] [  iPhone 14 ] [  Galaxy S25 ] [  Android Emulator ]             ?
```

This is the Codex version of the [Claude Code mod](../../claude-code/device-screenshot). Codex gives a mod no space above the prompt, so here the buttons sit in a panel: a tab in the thread's side panel, a page in the sidebar, or a row in the conversation.

## Install

```bash
codex plugin marketplace add Adam-Fresko/mods-harness-gui
```

```bash
codex plugin add device-screenshot@mods-harness-gui
```

Then start a new thread.

## Use

**The panel.** Open it any of three ways:

- **In the side panel**, to keep the buttons beside the conversation: open the menu of the thread's side panel, on the right, and pick **Device screenshots**. It stays open as a tab while you work.
- **From the sidebar**: **Device Screenshot** opens the panel as a page. There is no message being written there, so a press copies the picture for you to paste into a thread.
- **In the conversation**: send `$device-screenshot`, or ask Codex for the device screenshot buttons. Codex opens the panel as one row under its reply.

- Press a device's button. A spinner shows in front of its name (`⠹ Galaxy S25`), then ✓ for a moment, or ✕ if the capture failed. A line under the buttons says what happened.
- **↻** looks for devices again. While the panel is on screen, it also checks every 5 seconds. Scrolled away, it stops checking.
- **?** explains the buttons.

If the app won't take the picture into your message, as on the sidebar page, the panel copies it to the clipboard instead and says to press **⌘V** in the message box. If that fails too, it says where the file is saved.

**Ask Codex.** Codex can screenshot a device itself, for example "screenshot the emulator and check the login screen". It calls `take_screenshot` and works from the picture.

The mod's MCP server, `device-screenshot`, has three tools:

| Tool | What it does |
| --- | --- |
| `open_panel` | Shows the panel. In the Codex CLI it returns the device list as text, since a terminal can't draw the panel. |
| `list_devices` | Lists the connected devices by name, platform and id. |
| `take_screenshot` | Screenshots one device, by its name or id, and returns the picture. With one device connected, the name can be left out. |

### Devices

- **iOS**: a button for each booted iOS simulator (`xcrun simctl io <udid> screenshot`) and each connected iPhone or iPad (`xcrun devicectl device capture screenshot`). If your `devicectl` can't capture, the mod falls back to `idevicescreenshot` from libimobiledevice when it's installed.
- **Android**: a button for each device and emulator `adb devices` lists as ready (`adb exec-out screencap -p`). The mod looks for `adb` on `PATH`, then in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk` and `~/Android/Sdk`.

How a button names its device:

- An iPhone or iPad by its model, such as "iPhone 14". A simulator by its own name.
- An Android phone by its marketing name: the `ro.product.marketname` property where the phone sets it, else Samsung's default name (such as "Galaxy S25"), else its model (such as "Pixel 8"). The mod never uses the name set in **Settings > About phone**, because phones often put the owner's name there.
- Every Android emulator is "Android Emulator".
- Devices that share a name are numbered: "Android Emulator", "Android Emulator 2".

`take_screenshot` captures only a device the mod found itself, so a name Codex makes up never reaches a command line.

### Files

Screenshots are saved as `<platform>-<device>-<time>.png` in a folder only you can open: `$TMPDIR/codex-device-screenshots/` (macOS gives each user a private `TMPDIR`), or `~/.cache/codex-device-screenshots/` when `TMPDIR` is unset or is the shared `/tmp`. The mod refuses a folder another user owns, one outside your home folder or per-user temp area, and a folder or a capture that turns out to be a symlink. Each press makes a new file, and the mod never deletes any.

An iPhone hands back a 16-bit Display P3 PNG, often 7 MB or more. On macOS the mod turns it into an 8-bit sRGB PNG with `sips`, about half the size, because every turn of the thread sends the picture again.

## Needs

- macOS for iOS devices (Xcode), and `adb` for Android.
- Node.js to run the MCP server. The Codex desktop app brings its own. The Codex CLI uses `node` from your `PATH`.

## Develop

```bash
node --test mods/codex/device-screenshot/tests/*.test.mjs
```

The tests run the server against stand-in `xcrun` and `adb` scripts, so they need no device. To try a change in Codex, re-run `codex plugin add device-screenshot@mods-harness-gui` and start a new thread. See the repo's `AGENTS.md` for the rest of the loop.

- `server.mjs`: the MCP server, on Node's own modules only.
- `assets/panel.html`: the panel. It talks to the Codex app over the MCP Apps protocol: `tools/call` to list devices and take a screenshot, then `ui/message` without sending, which adds the picture to your message.
- `skills/device-screenshot/SKILL.md`: tells Codex when to open the panel and when to take a screenshot itself.
