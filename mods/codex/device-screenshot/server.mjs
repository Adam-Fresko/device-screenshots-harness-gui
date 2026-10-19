// The device-screenshot MCP server: finds connected iOS and Android devices,
// screenshots one, and serves the button panel the Codex desktop app draws.
// It speaks MCP over stdio (one JSON-RPC message per line) with Node's own modules only.

import { execFile, spawn } from 'node:child_process'
import { constants, promises as fs, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = JSON.parse(readFileSync(join(HERE, '.codex-plugin', 'plugin.json'), 'utf8')).version
const PANEL_HTML = readFileSync(join(HERE, 'assets', 'panel.html'), 'utf8').replaceAll('__VERSION__', VERSION)

/**
 * The mod's icon, for the sidebar entry and the side panel tab: dark on light themes, light
 * on dark ones. Keep it pure black and pure white: Codex redraws icons in its own text colour,
 * and an icon whose pixels aren't all one exact colour gets inverted first, which made the
 * light icon near-invisible on a dark theme.
 */
const ICONS = [
  ['light', 'icon.svg'],
  ['dark', 'icon-dark.svg'],
].map(([theme, file]) => ({
  src: `data:image/svg+xml;base64,${readFileSync(join(HERE, 'assets', file)).toString('base64')}`,
  mimeType: 'image/svg+xml',
  sizes: ['any'],
  theme,
}))

const PANEL_URI = 'ui://device-screenshot/panel.html'
const PANEL_MIME = 'text/html;profile=mcp-app'
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** Where screenshots go, under TMPDIR or ~/.cache. */
const DIR_NAME = 'codex-device-screenshots'

const SRGB_PROFILE = '/System/Library/ColorSync/Profiles/sRGB Profile.icc'

/** Image types a capture may come back as, by their first bytes. */
const IMAGE_TYPES = [
  { mimeType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
]

// Caches for the server's life; a new session starts a new server.
let dirMade
let adbFound
const androidNames = new Map()
let devices = []
let refreshing
let busy = false

/** Runs a command; undefined when it could not start or ran past its time. */
function run(argv, timeoutMs = 30_000) {
  return new Promise(resolve => {
    const options = { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }
    execFile(argv[0], argv.slice(1), options, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        resolve(undefined)
        return
      }
      resolve({ exitCode: error ? error.code : 0, stdout, stderr })
    })
  })
}

function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function lastLine(text) {
  return text.trim().split('\n').pop()?.trim() ?? ''
}

/**
 * One line of printable text, at most `max` characters: what a device or a tool said,
 * safe to draw. It keeps letters, marks, digits, punctuation, symbols and plain spaces,
 * so control, format, bidi, private-use and tag characters cannot hide or fake text.
 */
export function clean(text, max = 40) {
  const line = (String(text).split(/[\r\n\u2028\u2029]/)[0] ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/gu, '')
    .replace(/\p{Zs}+/gu, ' ')
    .trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

/** HOME as a home folder: an absolute path other than `/`, without a trailing slash. */
function homeOf(home) {
  const trimmed = home?.replace(/\/+$/, '')
  return trimmed !== undefined && trimmed.startsWith('/') ? trimmed : undefined
}

/**
 * Makes `dir` this user's own private folder, or says it cannot: it must end up a
 * real folder (no symlink) this user owns, under the home folder or a per-user temp
 * area, and chmod 700 must succeed.
 */
async function makePrivate(dir, home) {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const made = await fs.lstat(dir)
    const real = await fs.realpath(dir)
    const homes = home === undefined ? [] : [home, await fs.realpath(home).catch(() => home)]
    const isOwnPlace = homes.some(root => real.startsWith(`${root}/`)) || /^\/(private\/)?var\/folders\/|^\/run\/user\//.test(real)
    if (made.isSymbolicLink() || !made.isDirectory() || made.uid !== process.getuid() || !isOwnPlace) {
      return false
    }
    await fs.chmod(dir, 0o700)
    return true
  } catch {
    return false
  }
}

/**
 * The folder screenshots go in, private to this user: TMPDIR where it is the user's
 * own (macOS gives each user one), else ~/.cache; never a shared /tmp. Undefined
 * when neither can be made private, a symlink or someone else's folder there, say.
 */
async function shotsDir() {
  if (dirMade === undefined) {
    const tmp = process.env.TMPDIR
    const home = homeOf(process.env.HOME)
    const isShared = !tmp?.startsWith('/') || /^\/(private\/)?(var\/)?tmp\/?$/.test(tmp)
    for (const base of [isShared ? undefined : tmp, home && `${home}/.cache`]) {
      const dir = base && `${base.replace(/\/+$/, '')}/${DIR_NAME}`
      if (dir && (await makePrivate(dir, home))) {
        dirMade = dir
        break
      }
    }
  }

  return dirMade
}

