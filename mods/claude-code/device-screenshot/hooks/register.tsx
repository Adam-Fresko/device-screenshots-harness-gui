import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  EngineInterface,
  ProcessRunResult,
  Register,
  RenderElement,
  RenderSurface,
  SvgProps,
} from 'claude-code'

import type { Device, Finished, Platform } from '../types'

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

// Black-and-white platform logos drawn before a device's button on desktop: near
// black on a light theme, near white on a dark one. Apple's shape is Simple Icons' (CC0).
const LOGO_STYLE =
  '<style>.f{fill:#1d1d1f}.s{stroke:#1d1d1f}@media (prefers-color-scheme:dark){.f{fill:#f2f2f2}.s{stroke:#f2f2f2}}</style>'
const LOGO: Record<Platform, { source: string; alt: string }> = {
  ios: {
    alt: 'Apple',
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${LOGO_STYLE}<path class="f" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`,
  },
  android: {
    alt: 'Android',
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 4 24 16">${LOGO_STYLE}<path class="s" d="M7.3 10.3 5.2 6.4M16.7 10.3l2.1-3.9" fill="none" stroke-width="1.5" stroke-linecap="round"/><path class="f" fill-rule="evenodd" d="M2 19a10 10 0 0 1 20 0zM9.7 15a1.2 1.2 0 1 1-2.4 0a1.2 1.2 0 1 1 2.4 0zM16.7 15a1.2 1.2 0 1 1-2.4 0a1.2 1.2 0 1 1 2.4 0z"/></svg>`,
  },
}

// Terminals can't draw the logos, so their buttons start with a character instead: the
// Apple logo (U+F8FF, which macOS's fonts draw as the logo) and the usual robot for Android.
const GLYPH: Record<Platform, string> = { ios: '\uF8FF', android: '🤖' }

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
let adbEnv: { PATH: string } | undefined
const androidNames = new Map<string, string>()
let isRefreshing = false
let spin = 0

// Every command is written out in full where it runs, so the plugin directory's review
// can read each one; README.md lists them all.

