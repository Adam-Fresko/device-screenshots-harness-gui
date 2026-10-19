# device-screenshot (Claude Code)

A small button for each device that is connected or running, such as **iPhone 14** and **Android Emulator**. Press one to screenshot that device: the mod copies the picture to your clipboard, and a toast tells you to paste it. Press **⌘V** in the desktop app, or **Ctrl+V** in a terminal session, and it attaches as an image, the same as any picture you paste.

The [Codex version](../../codex/device-screenshot) draws the same buttons in a panel in the conversation.

The buttons sit in a row above the prompt. In the desktop app, a black-and-white Apple or Android logo stands before each device's button. Terminals can't draw logos, so there each label starts with a character: the Apple logo () for iOS, which macOS's own fonts draw, and 🤖 for Android:

```
[ ↻ ] [  iPhone 14 ] [ 🤖 Galaxy S25 ] [ 🤖 Android Emulator ]          ?  ×
```

A terminal font that doesn't draw the Apple logo, such as some Nerd Fonts, may show a box or another symbol in its place.

**?** opens an explanation under the buttons. The × in the corner hides the row. To bring it back:

- In the Claude desktop app, press **screenshots** in the footer under the prompt, between the permission mode and the model. It shows only while the row is hidden.
- In a terminal session, run `/device-screenshot`. It always shows the row; `/device-screenshot hide` hides it, as × does. The desktop app may not offer this command, which is why it has the footer button.

In a terminal, Claude Code draws its own **[-]** beside the row. It folds the row rather than hiding it, and the mod can't see that: press **ctrl+x ctrl+a** to unfold it.

The buttons show from the start, and the mod remembers whether you hid them for your next session. While shown, the row is redrawn every 5 seconds, so it comes back on its own if the app clears the space above the prompt at the end of a turn.

While a capture runs, a spinner shows in front of the device's name (`⠹ Galaxy S25`). It then shows ✓ for a moment, or ✕ if the capture failed.

While shown, the buttons follow your devices: the mod checks what's connected every 5 seconds, and **↻** checks right away. While hidden, it doesn't check. With no device connected, no device buttons show, only **↻** and the other controls.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install device-screenshot --marketplace Adam-Fresko/mods-harness-gui
```

Answer `y` to add the marketplace, then pick a scope.

## Use

- **iOS**: a button for each booted iOS simulator (`xcrun simctl io <udid> screenshot`) and each connected iPhone or iPad (`xcrun devicectl device capture screenshot`). This was tested with Xcode 27. If your `devicectl` can't capture, the mod falls back to `idevicescreenshot` from libimobiledevice when it's installed.
- **Android**: a button for each device and emulator `adb devices` lists as ready (`adb exec-out screencap -p`). The mod looks for `adb` on `PATH`, then in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk` and `~/Android/Sdk`.

How a button names its device:

- An iPhone or iPad by its model, such as "iPhone 14". A simulator by its own name.
- An Android phone by its marketing name: the `ro.product.marketname` property where the phone sets it, else Samsung's default name (such as "Galaxy S25"), else its model (such as "Pixel 8"). The mod never uses the name set in **Settings > About phone**, because phones often put the owner's name there.
- Every Android emulator is "Android Emulator".
- Devices that share a name are numbered: "Android Emulator", "Android Emulator 2".

Each press replaces what's on your clipboard. Copying uses `osascript`, so it needs a Mac. Where it can't copy, the mod puts an `@path` mention for the picture into your prompt instead, and Claude Code attaches the picture when you send. If a capture fails, a toast says why.

Screenshots are saved as `<platform>-<device>-<time>.png` in a folder only you can open: `$TMPDIR/claude-device-screenshots/` (macOS gives each user a private `TMPDIR`), or `~/.cache/claude-device-screenshots/` when `TMPDIR` is unset or is the shared `/tmp`. The mod refuses a folder another user owns, one outside your home folder or per-user temp area, and a folder or a capture that turns out to be a symlink. Each press makes a new file, and the mod never deletes any.

## What it runs, reads and sends

**What it sends, and where: nothing, to no one.** The mod opens no network connection and calls no web service. A screenshot leaves your Mac only when you send a message with it attached; Claude Code then sends it to Anthropic like any picture you paste.

**Programs it starts, and why.** The mod starts programs through Claude Code's process call, and each command is written out in full where it runs in `hooks/register.tsx`. These are all of them. They talk only to your own devices, over USB or the local network a device is paired on.

- To find iOS devices, every 5 seconds while the buttons show and when you press **↻**: `xcrun simctl list devices booted --json` and `xcrun devicectl list devices --json-output <file>`
- To find Android devices, on the same checks: `adb devices -l`. To name a phone, once each: `adb -s <serial> shell getprop ro.product.marketname` and `adb -s <serial> shell settings get global default_device_name`. `adb` always runs by that name: the mod sets its `PATH` to yours followed by the `platform-tools` folders in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk` and `~/Android/Sdk`
- To take a screenshot, when you press a device's button: `xcrun simctl io <udid> screenshot <file>`, `xcrun devicectl device capture screenshot --timeout 15 --device <id> --destination <file>`, `idevicescreenshot -u <udid> <file>` when `devicectl` can't, or `adb -s <serial> exec-out screencap -p`, run as `/bin/sh -c '"$0" -s "$1" exec-out screencap -p > "$2"'` so the picture's bytes go straight into the file
- To put the picture on your clipboard: `osascript`, running `set the clipboard to (read (POSIX file <file>) as «class PNGf»)`
- To make the screenshot folder private: `mkdir -m 700 -p <folder>` and `chmod 700 <folder>`

`<udid>`, `<serial>` and `<id>` are only ever ids the listing commands reported; `<file>` and `<folder>` are paths in the mod's own screenshot folder.

**What it reads.**

- The environment variables `HOME`, `TMPDIR`, `PATH`, `ANDROID_HOME` and `ANDROID_SDK_ROOT`, to find the screenshot folder and `adb`
- The device list `devicectl` writes into the screenshot folder
- Your prompt box, only when it can't copy a picture to the clipboard: the text and the cursor position, to put an `@path` mention for the picture at the cursor, with a space on either side. It keeps none of that text and sends it nowhere. The mod reads nothing else of the conversation

**What it writes.** The screenshots and that device list, in the private folder described under Use; the `@path` mention above; and one setting in Claude Code's plugin storage: whether you hid the buttons.

**What each hook does.**

- `session.start`: registers the `/device-screenshot` command and starts the 5-second device check, then lets the session start as usual
- `command.run`, for `/device-screenshot` only: shows the buttons, or hides them with `hide`, and replies with a line saying so. It answers no other command
- `ui.render` for `AbovePrompt`: draws the row of buttons above the prompt, and leaves the space alone while a survey uses it or the buttons are hidden
- `ui.render` for `SessionMode`: in the desktop app only, while the buttons are hidden, adds the **screenshots** button to the footer under the prompt. Otherwise it draws the footer as usual

## License

MIT. See [LICENSE](LICENSE).

## Develop

```bash
claude --plugin-dir mods/claude-code/device-screenshot
```

See the repo's `AGENTS.md` for the validate, test and type-check commands.
