---
name: device-screenshot
description: Screenshot a connected iOS simulator, iPhone, iPad, Android device or emulator, or show the panel of device screenshot buttons. Use when the user wants to see, check or show what is on a device's or simulator's screen, or asks for the device screenshot buttons.
---

# Device Screenshot

This mod's MCP server, `device-screenshot`, has three tools:

- `open_panel` shows a panel with a button for each connected device. The user presses one, and that device's screenshot is added to their message as an attachment.
- `list_devices` lists the connected devices by name, platform and id.
- `take_screenshot` takes one device's screenshot and returns the picture to you. Pass the device's name or id as `device`; leave it out when only one device is connected.

## What to do

- The user invoked `$device-screenshot` with nothing else, or asked for the buttons or the panel: call `open_panel`. Then say in one line that pressing a device adds its screenshot to their message, and that they can keep the buttons open by picking Device screenshots from the side panel's menu.
- The user wants you to look at a device's screen (what an app shows, whether a change worked on the phone, a bug on the emulator): call `take_screenshot` and work from the picture. When more than one device is connected and the user didn't say which, call `list_devices` and pick the one they mean, or ask.
- A tool says no device is connected: say what it lists (booted iOS simulators, connected iPhones and iPads, and Android devices and emulators that adb lists as ready), and that iOS needs Xcode and Android needs adb.

`take_screenshot` also saves the picture in a private folder (`$TMPDIR/codex-device-screenshots/` or `~/.cache/codex-device-screenshots/`) and says the path. Don't delete those files; the user may want them.
