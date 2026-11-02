import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BulkSamples from '../src/documents/BulkSamples.vue'
import { i18n } from '../src/i18n'

beforeEach(() => {
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('BulkSamples', () => {
  // Twelfth review of explain masking (M-2): samples left out for repeating _ids say why.
  it('says why samples of documents that share an _id are not previewed', () => {
    const w = mount(BulkSamples, {
      props: {
        samples: { unavailable: 'repeats' },
        operation: 'update',
      },
      global: { plugins: [i18n] },
    })
    expect(w.text()).toContain('Some of these documents share their _id with another document')
    expect(w.text()).not.toContain('could not compute')
  })
})
