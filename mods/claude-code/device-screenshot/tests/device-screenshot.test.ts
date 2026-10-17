import type { Engine } from 'claude-code/testing'
import type { FsStat, On, ProcessRunResult, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 15, 18, 15, 30, 123)
const STAMP = '20261015-181530-123'
const DIR = '/tmp/t/claude-device-screenshots'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PHONE = 'RFCYA08AC7R            device usb:0-1 product:pa1qxeea model:SM_S931B device:pa1q transport_id:6'
const EMULATOR = 'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1'
const LOCKED = 'R58N12345              unauthorized usb:0-2 transport_id:7'

const SIMCTL_BOOTED = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { udid: 'SIM-1', name: 'iPhone 17 Pro', state: 'Booted' },
    ],
  },
})

const DEVICECTL_DEVICES = JSON.stringify({
  result: {
    devices: [
      {
        connectionProperties: { tunnelState: 'connected', transportType: 'wired' },
        hardwareProperties: { platform: 'iOS', udid: 'PHONE-1', marketingName: 'iPhone 14' },
        deviceProperties: { name: 'My iPhone' },
      },
      {
        connectionProperties: { tunnelState: 'unavailable' },
        hardwareProperties: { platform: 'iOS', udid: 'PAD-1', marketingName: 'iPad Air' },
      },
    ],
  },
})

function ok(stdout = ''): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function failed(stderr: string): ProcessRunResult {
  return { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

type Answer = (argv: readonly string[]) => ProcessRunResult | undefined

/** Xcode with one booted simulator and one iPhone, adb with the given devices. */
function tools(adbLines: string[]): Answer {
  return argv => {
    const command = argv.slice(0, 3).join(' ')
    if (command === 'xcrun simctl list') return ok(SIMCTL_BOOTED)
    if (['xcrun devicectl list', 'xcrun simctl io', 'xcrun devicectl device'].includes(command)) return ok()
    if (command === 'adb devices -l') return ok(['List of devices attached', ...adbLines, ''].join('\n'))
    if (argv.includes('default_device_name')) return ok('Galaxy S25\n')
    if (argv.includes('device_name')) return ok('Urządzenie S25 użytkownika Adam\n')
    if (argv.includes('ro.product.marketname')) return ok('\n')
    if (argv[0] === '/bin/sh' || argv[0] === 'osascript') return ok()
    return undefined
  }
}

function copied(path: string): string[] {
  return ['osascript', '-e', 'on run argv', '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)', '-e', 'end run', path]
}

/**
 * The machine beneath the mod: device tools answered by `answer` (undefined:
 * not installed), and a prompt box holding "look at". `answer` can be swapped.
 */
function machine(
  on: On,
  answer: Answer,
  { isShown = true, env = { TMPDIR: '/tmp/t/', HOME: '/Users/me' } as Record<string, string> } = {},
) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, env)
  const world = {
    answer,
    devicectl: DEVICECTL_DEVICES,
    ran: [] as string[][],
    fills: [] as string[],
    toasts: [] as string[],
    redraws: 0,
    /** While set, screencap waits for it: a capture the test can look at mid-way. */
    hold: undefined as Promise<void> | undefined,
    /** What `$.fs.stat` says of a path: the screenshot folder a folder, everything else a file. */
    statOf: (path: string): FsStat =>
      path.endsWith('claude-device-screenshots')
        ? { kind: 'dir' as const, size: 96, mtimeMs: NOW, isLink: false }
        : { kind: 'file' as const, size: 1024, mtimeMs: NOW, isLink: false },
    /** The mod's `$.store`: what earlier sessions saved, the buttons shown unless a test says not. */
    saved: (isShown ? {} : { isShown: false }) as Record<string, unknown>,
    clock,
  }

  on('process.run', async ($, e) => {
    world.ran.push([...e.argv])
    if (e.argv[0] === '/bin/sh' && world.hold !== undefined) {
      await world.hold
    }
    const result = e.argv[0] === 'mkdir' || e.argv[0] === 'chmod' ? ok() : world.answer(e.argv)
    return result === undefined ? { deny: `${e.argv[0]}: not found` } : { value: result }
  })
  on('fs.stat', ($, e) => ({ value: world.statOf(e.path) }))
  on('fs.read', () => ({ value: world.devicectl }))
  on('ui.invalidate', async ($, e, next) => {
    const done = await next(e)
    world.redraws += 1
    return done
  })
  on('prompt.read', () => ({ value: { text: 'look at', cursor: 7 } }))
  on('prompt.fill', ($, e) => {
    world.fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: world.saved[e.key] }))
  on('store.set', ($, e) => {
    world.saved[e.key] = e.value
    return { value: undefined }
  })
  // The engine's own drawings beneath the mod: an empty band, and the footer's text.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  on('ui.render', { component: 'SessionMode' }, ($, e) => $.ui.resolve(e).Text({ children: ['engine modes'] }))

  return world
}

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp/project', surface: 'terminal', isInteractive: true })
}