async function findIos() {
  const found = []
  const sims = await run(['xcrun', 'simctl', 'list', 'devices', 'booted', '--json'])
  if (sims === undefined) {
    return found
  }

  for (const list of Object.values(parse(sims.stdout)?.devices ?? {})) {
    for (const sim of Array.isArray(list) ? list : []) {
      if (sim?.state === 'Booted' && typeof sim.udid === 'string') {
        found.push({ id: sim.udid, name: clean(sim.name ?? '') || 'Simulator', platform: 'ios', kind: 'simulator' })
      }
    }
  }

  // devicectl writes its JSON to a file; older Xcodes cannot write it to stdout.
  const dir = await shotsDir()
  const listed = `${dir}/devicectl-devices.json`
  const phones = dir === undefined ? undefined : await run(['xcrun', 'devicectl', 'list', 'devices', '--json-output', listed])
  if (phones?.exitCode === 0) {
    const text = await fs.readFile(listed, 'utf8').catch(() => '')
    for (const phone of parse(text)?.result?.devices ?? []) {
      const hardware = phone?.hardwareProperties ?? {}
      const link = phone?.connectionProperties ?? {}
      const id = hardware.udid ?? phone?.identifier
      const isReachable = link.tunnelState === 'connected' || link.transportType !== undefined
      if (hardware.platform === 'iOS' && isReachable && typeof id === 'string') {
        const name = clean(hardware.marketingName ?? phone.deviceProperties?.name ?? '') || 'iPhone'
        found.push({ id, name, platform: 'ios', kind: 'iphone' })
      }
    }
  }

  return found
}

