# Privacy policy: Device Screenshot (Claude Code)

Effective October 19, 2026.

Device Screenshot is a Claude Code mod by Adam Fresko. It adds buttons above the Claude Code prompt that screenshot an iOS or Android device connected to your computer. This policy covers the mod itself: the code in this folder, as installed from the Claude plugin directory or from [github.com/Adam-Fresko/mods-harness-gui](https://github.com/Adam-Fresko/mods-harness-gui).

## In short

The mod runs entirely on your computer. It collects nothing for its author or anyone else, has no server, opens no network connection, and sends nothing anywhere.

## What the mod reads

- **Your devices' screens**, when you press a device's button, and only that device's.
- **The list of connected devices**, from Apple's and Google's own developer tools (`xcrun simctl`, `xcrun devicectl` and `adb`), every 5 seconds while the buttons show. For an Android phone it reads the marketing name the phone reports, such as "Galaxy S25", and never the name set in the phone's settings, which often holds the owner's name.
- **These environment variables:** `HOME`, `TMPDIR`, `PATH`, `ANDROID_HOME` and `ANDROID_SDK_ROOT`, to find where to save screenshots and where `adb` is installed.

It reads no other file, and none of your Claude conversation, your prompt box included.

## What the mod stores

- **Screenshots**, on your computer only, in a folder that only your user account can open: `$TMPDIR/claude-device-screenshots/` on macOS, or `~/.cache/claude-device-screenshots/`. A screenshot shows whatever was on the device's screen, which can include personal information. The mod never deletes them; you can delete them at any time.
- **One setting**, whether you hid the buttons, in Claude Code's storage for plugins on your computer.

## What the mod sends, and to whom

Nothing, to no one. The mod has no analytics, no telemetry and no network access of its own.

A screenshot leaves your computer only if you attach it to a message, by pasting it or with the `@path` mention the mod can put in your prompt, and then send that message. Claude Code then sends it to Anthropic like any picture you attach, under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy), not this one.

The mod also puts a screenshot on your macOS clipboard when you press a button, replacing what was there.

## Third parties

The mod shares nothing with third parties. The developer tools it runs (Apple's Xcode tools, Google's Android platform-tools and libimobiledevice's `idevicescreenshot`) run on your computer and talk only to your own connected devices.

## Children

The mod is a developer tool and isn't meant for children under 18.

## Changes

A change to this policy is published in this file, with a new effective date. The file's history on GitHub shows every earlier version.

## Contact

Questions about this policy: open an issue at [github.com/Adam-Fresko/mods-harness-gui/issues](https://github.com/Adam-Fresko/mods-harness-gui/issues).