type Drawing = { findAll: (q: { type?: string; key?: string }) => Promise<{ text: string; key: string | undefined }[]> }

/** ↻ and the device buttons, left to right; ?, × and the footer's toggle are left out. */
async function buttonLabels(ui: Drawing) {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons.filter(button => !['help', 'close', 'toggle'].includes(button.key ?? '')).map(button => button.text)
}

/** The band above the prompt, where the buttons are drawn. */
async function mountRow($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'device-screenshot', surface, component: 'AbovePrompt', props: BAND })
}

/** The footer under the prompt, where desktop offers "screenshots" while the buttons are hidden. */
async function mountFooter($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'device-screenshot', surface, component: 'SessionMode', props: { modes: ['focus'] } })
}

async function toggle($: Engine) {
  return $.command.run({
    command: 'device-screenshot',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
}

/** Presses a device's button, then lets the capture it schedules run. */
async function shoot(
  ui: { press: (target: { key: string }) => Promise<unknown> },
  world: ReturnType<typeof machine>,
  key: string,
) {
  await ui.press({ key })
  await world.clock.advance(0)
  await world.clock.settle()
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: one small button per connected device and a refresh, and no other text`, async ($, on) => {
    machine(on, tools([PHONE, EMULATOR, LOCKED]))
    await start($)
    const ui = await mountRow($, surface)

    const names = ['iPhone 17 Pro', 'iPhone 14', 'Galaxy S25', 'Android Emulator']
    expect(await buttonLabels(ui)).toEqual(['↻', ...names.map(name => (surface === 'terminal' ? `📷 ${name}` : name))])
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
  })

  test(`${surface}: a device's button copies only that device's screen, ready to paste`, async ($, on) => {
    const world = machine(on, tools([PHONE, EMULATOR]))
    await start($)
    const ui = await mountRow($, surface)
    await shoot(ui, world, 'shot:RFCYA08AC7R')

    const shot = `${DIR}/android-Galaxy-S25-${STAMP}.png`
    expect(world.ran).toContainEqual(['/bin/sh', '-c', '"$0" -s "$1" exec-out screencap -p > "$2"', 'adb', 'RFCYA08AC7R', shot])
    expect(world.ran).toContainEqual(copied(shot))
    expect(world.ran.some(argv => argv[0] === '/bin/sh' && argv.includes('emulator-5554'))).toBe(false)
    const paste = surface === 'terminal' ? 'Ctrl+V' : '⌘V'
    expect(world.toasts).toEqual([`Galaxy S25 copied. Press ${paste} to attach it.`])
    expect(world.fills).toEqual([])
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
  })
}

test('a failed capture says why in a toast and fills nothing', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  const working = world.answer
  world.answer = argv => (argv[0] === '/bin/sh' ? failed('error: device offline') : working(argv))
  await start($)
  const ui = await mountRow($, 'desktop')
  await shoot(ui, world, 'shot:RFCYA08AC7R')

  expect(world.toasts).toEqual(['Galaxy S25: error: device offline'])
  expect(world.fills).toEqual([])
  expect((await ui.find({ key: 'shot:RFCYA08AC7R' }))?.text).toBe('✕ Galaxy S25')
})

test('a capturing button spins, shows ✓ for a moment, then 📷 again', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  let release = () => {}
  world.hold = new Promise<void>(resolve => {
    release = resolve
  })
  await start($)
  const ui = await mountRow($, 'desktop')
  const label = async () => (await ui.find({ key: 'shot:RFCYA08AC7R' }))?.text
  await ui.press({ key: 'shot:RFCYA08AC7R' })
  await world.clock.advance(0)

  const spinning = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Galaxy S25$/
  const first = await label()
  expect(first).toMatch(spinning)
  await world.clock.advance(100)
  const second = await label()
  expect(second).toMatch(spinning)
  expect(second).not.toBe(first)

  release()
  await world.clock.settle()
  expect(await label()).toBe('✓ Galaxy S25')

  await world.clock.advance(1_500)
  expect(await label()).toBe('Galaxy S25')
})

test('devices that share a name are numbered', async ($, on) => {
  const second = 'emulator-5556          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2'
  machine(on, tools([EMULATOR, second]))
  await start($)
  const ui = await mountRow($, 'terminal')

  expect(await buttonLabels(ui)).toEqual(['↻', '📷 iPhone 17 Pro', '📷 iPhone 14', '📷 Android Emulator', '📷 Android Emulator 2'])
})

test('the buttons follow devices as they connect and leave', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  await start($)
  const ui = await mountRow($, 'desktop')
  expect(await buttonLabels(ui)).toContain('Galaxy S25')

  world.answer = tools([EMULATOR])
  await world.clock.advance(5_000)

  expect(await buttonLabels(ui)).toEqual(['↻', 'iPhone 17 Pro', 'iPhone 14', 'Android Emulator'])
})

test('↻ looks for devices at once, without waiting for the next check', async ($, on) => {
  const world = machine(on, tools([]))
  await start($)
  const ui = await mountRow($, 'desktop')
  expect(await buttonLabels(ui)).toEqual(['↻', 'iPhone 17 Pro', 'iPhone 14'])

  world.answer = tools([PHONE])
  await ui.press({ key: 'refresh' })

  expect(await buttonLabels(ui)).toEqual(['↻', 'iPhone 17 Pro', 'iPhone 14', 'Galaxy S25'])
})

test('an iPhone that is unplugged and off Wi-Fi leaves at the next check, with a redraw', async ($, on) => {
  const world = machine(on, tools([]))
  await start($)
  const ui = await mountRow($, 'desktop')
  expect(await buttonLabels(ui)).toEqual(['↻', 'iPhone 17 Pro', 'iPhone 14'])
  const before = world.redraws

  world.devicectl = DEVICECTL_DEVICES.replace('"tunnelState":"connected","transportType":"wired"', '"tunnelState":"unavailable"')
  await world.clock.advance(5_000)

  expect(await buttonLabels(ui)).toEqual(['↻', 'iPhone 17 Pro'])
  expect(world.redraws).toBeGreaterThan(before)
})

test('↻ redraws the buttons even when no device came or went', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  await start($)
  const ui = await mountRow($, 'desktop')
  const before = world.redraws
  await ui.press({ key: 'refresh' })

  expect(world.redraws).toBeGreaterThan(before)
  expect(world.toasts).toEqual([])
})

test('with no device connected, only ↻ shows', async ($, on) => {
  machine(on, () => undefined)
  await start($)
  const ui = await mountRow($, 'terminal')

  expect(await buttonLabels(ui)).toEqual(['↻'])
})

test('without a clipboard to copy to, the press adds an @path mention instead', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  const working = world.answer
  world.answer = argv => (argv[0] === 'osascript' ? undefined : working(argv))
  await start($)
  const ui = await mountRow($, 'terminal')
  await shoot(ui, world, 'shot:RFCYA08AC7R')

  expect(world.fills).toEqual([` @${DIR}/android-Galaxy-S25-${STAMP}.png `])
  expect(world.toasts).toEqual([])
})

test('with nothing saved, the buttons show', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  await start($)
  const ui = await mountRow($, 'desktop')

  expect(world.saved).toEqual({})
  expect(await buttonLabels(ui)).toEqual(['↻', 'iPhone 17 Pro', 'iPhone 14', 'Galaxy S25'])
})

test('hidden buttons look for no devices', async ($, on) => {
  const world = machine(on, tools([PHONE]), { isShown: false })
  await start($)
  await world.clock.advance(15_000)

  expect(world.ran.some(argv => argv[0] === 'xcrun' || argv[0] === 'adb')).toBe(false)
})

test('desktop footer: "screenshots" shows only while the buttons are hidden, and brings them back', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  await start($)
  const band = await mountRow($, 'desktop')
  const footer = await mountFooter($, 'desktop')

  expect(await footer.findAll({ type: 'Button' })).toEqual([])
  expect((await footer.find({ type: 'Text' }))?.text).toBe('engine modes')

  await band.press({ key: 'close' })
  expect(await band.findAll({ type: 'Button' })).toEqual([])
  expect((await footer.find({ type: 'Text' }))?.text).toBe('focus')
  expect((await footer.find({ key: 'toggle' }))?.text).toBe('screenshots')

  await footer.press({ key: 'toggle' })
  expect(await buttonLabels(band)).toEqual(['↻', 'iPhone 17 Pro', 'iPhone 14', 'Galaxy S25'])
  expect(await footer.findAll({ type: 'Button' })).toEqual([])
  expect(world.saved.isShown).toBe(true)
})

test('terminal footer: left to the engine, shown or hidden', async ($, on) => {
  machine(on, tools([PHONE]), { isShown: false })
  await start($)
  const footer = await mountFooter($, 'terminal')

  expect(await footer.findAll({ type: 'Button' })).toEqual([])
  expect((await footer.find({ type: 'Text' }))?.text).toBe('engine modes')
})

test('terminal: buttons hidden before stay hidden until /device-screenshot, and a second run hides them', async ($, on) => {
  const world = machine(on, tools([PHONE]), { isShown: false })
  await start($)

  const shown = await toggle($)
  expect(shown.text).toBeUndefined()
  const ui = await mountRow($, 'terminal')
  expect(await buttonLabels(ui)).toEqual(['↻', '📷 iPhone 17 Pro', '📷 iPhone 14', '📷 Galaxy S25'])
  expect(world.saved.isShown).toBe(true)

  await toggle($)
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  expect(world.saved.isShown).toBe(false)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the corner × hides the buttons and remembers it`, async ($, on) => {
    const world = machine(on, tools([PHONE]))
    await start($)
    const ui = await mountRow($, surface)
    const close = await ui.find({ key: 'close' })
    expect(close?.props.role).toBe('dismiss')
    expect(close?.text).toBe('×')

    await ui.press({ key: 'close' })

    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    expect(world.saved.isShown).toBe(false)
  })

  test(`${surface}: ? opens how the buttons work, and closes it again`, async ($, on) => {
    machine(on, tools([PHONE]))
    await start($)
    const ui = await mountRow($, surface)
    expect((await ui.find({ key: 'help' }))?.text).toBe('?')

    await ui.press({ key: 'help' })
    const help = await ui.findAll({ type: 'Text' })
    expect(help).toHaveLength(1)
    expect(help[0]?.text).toContain('Press a 📷 button to screenshot that device.')
    expect(help[0]?.text).toContain(surface === 'terminal' ? 'Ctrl+V' : '⌘V')
    expect(help[0]?.text).toContain(surface === 'terminal' ? '/device-screenshot' : '"screenshots" in the footer under the prompt')

    await ui.press({ key: 'help' })
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
  })
}

test('desktop draws a black-and-white Apple or Android logo before each device; terminals draw none', async ($, on) => {
  machine(on, tools([PHONE, EMULATOR]))
  await start($)
  const desktop = await mountRow($, 'desktop')
  const terminal = await mountRow($, 'terminal')

  const logos = await desktop.findAll({ type: 'Svg' })
  expect(logos.map(logo => logo.props.alt)).toEqual(['Apple', 'Apple', 'Android', 'Android'])
  expect(String(logos[0]?.props.source)).toContain('prefers-color-scheme:dark')
  expect(await terminal.findAll({ type: 'Svg' })).toEqual([])
})

test('the screenshot folder is made private', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  await start($)

  expect(world.ran).toContainEqual(['mkdir', '-m', '700', '-p', DIR])
  expect(world.ran).toContainEqual(['chmod', '700', DIR])
})

