// Runs the MCP server against stand-in `xcrun` and `adb` scripts:
//   node --test mods/codex/device-screenshot/tests/

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MOD = dirname(dirname(fileURLToPath(import.meta.url)))

// A 1x1 PNG, what every stand-in capture writes.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const SIMCTL_BOOTED = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ udid: 'SIM-1', name: 'iPhone 17 Pro', state: 'Booted' }] },
})

const DEVICECTL_DEVICES = JSON.stringify({
  result: {
    devices: [
      {
        connectionProperties: { tunnelState: 'connected', transportType: 'wired' },
        hardwareProperties: { platform: 'iOS', udid: 'PHONE-1', marketingName: 'iPhone 14' },
        deviceProperties: { name: 'My iPhone' },
      },
      { connectionProperties: { tunnelState: 'unavailable' }, hardwareProperties: { platform: 'iOS', udid: 'PAD-1', marketingName: 'iPad Air' } },
    ],
  },
})

const ADB_DEVICES = [
  'List of devices attached',
  'RFCYA08AC7R            device usb:0-1 product:pa1qxeea model:SM_S931B device:pa1q transport_id:6',
  'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
  'emulator-5556          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2',
  'R58N12345              unauthorized usb:0-2 transport_id:7',
  '',
].join('\n')

const XCRUN = `#!/bin/sh
echo "xcrun $*" >> "$FAKE_LOG"
case "$1 $2" in
  "simctl list") cat "$FAKE/simctl.json" ;;
  "devicectl list") cp "$FAKE/devicectl.json" "$5" ;;
  "simctl io") cp "$FAKE/shot.png" "$5" ;;
  "devicectl device")
    while [ $# -gt 0 ]; do [ "$1" = --destination ] && out="$2"; shift; done
    if [ -n "$FAKE_LINK" ]; then ln -s "$FAKE/shot.png" "$out"; else cp "$FAKE/shot.png" "$out"; fi ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
`

const ADB = `#!/bin/sh
echo "adb $*" >> "$FAKE_LOG"
case "$*" in
  "devices -l") cat "$FAKE/adb-devices.txt" ;;
  "-s RFCYA08AC7R shell getprop ro.product.marketname") echo ;;
  "-s RFCYA08AC7R shell settings get global default_device_name") echo "Galaxy S25" ;;
  "-s RFCYA08AC7R shell settings get global device_name") echo "Adam's phone" ;;
  *"exec-out screencap -p") cat "$FAKE/shot.png" ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
`

const roots = []
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })))

/** A home, a TMPDIR and stand-in tools for one server. */
function world({ tmp } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'device-screenshot-test-')))
  roots.push(root)
  const fake = join(root, 'fake')
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  for (const dir of [fake, bin, home, join(root, 'tmp')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(fake, 'simctl.json'), SIMCTL_BOOTED)
  writeFileSync(join(fake, 'devicectl.json'), DEVICECTL_DEVICES)
  writeFileSync(join(fake, 'adb-devices.txt'), ADB_DEVICES)
  writeFileSync(join(fake, 'shot.png'), Buffer.from(PNG, 'base64'))
  writeFileSync(join(bin, 'xcrun'), XCRUN)
  writeFileSync(join(bin, 'adb'), ADB)
  chmodSync(join(bin, 'xcrun'), 0o755)
  chmodSync(join(bin, 'adb'), 0o755)

  return {
    root,
    home,
    log: join(root, 'calls.log'),
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: tmp ?? join(root, 'tmp'),
      FAKE: fake,
      FAKE_LOG: join(root, 'calls.log'),
    },
  }
}

