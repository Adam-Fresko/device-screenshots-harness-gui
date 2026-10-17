import { atom, read, update } from 'claude-code'
import type {
  ButtonProps,
  ElementConstructor,
  EngineInterface,
  ProcessRunResult,
  Register,
  RenderElement,
  RenderSurface,
} from 'claude-code'

import type { Device, Finished } from '../types'

const devices = atom({ plugin: 'device-screenshot', key: 'devices' } as const, [])
const busy = atom({ plugin: 'device-screenshot', key: 'busy' } as const, null)
const done = atom({ plugin: 'device-screenshot', key: 'done' } as const, null)
const isShown = atom({ plugin: 'device-screenshot', key: 'isShown' } as const, false)
const isHelpOpen = atom({ plugin: 'device-screenshot', key: 'isHelpOpen' } as const, false)

/** How often the list of connected devices is read again, while the buttons show. */
const POLL_MS = 5_000

/** Where `$.store` remembers, across sessions, whether the buttons show. */
const SHOWN_KEY = 'isShown'

/** The spinner a capturing device's button shows, one frame per SPIN_MS. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_MS = 100

/** How long ✓ or ✕ stays on a button after its capture. */
const DONE_MS = 1_500

type SimctlList = { devices?: Record<string, { udid: string; name: string; state: string }[]> }

type DevicectlList = {
  result?: {
    devices?: {
      identifier?: string
      connectionProperties?: { tunnelState?: string; transportType?: string }
      hardwareProperties?: { platform?: string; udid?: string; marketingName?: string }
      deviceProperties?: { name?: string }
    }[]
  }
}

// Caches for the module's life; a reload reads them again.
let dirMade: string | undefined
let adbFound: string | undefined
const androidNames = new Map<string, string>()
let isRefreshing = false
let spin = 0

/** Runs a command; undefined when it could not start or ran past its time. */
async function run(
  $: EngineInterface,
  argv: string[],
  timeoutMs = 30_000,
): Promise<ProcessRunResult | undefined> {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch {
    return undefined
  }
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop()?.trim() ?? ''
}

async function shotsDir($: EngineInterface): Promise<string> {
  if (dirMade === undefined) {
    const tmp = (await $.env.get('TMPDIR')) ?? '/tmp'
    const dir = `${tmp.replace(/\/+$/, '')}/claude-device-screenshots`
    await run($, ['mkdir', '-p', dir])
    dirMade = dir
  }

  return dirMade
}

/** Booted simulators and connected iPhones; none where Xcode is missing. */
async function findIos($: EngineInterface): Promise<Device[]> {
  const found: Device[] = []
  const sims = await run($, ['xcrun', 'simctl', 'list', 'devices', 'booted', '--json'])
  if (sims === undefined) {
    return found
  }

  for (const list of Object.values(parse<SimctlList>(sims.stdout)?.devices ?? {})) {
    for (const sim of list) {
      if (sim.state === 'Booted') {
        found.push({ id: sim.udid, name: sim.name, platform: 'ios', kind: 'simulator' })
      }
    }
  }

  // devicectl writes its JSON to a file; older Xcodes cannot write it to stdout.
  const listed = `${await shotsDir($)}/devicectl-devices.json`
  const phones = await run($, ['xcrun', 'devicectl', 'list', 'devices', '--json-output', listed])
  if (phones?.exitCode === 0) {
    const text = await $.fs.read(listed).catch(() => '')
    for (const phone of parse<DevicectlList>(text)?.result?.devices ?? []) {
      const hardware = phone.hardwareProperties ?? {}
      const link = phone.connectionProperties ?? {}
      const id = hardware.udid ?? phone.identifier
      const isReachable = link.tunnelState === 'connected' || link.transportType !== undefined
      if (hardware.platform === 'iOS' && isReachable && id !== undefined) {
        const name = hardware.marketingName ?? phone.deviceProperties?.name ?? 'iPhone'
        found.push({ id, name, platform: 'ios', kind: 'iphone' })
      }
    }
  }

  return found
}