/** A command's result; undefined when it could not start or ran past its time. */
async function settled(running: Promise<ProcessRunResult>): Promise<ProcessRunResult | undefined> {
  try {
    return await running
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

// Control, format and bidi characters: invisible, or able to make a name read as another.
/**
 * One line of printable text, at most `max` characters: what a device or a tool said,
 * safe to draw. It keeps letters, marks, digits, punctuation, symbols and plain spaces,
 * so control, format, bidi, private-use and tag characters cannot hide or fake text.
 */
function clean(text: string, max = 40): string {
  const line = (text.split(/[\r\n\u2028\u2029]/)[0] ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/gu, '')
    .replace(/\p{Zs}+/gu, ' ')
    .trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

/** HOME as a home folder: an absolute path other than `/`, without a trailing slash. */
function homeOf(home: string | undefined): string | undefined {
  const trimmed = home?.replace(/\/+$/, '')
  return trimmed !== undefined && trimmed.startsWith('/') ? trimmed : undefined
}

/**
 * Makes `dir` this user's own private folder, or says it cannot: it must end up a
 * real folder (no symlink) under the home folder or a per-user temp area, and chmod
 * 700 must succeed, which it does only on a folder this user owns.
 */
async function makePrivate($: EngineInterface, dir: string, home: string | undefined): Promise<boolean> {
  if ((await settled($.process.run(['mkdir', '-m', '700', '-p', dir])))?.exitCode !== 0) {
    return false
  }
  const made = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
  const real = made?.realPath ?? ''
  const isOwnPlace = (home !== undefined && real.startsWith(`${home}/`)) || /^\/(private\/)?var\/folders\/|^\/run\/user\//.test(real)
  if (made === undefined || made.isLink || made.kind !== 'dir' || !isOwnPlace) {
    return false
  }

  return (await settled($.process.run(['chmod', '700', dir])))?.exitCode === 0
}

/**
 * The folder screenshots go in, private to this user: TMPDIR where it is the user's
 * own (macOS gives each user one), else ~/.cache; never a shared /tmp. Undefined
 * when neither can be made private, a symlink or someone else's folder there, say.
 */
async function shotsDir($: EngineInterface): Promise<string | undefined> {
  if (dirMade === undefined) {
    const tmp = await $.env.get('TMPDIR')
    const home = homeOf(await $.env.get('HOME'))
    const isShared = tmp === undefined || /^\/(private\/)?(var\/)?tmp\/?$/.test(tmp)
    const bases = [isShared ? undefined : tmp, home && `${home}/.cache`]
    for (const base of bases) {
      const dir = base && `${base.replace(/\/+$/, '')}/claude-device-screenshots`
      if (dir && (await makePrivate($, dir, home))) {
        dirMade = dir
        break
      }
    }
  }

  return dirMade
}

async function findIos($: EngineInterface): Promise<Device[]> {
  const found: Device[] = []
  const sims = await settled($.process.run(['xcrun', 'simctl', 'list', 'devices', 'booted', '--json']))
  if (sims === undefined) {
    return found
  }

  for (const list of Object.values(parse<SimctlList>(sims.stdout)?.devices ?? {})) {
    for (const sim of list) {
      if (sim.state === 'Booted') {
        found.push({ id: sim.udid, name: clean(sim.name) || 'Simulator', platform: 'ios', kind: 'simulator' })
      }
    }
  }

  // devicectl writes its JSON to a file; older Xcodes cannot write it to stdout.
  const dir = await shotsDir($)
  const listed = `${dir}/devicectl-devices.json`
  const phones = dir === undefined ? undefined : await settled($.process.run(['xcrun', 'devicectl', 'list', 'devices', '--json-output', listed]))
  if (phones?.exitCode === 0) {
    const text = await $.fs.read(listed).catch(() => '')
    for (const phone of parse<DevicectlList>(text)?.result?.devices ?? []) {
      const hardware = phone.hardwareProperties ?? {}
      const link = phone.connectionProperties ?? {}
      const id = hardware.udid ?? phone.identifier
      const isReachable = link.tunnelState === 'connected' || link.transportType !== undefined
      if (hardware.platform === 'iOS' && isReachable && id !== undefined) {
        const name = clean(hardware.marketingName ?? phone.deviceProperties?.name ?? '') || 'iPhone'
        found.push({ id, name, platform: 'ios', kind: 'iphone' })
      }
    }
  }

  return found
}

/**
 * The environment `adb` runs in: PATH first, then the Android SDK's usual places,
 * so the command is always plain `adb`, wherever it is installed.
 */
async function androidEnv($: EngineInterface): Promise<{ PATH: string }> {
  if (adbEnv === undefined) {
    const home = await $.env.get('HOME')
    const androidHome = await $.env.get('ANDROID_HOME')
    const sdkRoot = await $.env.get('ANDROID_SDK_ROOT')
    const places = [
      await $.env.get('PATH'),
      androidHome && `${androidHome}/platform-tools`,
      sdkRoot && `${sdkRoot}/platform-tools`,
      home && `${home}/Library/Android/sdk/platform-tools`,
      home && `${home}/Android/Sdk/platform-tools`,
    ]
    adbEnv = { PATH: places.filter(place => place).join(':') }
  }

  return adbEnv
}

/** What `adb devices -l` lists; undefined when there is no adb. */
async function listAdb($: EngineInterface): Promise<string | undefined> {
  const ran = await settled($.process.run(['adb', 'devices', '-l'], { env: await androidEnv($) }))

  return ran?.stdout
}

/**
 * The name a phone sells under: its marketing name, else Samsung's default name
 * ("Galaxy S25"), else its model. Never the name set in Settings, which can hold
 * the owner's name. Every emulator is "Android Emulator".
 */
async function androidName($: EngineInterface, serial: string, model: string): Promise<string> {
  const known = androidNames.get(serial)
  if (known !== undefined) {
    return known
  }

  let name = 'Android Emulator'
  if (!serial.startsWith('emulator-')) {
    const env = await androidEnv($)
    const said = (ran: ProcessRunResult | undefined) => {
      const text = ran?.stdout.trim() ?? ''
      return text === 'null' ? '' : text
    }
    // What a device says about itself is the device's to choose: one clean, short line.
    name = clean(said(await settled($.process.run(['adb', '-s', serial, 'shell', 'getprop', 'ro.product.marketname'], { env })))) ||
      clean(said(await settled($.process.run(['adb', '-s', serial, 'shell', 'settings', 'get', 'global', 'default_device_name'], { env })))) ||
      clean(model) ||
      'Android device'
  }
  androidNames.set(serial, name)

  return name
}

/** Android devices and emulators ready for adb; an unauthorized or offline one is left out. */
async function findAndroid($: EngineInterface): Promise<Device[]> {
  const listed = await listAdb($)
  if (listed === undefined) {
    return []
  }

  const ready: Device[] = []
  for (const line of listed.split('\n')) {
    const [serial, state, ...rest] = line.trim().split(/\s+/)
    if (serial === undefined || state === undefined || serial.startsWith('*') || serial === 'List') {
      continue
    }
    if (state === 'device') {
      const model = rest.join(' ').match(/\bmodel:(\S+)/)?.[1]?.replaceAll('_', ' ') ?? serial
      const name = await androidName($, serial, model)
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
    ran = await settled($.process.run(['xcrun', 'simctl', 'io', device.id, 'screenshot', path]))
  } else if (device.kind === 'iphone') {
    // An iPhone that just dropped off makes devicectl wait for it; cap the wait.
    ran = await settled(
      $.process.run(
        ['xcrun', 'devicectl', 'device', 'capture', 'screenshot', '--timeout', '15', '--device', device.id, '--destination', path],
        { timeoutMs: 20_000 },
      ),
    )
    if (ran?.exitCode !== 0) {
      // An older devicectl has no `capture`; libimobiledevice may still work.
      const fallback = await settled($.process.run(['idevicescreenshot', '-u', device.id, path], { timeoutMs: 20_000 }))
      ran = fallback?.exitCode === 0 ? fallback : ran
    }
  } else {
    // `exec-out` keeps the PNG's bytes intact; a shell redirect writes them, and the
    // shell finds `adb` on the PATH `androidEnv` gives it.
    const env = await androidEnv($)
    ran = await settled($.process.run(['/bin/sh', '-c', '"$0" -s "$1" exec-out screencap -p > "$2"', 'adb', device.id, path], { env }))
  }

  if (ran === undefined) {
    return `${device.name}: the capture did not start or timed out.`
  }
  if (ran.exitCode !== 0) {
    return `${device.name}: ${clean(lastLine(ran.stderr) || lastLine(ran.stdout), 200) || `exit ${ran.exitCode}`}`
  }
  // Only a regular file this capture wrote goes on: never a symlink to something else.
  const saved = await $.fs.stat(path).catch(() => undefined)
  if (saved === undefined || saved.isLink || saved.kind !== 'file' || saved.size === 0) {
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
  const ran = await settled(
    $.process.run([
      'osascript',
      '-e',
      'on run argv',
      '-e',
      'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)',
      '-e',
      'end run',
      path,
    ]),
  )

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
  const dir = await shotsDir($)
  if (dir === undefined) {
    return { said: 'Could not make a private folder for screenshots.', isOk: false }
  }
  const stamp = stampOf(await $.clock.now())
  const path = `${dir}/${device.platform}-${slugOf(device.name)}-${stamp}.png`
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

/**
 * A device's button: a spinner while it captures, ✓ or ✕ for a moment after.
 * At rest a terminal's starts with the platform's character; a desktop draws its logo beside it.
 */
function labelOf(device: Device, running: string | null, finished: Finished | null, hasLogo: boolean): string {
  if (running === device.id) {
    return `${SPINNER[spin % SPINNER.length]} ${device.name}`
  }
  if (finished?.id === device.id) {
    return `${finished.isOk ? '✓' : '✕'} ${device.name}`
  }

  return hasLogo ? device.name : `${GLYPH[device.platform]} ${device.name}`
}

/** What ? says: how the buttons work, with this surface's paste key and toggle. */
function helpOf(surface: RenderSurface): string {
  const paste = surface === 'terminal' ? 'Ctrl+V' : '⌘V'

  return [
    `Press a device's button to screenshot it. The picture is copied to your clipboard: paste it into your message with ${paste}.`,
    '↻ looks for devices again; the list also updates every 5 seconds.',
    'Lists booted iOS simulators and connected iPhones (needs Xcode), and Android devices and emulators (needs adb).',
    surface === 'terminal'
      ? '× or /device-screenshot hide hides these buttons; /device-screenshot shows them again. [-] only folds them: ctrl+x ctrl+a unfolds.'
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

/** ↻ and a button per connected device, each after its platform's logo where `Svg` draws. */
async function deviceButtons(
  $: EngineInterface,
  Box: ElementConstructor<BoxProps>,
  Button: ElementConstructor<ButtonProps>,
  Svg: ElementConstructor<SvgProps> | undefined,
): Promise<RenderElement[]> {
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
    ...list.map(device => {
      const button = (
        <Button
          key={`shot:${device.id}`}
          label={labelOf(device, running, finished, Svg !== undefined)}
          // A capture can outlast a press's 10s budget, so it runs after the press returns.
          onPress={pressed => void $.clock.after(0, () => void press(device, pressed.surface))}
        />
      )
      // A Button holds only text, so the logo stands just before it.
      return Svg === undefined ? (
        button
      ) : (
        <Box alignItems="center">
          <Svg source={LOGO[device.platform].source} alt={LOGO[device.platform].alt} width={14} height={14} />
          {button}
        </Box>
      )
    }),
  ]
}

/** The band: ↻ and the devices on the left; ? and × on the right; the help under it. */
async function drawBand($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]): Promise<RenderElement> {
  const table = $.ui.resolve(e)
  const { Box, Button, Text } = table
  // Every table lists Svg, but a terminal draws it as nothing: logos only off the terminal.
  const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
  const isHelping = await read($, isHelpOpen)

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" columnGap={1}>
        <Box columnGap={1} flexWrap="wrap">
          {await deviceButtons($, Box, Button, Svg)}
        </Box>
        <Box columnGap={1}>
          <Button key="help" label="?" plain dimColor onPress={() => update($, isHelpOpen, open => !open)} />
          <Button key="close" label="×" role="dismiss" plain dimColor onPress={() => setShown($, false)} />
        </Box>
      </Box>
      {isHelping && <Text dimColor>{helpOf(e.surface)}</Text>}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'device-screenshot',
      description: 'Show the device screenshot buttons above the prompt; `hide` hides them',
      argumentHint: '[hide]',
      immediate: true,
    })
    // Shown unless hidden before: the desktop app lists no mod's slash command, so
    // a row that started hidden could not be brought back there.
    const shown = (await $.store.get(SHOWN_KEY)) !== false
    await update($, isShown, () => shown)
    if (shown) {
      await refresh($)
    }
    // Hidden buttons need no devices looked for. Shown ones are redrawn on every check
    // too: the desktop app drops the band when a turn ends (its own box takes the room
    // above the prompt) and asks for it again only when the next turn starts.
    $.clock.every(POLL_MS, async () => {
      if (await read($, isShown)) {
        await refresh($)
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  // Shows, rather than toggles: the terminal's own [-] folds the band without the mod
  // knowing, so a toggle run on folded buttons would hide them instead.
  on('command.run', { command: 'device-screenshot' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    if (wanted === 'hide') {
      await setShown($, false)
      return { text: 'Device screenshot buttons hidden. Run /device-screenshot to show them again.' }
    }
    if (wanted !== '' && wanted !== 'show') {
      return { text: 'Run /device-screenshot to show the buttons, or /device-screenshot hide to hide them.' }
    }
    await setShown($, true)

    return { text: 'Device screenshot buttons are above the prompt. If you folded them with [-], press ctrl+x ctrl+a.' }
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

    return drawBand($, e)
  })
}