/** Starts the server in `place`; `call` sends one request and resolves its answer. */
function serve(place, extraEnv = {}) {
  const child = spawn(process.execPath, [join(MOD, 'server.mjs')], {
    cwd: place.root,
    env: { ...place.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map()
  let buffer = ''
  let nextId = 0
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      waiting.get(message.id)?.(message)
    }
  })
  const call = (method, params = {}) =>
    new Promise(resolve => {
      nextId += 1
      waiting.set(nextId, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`)
    })
  const tool = async (name, args = {}) => (await call('tools/call', { name, arguments: args })).result

  return { call, tool, stop: () => child.stdin.end() }
}

function calls(place) {
  try {
    return readFileSync(place.log, 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

test('lists simulators, connected iPhones and ready Android devices by the names they sell under', async () => {
  const place = world()
  const server = serve(place)
  const listed = await server.tool('list_devices')
  server.stop()

  assert.deepEqual(listed.structuredContent.devices, [
    { id: 'SIM-1', name: 'iPhone 17 Pro', platform: 'ios', kind: 'simulator' },
    { id: 'PHONE-1', name: 'iPhone 14', platform: 'ios', kind: 'iphone' },
    { id: 'RFCYA08AC7R', name: 'Galaxy S25', platform: 'android', kind: 'android' },
    { id: 'emulator-5554', name: 'Android Emulator', platform: 'android', kind: 'android' },
    { id: 'emulator-5556', name: 'Android Emulator 2', platform: 'android', kind: 'android' },
  ])
  assert.match(listed.content[0].text, /iPhone 14/)
  assert.ok(!calls(place).some(line => line.endsWith('settings get global device_name')), 'never reads the name set in Settings')
})

test('take_screenshot returns the picture and saves it in a folder only this user can open', async () => {
  const place = world()
  const server = serve(place)
  const shot = await server.tool('take_screenshot', { device: 'iPhone 14' })
  server.stop()

  assert.equal(shot.isError, undefined)
  const image = shot.content.find(part => part.type === 'image')
  assert.deepEqual(image, { type: 'image', data: PNG, mimeType: 'image/png' })
  const dir = join(place.env.TMPDIR, 'codex-device-screenshots')
  assert.match(shot.structuredContent.path, new RegExp(`^${dir}/ios-iPhone-14-\\d{8}-\\d{6}-\\d{3}\\.png$`))
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.deepEqual(readFileSync(shot.structuredContent.path), Buffer.from(PNG, 'base64'))
  assert.ok(calls(place).some(line => line.startsWith('xcrun devicectl device capture screenshot --timeout 15 --device PHONE-1 --destination ')))
})

test('screenshots an Android device through adb exec-out, by name or by id', async () => {
  const place = world()
  const server = serve(place)
  const byName = await server.tool('take_screenshot', { device: 'android emulator 2' })
  const byId = await server.tool('take_screenshot', { device: 'emulator-5554' })
  server.stop()

  assert.equal(byName.structuredContent.device.id, 'emulator-5556')
  assert.equal(byId.structuredContent.device.id, 'emulator-5554')
  assert.equal(byId.content.find(part => part.type === 'image').data, PNG)
  assert.ok(calls(place).includes('adb -s emulator-5556 exec-out screencap -p'))
})

test('captures only a device it listed, so a made-up name never reaches a command', async () => {
  const place = world()
  const server = serve(place)
  const shot = await server.tool('take_screenshot', { device: '--help' })
  const unnamed = await server.tool('take_screenshot')
  server.stop()

  assert.equal(shot.isError, true)
  assert.match(shot.content[0].text, /No connected device is called "--help"\. Connected: iPhone 17 Pro, iPhone 14/)
  assert.equal(unnamed.isError, true)
  assert.match(unnamed.content[0].text, /^Say which device: /)
  assert.ok(!calls(place).some(line => line.includes('--help')))
})

test('refuses a capture that turns out to be a symlink', async () => {
  const place = world()
  const server = serve(place, { FAKE_LINK: '1' })
  const shot = await server.tool('take_screenshot', { device: 'PHONE-1' })
  server.stop()

  assert.equal(shot.isError, true)
  assert.equal(shot.content[0].text, 'iPhone 14: no picture came back.')
})

test('saves under ~/.cache when TMPDIR is the shared /tmp', async () => {
  const place = world({ tmp: '/tmp' })
  const server = serve(place)
  const shot = await server.tool('take_screenshot', { device: 'iPhone 17 Pro' })
  server.stop()

  assert.equal(dirname(shot.structuredContent.path), join(place.home, '.cache', 'codex-device-screenshots'))
})

test('open_panel is an MCP App tool whose panel resource is served as one', async () => {
  const place = world()
  const server = serve(place)
  const listed = (await server.call('tools/list')).result.tools
  const panel = listed.find(tool => tool.name === 'open_panel')
  const read = (await server.call('resources/read', { uri: panel._meta.ui.resourceUri })).result
  const missing = await server.call('resources/read', { uri: 'ui://device-screenshot/other.html' })
  const opened = await server.tool('open_panel')
  server.stop()

  assert.deepEqual(listed.map(tool => tool.name), ['open_panel', 'list_devices', 'take_screenshot'])
  assert.equal(panel._meta['openai/outputTemplate'], 'ui://device-screenshot/panel.html')
  assert.deepEqual(panel._meta['openai/ui'], { entrypoints: [{ type: 'thread' }, { type: 'global' }] })
  assert.deepEqual(panel.icons.map(icon => icon.theme), ['light', 'dark'])
  assert.match(panel.icons[0].src, /^data:image\/svg\+xml;base64,/)
  assert.equal(read.contents[0].mimeType, 'text/html;profile=mcp-app')
  assert.equal(read.contents[0]._meta['openai/widgetMinFrameHeight'], 0)
  assert.equal(read.contents[0]._meta['openai/widgetShowCodexWidgetInline'], true)
  assert.doesNotMatch(read.contents[0].text, /__VERSION__/)
  assert.equal(missing.error.code, -32002)
  assert.equal(opened.structuredContent.devices.length, 5)
})

test('answers initialize and ping, and refuses an unknown method', async () => {
  const place = world()
  const server = serve(place)
  const started = (await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} })).result
  const pinged = (await server.call('ping')).result
  const unknown = await server.call('sampling/createMessage')
  server.stop()

  assert.equal(started.protocolVersion, '2025-06-18')
  assert.deepEqual(started.capabilities, { tools: {}, resources: {} })
  assert.equal(started.serverInfo.version, JSON.parse(readFileSync(join(MOD, '.codex-plugin', 'plugin.json'), 'utf8')).version)
  assert.deepEqual(pinged, {})
  assert.equal(unknown.error.code, -32601)
})