async function findAdb($: EngineInterface): Promise<{ adb: string; listed: string } | undefined> {
  const home = await $.env.get('HOME')
  const androidHome = await $.env.get('ANDROID_HOME')
  const sdkRoot = await $.env.get('ANDROID_SDK_ROOT')
  const places = [
    adbFound,
    'adb',
    androidHome && `${androidHome}/platform-tools/adb`,
    sdkRoot && `${sdkRoot}/platform-tools/adb`,
    home && `${home}/Library/Android/sdk/platform-tools/adb`,
    home && `${home}/Android/Sdk/platform-tools/adb`,
  ]

  for (const adb of places) {
    if (adb) {
      const ran = await run($, [adb, 'devices', '-l'])
      if (ran !== undefined) {
        adbFound = adb
        return { adb, listed: ran.stdout }
      }
    }
  }

  return undefined
}

/**
 * The name a phone sells under: its marketing name, else Samsung's default name
 * ("Galaxy S25"), else its model. Never the name set in Settings, which can hold
 * the owner's name. Every emulator is "Android Emulator".
 */
async function androidName($: EngineInterface, adb: string, serial: string, model: string): Promise<string> {
  const known = androidNames.get(serial)
  if (known !== undefined) {
    return known
  }

  let name = 'Android Emulator'
  if (!serial.startsWith('emulator-')) {
    const ask = async (args: string[]) => {
      const said = (await run($, [adb, '-s', serial, 'shell', ...args]))?.stdout.trim() ?? ''
      return said === 'null' ? '' : said
    }
    name = (await ask(['getprop', 'ro.product.marketname'])) ||
      (await ask(['settings', 'get', 'global', 'default_device_name'])) ||
      model
  }
  androidNames.set(serial, name)

  return name
}

/** Android devices and emulators ready for adb; an unauthorized or offline one is left out. */
async function findAndroid($: EngineInterface): Promise<Device[]> {
  const found = await findAdb($)
  if (found === undefined) {
    return []
  }

  const ready: Device[] = []
  for (const line of found.listed.split('\n')) {
    const [serial, state, ...rest] = line.trim().split(/\s+/)
    if (serial === undefined || state === undefined || serial.startsWith('*') || serial === 'List') {
      continue
    }
    if (state === 'device') {
      const model = rest.join(' ').match(/\bmodel:(\S+)/)?.[1]?.replaceAll('_', ' ') ?? serial
      const name = await androidName($, found.adb, serial, model)
      ready.push({ id: serial, name, platform: 'android', kind: 'android' })
    }
  }

  return ready
}

/** Numbers devices that share a name, so every button says which it is. */
function named(list: Device[]): Device[] {
  const seen = new Map<string, number>()

  return list.map(device => {
    const count = (seen.get(device.name) ?? 0) + 1
    seen.set(device.name, count)
    return count === 1 ? device : { ...device, name: `${device.name} ${count}` }
  })
}

/**
 * Reads the connected devices again and redraws the buttons when the list
 * changed. `isFresh` (the person's ↻) also reads the phones' names again and
 * always redraws, even while a timed check is under way.
 */
async function refresh($: EngineInterface, isFresh = false): Promise<void> {
  if (isFresh) {
    androidNames.clear()
  } else if (isRefreshing) {
    return
  }
  isRefreshing = true
  try {
    const list = named([...(await findIos($)), ...(await findAndroid($))])
    const now = await read($, devices)
    const isChanged = JSON.stringify(now) !== JSON.stringify(list)
    if (isChanged) {
      await update($, devices, () => list)
    }
    // A write from a timer alone did not redraw the desktop's band; ask for it.
    if (isChanged || isFresh) {
      $.ui.invalidate('ui.render')
    }
  } finally {
    isRefreshing = false
  }
}

