export type Platform = 'ios' | 'android'

/** A device a screenshot can come from, as its button names it. */
export type Device = {
  id: string
  name: string
  platform: Platform
  kind: 'simulator' | 'iphone' | 'android'
}

/** How the last capture of a device ended, shown on its button for a moment. */
export type Finished = { id: string; isOk: boolean }

declare module 'claude-code' {
  interface PluginState {
    'device-screenshot': {
      devices: Device[]
      busy: string | null
      done: Finished | null
      isShown: boolean
      isHelpOpen: boolean
    }
  }
}