for (const tmp of [undefined, '/tmp', '/private/tmp/'] as const) {
  test(`with TMPDIR ${tmp ?? 'unset'}, screenshots go in ~/.cache, never a shared /tmp`, async ($, on) => {
    const env: Record<string, string> = tmp === undefined ? { HOME: '/Users/me' } : { TMPDIR: tmp, HOME: '/Users/me' }
    const world = machine(on, tools([PHONE]), { env })
    await start($)
    const ui = await mountRow($, 'desktop')
    await shoot(ui, world, 'shot:RFCYA08AC7R')

    expect(world.ran).toContainEqual(copied(`/Users/me/.cache/claude-device-screenshots/android-Galaxy-S25-${STAMP}.png`))
  })
}

test('a screenshot folder that is a symlink is refused: nothing is captured, and a toast says why', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  const real = world.statOf
  world.statOf = path => (path.endsWith('claude-device-screenshots') ? { kind: 'other' as const, size: 0, mtimeMs: NOW, isLink: true } : real(path))
  await start($)
  const ui = await mountRow($, 'desktop')
  await shoot(ui, world, 'shot:RFCYA08AC7R')

  expect(world.toasts).toEqual(['Could not make a private folder for screenshots.'])
  expect(world.ran.some(argv => argv[0] === '/bin/sh' || argv.includes('devicectl'))).toBe(false)
})