async function shoot($: EngineInterface, device: Device, path: string): Promise<string | undefined> {
  let ran: ProcessRunResult | undefined
  if (device.kind === 'simulator') {
    ran = await run($, ['xcrun', 'simctl', 'io', device.id, 'screenshot', path])
  } else if (device.kind === 'iphone') {
    // An iPhone that just dropped off makes devicectl wait for it; cap the wait.
    const argv = ['xcrun', 'devicectl', 'device', 'capture', 'screenshot', '--timeout', '15']
    ran = await run($, [...argv, '--device', device.id, '--destination', path], 20_000)
    if (ran?.exitCode !== 0) {
      // An older devicectl has no `capture`; libimobiledevice may still work.
      const fallback = await run($, ['idevicescreenshot', '-u', device.id, path], 20_000)
      ran = fallback?.exitCode === 0 ? fallback : ran
    }
  } else {
    const adb = adbFound ?? (await findAdb($))?.adb
    if (adb === undefined) {
      return 'adb was not found: install Android platform-tools or set ANDROID_HOME.'
    }
    // `exec-out` keeps the PNG's bytes intact; a shell redirect writes them.
    const script = '"$0" -s "$1" exec-out screencap -p > "$2"'
    ran = await run($, ['/bin/sh', '-c', script, adb, device.id, path])
  }

  if (ran === undefined) {
    return `${device.name}: the capture did not start or timed out.`
  }
  if (ran.exitCode !== 0) {
    return `${device.name}: ${lastLine(ran.stderr) || lastLine(ran.stdout) || `exit ${ran.exitCode}`}`
  }
  const saved = await $.fs.stat(path).catch(() => undefined)
  if (saved === undefined || saved.size === 0) {
    return `${device.name}: no picture came back.`
  }

  return undefined
}

function stampOf(ms: number): string {
  // 2026-10-15T18:15:30.123Z -> 20261015-181530-123
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19)
}

function slugOf(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device'
}

/** Puts the picture on the macOS clipboard as a PNG, so a paste attaches it as an image. */
async function copyImage($: EngineInterface, path: string): Promise<boolean> {
  const script = ['on run argv', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)', 'end run']
  const ran = await run($, ['osascript', ...script.flatMap(line => ['-e', line]), path])

  return ran?.exitCode === 0
}

/** Without a clipboard to copy to: an `@path` mention, which attaches the picture on send. */
async function mention($: EngineInterface, path: string): Promise<boolean> {
  const box = await $.prompt.read()
  const before = box.text.slice(0, box.cursor)
  const after = box.text.slice(box.cursor)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = /^\s/.test(after) ? '' : ' '
  const filled = await $.prompt.fill({ text: `${lead}@${path}${trail}`, mode: 'insert' })

  return filled.isFilled
}

/** Takes and copies one device's screenshot; says what to toast, and whether it went in. */
async function capture($: EngineInterface, device: Device, surface: RenderSurface): Promise<{ said?: string; isOk: boolean }> {
  const stamp = stampOf(await $.clock.now())
  const path = `${await shotsDir($)}/${device.platform}-${slugOf(device.name)}-${stamp}.png`
  const problem = await shoot($, device, path)
  if (problem !== undefined) {
    return { said: problem, isOk: false }
  }
  if (await copyImage($, path)) {
    return { said: `${device.name} copied. Press ${surface === 'terminal' ? 'Ctrl+V' : '⌘V'} to attach it.`, isOk: true }
  }
  if (await mention($, path)) {
    return { isOk: true }
  }

  return { said: `Saved ${path} but could not copy it or add it to the prompt.`, isOk: false }
}

/** Screenshots one device with a spinner on its button; resolves the toast to show, if any. */
async function screenshot($: EngineInterface, device: Device, surface: RenderSurface): Promise<string | undefined> {
  let isFree = false
  await update($, busy, now => {
    isFree = now === null
    return now ?? device.id
  })
  if (!isFree) {
    return 'A screenshot is already being taken.'
  }

  const spinning = $.clock.every(SPIN_MS, () => {
    spin += 1
    $.ui.invalidate('ui.render')
  })
  let ended = { isOk: false } as { said?: string; isOk: boolean }
  try {
    ended = await capture($, device, surface)
    return ended.said
  } finally {
    spinning.cancel()
    await update($, busy, () => null)
    await update($, done, () => ({ id: device.id, isOk: ended.isOk }))
    $.clock.after(DONE_MS, () => void update($, done, now => (now?.id === device.id ? null : now)))
  }
}