async function findAdb() {
  const home = process.env.HOME
  const androidHome = process.env.ANDROID_HOME
  const sdkRoot = process.env.ANDROID_SDK_ROOT
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
      const ran = await run([adb, 'devices', '-l'])
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
async function androidName(adb, serial, model) {
  const known = androidNames.get(serial)
  if (known !== undefined) {
    return known
  }

  let name = 'Android Emulator'
  if (!serial.startsWith('emulator-')) {
    const ask = async args => {
      const said = (await run([adb, '-s', serial, 'shell', ...args]))?.stdout.trim() ?? ''
      return said === 'null' ? '' : said
    }
    // What a device says about itself is the device's to choose: one clean, short line.
    name = clean(await ask(['getprop', 'ro.product.marketname'])) ||
      clean(await ask(['settings', 'get', 'global', 'default_device_name'])) ||
      clean(model) ||
      'Android device'
  }
  androidNames.set(serial, name)

  return name
}

/** Android devices and emulators ready for adb; an unauthorized or offline one is left out. */
async function findAndroid() {
  const found = await findAdb()
  if (found === undefined) {
    return []
  }

  const ready = []
  for (const line of found.listed.split('\n')) {
    const [serial, state, ...rest] = line.trim().split(/\s+/)
    if (!serial || state === undefined || serial.startsWith('*') || serial === 'List') {
      continue
    }
    if (state === 'device') {
      const model = rest.join(' ').match(/\bmodel:(\S+)/)?.[1]?.replaceAll('_', ' ') ?? serial
      ready.push({ id: serial, name: await androidName(found.adb, serial, model), platform: 'android', kind: 'android' })
    }
  }

  return ready
}

/** Numbers devices that share a name, so every button says which it is. */
function named(list) {
  const seen = new Map()

  return list.map(device => {
    const count = (seen.get(device.name) ?? 0) + 1
    seen.set(device.name, count)
    return count === 1 ? device : { ...device, name: `${device.name} ${count}` }
  })
}

/** Reads the connected devices again. `isFresh` also reads the phones' names again. */
async function refresh(isFresh = false) {
  if (isFresh) {
    androidNames.clear()
  } else if (refreshing !== undefined) {
    return refreshing
  }
  const reading = (async () => named([...(await findIos()), ...(await findAndroid())]))()
  refreshing = reading
  try {
    devices = await reading
    return devices
  } finally {
    if (refreshing === reading) {
      refreshing = undefined
    }
  }
}

/** Runs adb's screencap straight into a new file, so the PNG's bytes stay intact. */
async function screencap(adb, serial, file, timeoutMs = 30_000) {
  let handle
  try {
    handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch {
    return { exitCode: 1, stdout: '', stderr: 'could not create the screenshot file' }
  }
  try {
    return await new Promise(resolve => {
      const child = spawn(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { stdio: ['ignore', handle.fd, 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', chunk => {
        stderr = (stderr + chunk).slice(-4_000)
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.on('error', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve(signal ? undefined : { exitCode: code ?? 1, stdout: '', stderr })
      })
    })
  } finally {
    await handle.close()
  }
}

async function shoot(device, file) {
  let ran
  if (device.kind === 'simulator') {
    ran = await run(['xcrun', 'simctl', 'io', device.id, 'screenshot', file])
  } else if (device.kind === 'iphone') {
    // An iPhone that just dropped off makes devicectl wait for it; cap the wait.
    const argv = ['xcrun', 'devicectl', 'device', 'capture', 'screenshot', '--timeout', '15']
    ran = await run([...argv, '--device', device.id, '--destination', file], 20_000)
    if (ran?.exitCode !== 0) {
      // An older devicectl has no `capture`; libimobiledevice may still work.
      const fallback = await run(['idevicescreenshot', '-u', device.id, file], 20_000)
      ran = fallback?.exitCode === 0 ? fallback : ran
    }
  } else {
    const adb = adbFound ?? (await findAdb())?.adb
    if (adb === undefined) {
      return 'adb was not found: install Android platform-tools or set ANDROID_HOME.'
    }
    ran = await screencap(adb, device.id, file)
  }

  if (ran === undefined) {
    return `${device.name}: the capture did not start or timed out.`
  }
  if (ran.exitCode !== 0) {
    return `${device.name}: ${clean(lastLine(ran.stderr) || lastLine(ran.stdout), 200) || `exit ${ran.exitCode}`}`
  }

  return undefined
}

/** The picture a capture wrote: only a regular, non-empty image file, never a symlink. */
async function readPicture(file) {
  let handle
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0) {
      return undefined
    }
    const data = await handle.readFile()
    const type = IMAGE_TYPES.find(({ magic }) => magic.every((byte, i) => data[i] === byte))
    return type === undefined ? undefined : { data, mimeType: type.mimeType }
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * An iPhone hands back a 16-bit Display P3 PNG, several times the size of an 8-bit
 * one and sent again with every turn. Where macOS's sips can, the saved file becomes
 * an 8-bit sRGB PNG; elsewhere, or when sips fails, the picture stays as it came.
 */
async function slimmed(file, picture) {
  const isDeepPng = picture.mimeType === 'image/png' && picture.data[24] === 16
  if (!isDeepPng || (await fs.stat(SRGB_PROFILE).catch(() => undefined)) === undefined) {
    return picture
  }
  const slim = `${file.slice(0, -'.png'.length)}-srgb.png`
  const ran = await run(['sips', '-s', 'format', 'png', '--matchTo', SRGB_PROFILE, file, '--out', slim])
  const made = ran?.exitCode === 0 ? await readPicture(slim) : undefined
  if (made?.mimeType !== 'image/png') {
    await fs.rm(slim, { force: true })
    return picture
  }
  await fs.rename(slim, file)

  return made
}

function stampOf(ms) {
  // 2026-10-15T18:15:30.123Z -> 20261015-181530-123
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19)
}

function slugOf(name) {
  return name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device'
}

/**
 * The device `wanted` names: its id or its name as list_devices gave it. Only listed
 * devices get captured, so what the model passes never reaches a command line.
 */
async function pick(wanted) {
  const find = list => {
    if (wanted === undefined || wanted === '') {
      return list.length === 1 ? list[0] : undefined
    }
    const key = String(wanted).trim().toLowerCase()
    return list.find(device => device.id === wanted) ?? list.find(device => device.name.toLowerCase() === key)
  }

  return find(devices) ?? find(await refresh())
}

/** Takes one device's screenshot: the picture and where it was saved, or what went wrong. */
async function capture(wanted) {
  const device = await pick(wanted)
  if (device === undefined) {
    const names = devices.map(listed => listed.name).join(', ')
    if (wanted === undefined || wanted === '') {
      return { error: devices.length === 0 ? 'No device is connected.' : `Say which device: ${names}.` }
    }
    return { error: `No connected device is called "${clean(wanted, 60)}". Connected: ${names || 'none'}.` }
  }
  if (busy) {
    return { error: 'A screenshot is already being taken.' }
  }

  busy = true
  try {
    const dir = await shotsDir()
    if (dir === undefined) {
      return { error: 'Could not make a private folder for screenshots.' }
    }
    const file = `${dir}/${device.platform}-${slugOf(device.name)}-${stampOf(Date.now())}.png`
    const problem = await shoot(device, file)
    if (problem !== undefined) {
      return { error: problem }
    }
    const picture = await readPicture(file)
    if (picture === undefined) {
      return { error: `${device.name}: no picture came back.` }
    }
    return { device, file, picture: await slimmed(file, picture) }
  } finally {
    busy = false
  }
}

function listText(list) {
  if (list.length === 0) {
    return 'No device is connected: no booted iOS simulator, no iPhone or iPad, and no Android device or emulator that adb lists as ready.'
  }

  return list.map(device => `- ${device.name} (${device.platform === 'ios' ? 'iOS' : 'Android'} ${device.kind}, id ${device.id})`).join('\n')
}

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false }
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

const TOOLS = [
  {
    name: 'open_panel',
    title: 'Device screenshots',
    description:
      'Show the device screenshot panel: a button for each connected iOS or Android device. The user presses one to screenshot that device and attach the picture to their message. Use it when the user asks for the device screenshot buttons or panel.',
    inputSchema: NO_INPUT,
    annotations: READ_ONLY,
    icons: ICONS,
    _meta: {
      ui: { resourceUri: PANEL_URI },
      'ui/resourceUri': PANEL_URI,
      'openai/outputTemplate': PANEL_URI,
      // Opens without Codex calling the tool: `thread` lists the panel in the menu of a
      // thread's side panel, where it stays open as a tab; `global` adds it to the sidebar.
      'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] },
      'openai/iconStyle': 'monochrome',
      'openai/toolInvocation/invoking': 'Looking for devices',
      'openai/toolInvocation/invoked': 'Device screenshots',
    },
  },
  {
    name: 'list_devices',
    title: 'List devices',
    description:
      'List the devices that can be screenshotted: booted iOS simulators, connected iPhones and iPads, and Android devices and emulators that adb lists as ready.',
    inputSchema: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: 'Read the Android phones\' names again instead of using the remembered ones.' } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'take_screenshot',
    title: 'Screenshot a device',
    description:
      'Screenshot one connected device and return the picture. `device` is a name or id from list_devices; leave it out when only one device is connected.',
    inputSchema: {
      type: 'object',
      properties: { device: { type: 'string', description: 'The device\'s name, such as "iPhone 14", or its id.' } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
]

function textResult(text, structuredContent, isError = false) {
  return { content: [{ type: 'text', text }], ...(structuredContent && { structuredContent }), ...(isError && { isError }) }
}

async function callTool(name, args = {}) {
  if (name === 'open_panel' || name === 'list_devices') {
    const list = await refresh(args.fresh === true)
    return textResult(listText(list), { devices: list })
  }
  if (name === 'take_screenshot') {
    const shot = await capture(typeof args.device === 'string' ? args.device : undefined)
    if (shot.error !== undefined) {
      return textResult(shot.error, undefined, true)
    }
    return {
      content: [
        { type: 'text', text: `Screenshot of ${shot.device.name}, saved at ${shot.file}.` },
        { type: 'image', data: shot.picture.data.toString('base64'), mimeType: shot.picture.mimeType },
      ],
      structuredContent: { device: shot.device, path: shot.file },
    }
  }

  return textResult(`Unknown tool: ${clean(name, 60)}`, undefined, true)
}

const PANEL_RESOURCE = {
  uri: PANEL_URI,
  name: 'device-screenshot-panel',
  title: 'Device screenshots',
  mimeType: PANEL_MIME,
}

async function handle(method, params = {}) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[1],
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'device-screenshot', title: 'Device Screenshot', version: VERSION },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {})
    case 'resources/list':
      return { resources: [PANEL_RESOURCE] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'resources/read':
      if (params.uri !== PANEL_URI) {
        throw Object.assign(new Error(`Unknown resource: ${clean(params.uri ?? '', 80)}`), { code: -32002 })
      }
      return {
        contents: [
          {
            uri: PANEL_URI,
            mimeType: PANEL_MIME,
            text: PANEL_HTML,
            _meta: {
              ui: { prefersBorder: true, permissions: { clipboardWrite: {} } },
              // In the conversation, one row of buttons: no 200px floor, no fold-away header.
              'openai/widgetHeightHint': 52,
              'openai/widgetMinFrameHeight': 0,
              'openai/widgetShowCodexWidgetInline': true,
              'openai/widgetPrefersBorder': true,
            },
          },
        ],
      }
    default:
      throw Object.assign(new Error(`Method not found: ${clean(method ?? '', 80)}`), { code: -32601 })
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Answers one JSON-RPC message; notifications get no answer. */
export async function answer(message, write = send) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return
  }
  const isRequest = message.id !== undefined && message.id !== null
  try {
    const result = await handle(message.method, message.params)
    if (isRequest) {
      write({ jsonrpc: '2.0', id: message.id, result })
    }
  } catch (error) {
    if (isRequest) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } })
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    const message = parse(line)
    if (message === undefined) {
      if (line.trim() !== '') {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      return
    }
    void answer(message)
  })
  lines.on('close', () => process.exit(0))
}