test('a capture that comes back as a symlink is not copied', async ($, on) => {
  const world = machine(on, tools([PHONE]))
  const real = world.statOf
  world.statOf = path => (path.endsWith('.png') ? { kind: 'other' as const, size: 0, mtimeMs: NOW, isLink: true } : real(path))
  await start($)
  const ui = await mountRow($, 'desktop')
  await shoot(ui, world, 'shot:RFCYA08AC7R')

  expect(world.toasts).toEqual(['Galaxy S25: no picture came back.'])
  expect(world.ran.some(argv => argv[0] === 'osascript')).toBe(false)
})

test('what a device calls itself is cut to one clean line of at most 40 characters', async ($, on) => {
  const second = 'R58N0000000            device usb:0-3 product:x model:Other transport_id:8'
  const working = tools([PHONE, second])
  machine(on, argv => {
    if (argv.includes('default_device_name')) {
      return ok(argv.includes('RFCYA08AC7R') ? 'Evil\u001b[31mPhone\nsecond line' : `${'W'.repeat(60)}\n`)
    }
    return working(argv)
  })
  await start($)
  const ui = await mountRow($, 'desktop')

  expect(await buttonLabels(ui)).toEqual(['↻', 'iPhone 17 Pro', 'iPhone 14', 'Evil[31mPhone', `${'W'.repeat(39)}…`])
})