/** A device's button: a spinner while it captures, ✓ or ✕ for a moment after. */
function labelOf(device: Device, running: string | null, finished: Finished | null): string {
  if (running === device.id) {
    return `${SPINNER[spin % SPINNER.length]} ${device.name}`
  }
  if (finished?.id === device.id) {
    return `${finished.isOk ? '✓' : '✕'} ${device.name}`
  }

  return `📷 ${device.name}`
}

/** What ? says: how the buttons work, with this surface's paste key and toggle. */
function helpOf(surface: RenderSurface): string {
  const paste = surface === 'terminal' ? 'Ctrl+V' : '⌘V'

  return [
    `Press a 📷 button to screenshot that device. The picture is copied to your clipboard: paste it into your message with ${paste}.`,
    '↻ looks for devices again; the list also updates every 5 seconds.',
    'Lists booted iOS simulators and connected iPhones (needs Xcode), and Android devices and emulators (needs adb).',
    surface === 'terminal'
      ? '/device-screenshot or × hides these buttons; /device-screenshot shows them again.'
      : '× hides these buttons; "screenshots" in the footer under the prompt shows them again.',
  ].join(' ')
}

/** Shows or hides the buttons, and remembers it for the next session. */
async function setShown($: EngineInterface, shown: boolean): Promise<void> {
  await update($, isShown, () => shown)
  await $.store.set(SHOWN_KEY, shown)
  if (shown) {
    await refresh($, true)
  } else {
    await update($, isHelpOpen, () => false)
  }
  $.ui.invalidate('ui.render')
}

/** ↻ and a button per connected device, for the band above the prompt. */
async function deviceButtons($: EngineInterface, Button: ElementConstructor<ButtonProps>): Promise<RenderElement[]> {
  const list = await read($, devices)
  const running = await read($, busy)
  const finished = await read($, done)
  const press = async (device: Device, surface: RenderSurface) => {
    const said = await screenshot($, device, surface)
    if (said !== undefined) {
      $.ui.toast(said)
    }
  }

  return [
    <Button
      key="refresh"
      label="↻"
      onPress={() => refresh($, true).catch(error => $.ui.toast(`Could not look for devices: ${String(error)}`))}
    />,
    ...list.map(device => (
      <Button
        key={`shot:${device.id}`}
        label={labelOf(device, running, finished)}
        // A capture can outlast a press's 10s budget, so it runs after the press returns.
        onPress={pressed => void $.clock.after(0, () => void press(device, pressed.surface))}
      />
    )),
  ]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'device-screenshot',
      description: 'Show or hide the device screenshot buttons above the prompt',
      immediate: true,
    })
    // Shown unless hidden before: the desktop app lists no mod's slash command, so
    // a row that started hidden could not be brought back there.
    const shown = (await $.store.get(SHOWN_KEY)) !== false
    await update($, isShown, () => shown)
    if (shown) {
      await refresh($)
    }
    // Hidden buttons need no devices looked for.
    $.clock.every(POLL_MS, async () => {
      if (await read($, isShown)) {
        await refresh($)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'device-screenshot' }, async $ => {
    await setShown($, !(await read($, isShown)))

    return {}
  })

  // On desktop, the way back to hidden buttons: "screenshots" in the footer under the
  // prompt, between the permission mode and the model, shown only while they are hidden.
  // Terminals have /device-screenshot.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || (await read($, isShown))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box columnGap={1} alignItems="center">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="toggle" label="screenshots" plain dimColor onPress={() => setShown($, true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isShown))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isHelping = await read($, isHelpOpen)

    // ↻ and a button per device on the left; ? and the close × in the right corner.
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" columnGap={1}>
          <Box columnGap={1} flexWrap="wrap">
            {await deviceButtons($, Button)}
          </Box>
          <Box columnGap={1}>
            <Button key="help" label="?" plain dimColor onPress={() => update($, isHelpOpen, open => !open)} />
            <Button
              key="close"
              label={e.surface === 'terminal' ? '×' : 'Hide device buttons'}
              role="dismiss"
              plain
              dimColor
              onPress={() => setShown($, false)}
            />
          </Box>
        </Box>
        {isHelping && <Text dimColor>{helpOf(e.surface)}</Text>}
      </Box>
    )
  })
}
