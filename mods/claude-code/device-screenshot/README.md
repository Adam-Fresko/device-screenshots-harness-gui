# device-screenshot (Claude Code)

A small button for each device that is connected or running, such as **📷 iPhone 14** and **📷 Android Emulator**. Press one to screenshot that device: the mod copies the picture to your clipboard, and a toast tells you to paste it. Press **⌘V** in the desktop app, or **Ctrl+V** in a terminal session, and it attaches as an image, the same as any picture you paste.

The buttons sit in a row above the prompt:

```
[ ↻ ] [ 📷 iPhone 14 ] [ 📷 Galaxy S25 ] [ 📷 Android Emulator ]          ?  ×
```

**?** opens an explanation under the buttons. The × in the corner hides the row. To bring it back:

- In the Claude desktop app, press **screenshots** in the footer under the prompt, between the permission mode and the model. It shows only while the row is hidden.
- In a terminal session, run `/device-screenshot`. Running it again hides the row. The desktop app may not offer this command, which is why it has the footer button.

The buttons show from the start, and the mod remembers whether you hid them for your next session.

While a capture runs, the button's 📷 turns into a spinner (`⠹ Galaxy S25`). It then shows ✓ for a moment, or ✕ if the capture failed.

While shown, the buttons follow your devices: the mod checks what's connected every 5 seconds, and **↻** checks right away. While hidden, it doesn't check. With no device connected, no 📷 buttons show, only **↻** and the other controls.

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

Screenshots are saved in `$TMPDIR/claude-device-screenshots/` as `<platform>-<device>-<time>.png`. Each press makes a new file, and the mod never deletes any.

## Develop

```bash
claude --plugin-dir mods/claude-code/device-screenshot
```

See the repo's `AGENTS.md` for the validate, test and type-check commands.
