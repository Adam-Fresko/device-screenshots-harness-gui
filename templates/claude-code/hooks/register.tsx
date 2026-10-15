import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: '__MOD_NAME__',
      description: '__DESCRIPTION__',
    })

    return next(e)
  })

  on('command.run', { command: '__MOD_NAME__' }, async $ => ({
    text: `${$.plugin.name} is loaded.`,
  }))
}
