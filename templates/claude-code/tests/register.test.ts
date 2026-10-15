import { expect, test } from 'claude-code/testing'

test('/__MOD_NAME__ answers that the mod is loaded', async $ => {
  const ran = await $.command.run({
    command: '__MOD_NAME__',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(ran.text).toBe('__MOD_NAME__ is loaded.')
})
