import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import ShardingPanel from '../src/monitor/ShardingPanel.vue'
import { mockApi, mountApp } from './support/app'

/** Phase 3b spec §5: the read-only sharding overview. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const view = {
  shards: [
    { id: 'rs0', hosts: 'rs0/a:27017', draining: false, tags: ['eu'], collections: 1, chunks: 10 },
    { id: 'rs1', hosts: 'rs1/b:27017', draining: true, tags: [], collections: 1, chunks: 4 },
  ],
  balancer: { mode: 'full', inRound: true, rounds: 3, window: { start: '23:00', stop: '06:00' } },
  mongos: [
    { host: 'm1:27017', version: '7.0.1', upSeconds: 3600, ping: '2026-01-01T00:00:00.000Z', stale: true },
  ],
  collections: [
    {
      ns: 'crm.users',
      key: { email: 1 },
      unique: false,
      balancing: true,
      chunks: { rs0: 10, rs1: 4 },
      imbalance: 6,
      jumbo: 1,
    },
  ],
  more: false,
  refused: { mongos: 'not_permitted' },
}

describe('ShardingPanel (phase 3b §5)', () => {
  it('shows shards, the balancer, mongos and collections, and a refused part', async () => {
    mockApi({ 'GET connections/c1/server/sharding': () => [200, view] })
    const { wrapper } = mountApp(ShardingPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    const text = wrapper.text()
    for (const s of ['rs0/a:27017', 'eu', '23:00', 'm1:27017', 'crm.users', 'email'])
      expect(text).toContain(s)
    expect(wrapper.find('[data-shard-draining="rs1"]').exists()).toBe(true)
    expect(wrapper.find('[data-mongos-stale="m1:27017"]').exists()).toBe(true)
    expect(wrapper.find('[data-sharding-refused="mongos"]').text()).toContain('clusterMonitor')
  })

  it('filters by namespace and loads a collection detail with masked bounds as text', async () => {
    const asked: string[] = []
    mockApi({
      'GET connections/c1/server/sharding': (_b, url) => {
        asked.push(url.searchParams.get('ns') ?? '')
        return [200, view]
      },
      'GET connections/c1/server/sharding/detail': (_b, url) => [
        200,
        {
          ns: url.searchParams.get('ns'),
          shards: [{ shard: 'rs0', size: 2048, count: 10 }],
          jumbo: [{ shard: 'rs0', min: { email: '***' }, max: { email: '<b>x</b>' } }],
          refused: {},
        },
      ],
    })
    const { wrapper } = mountApp(ShardingPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    await wrapper.find('[data-sharding-ns]').setValue('crm')
    await wrapper.find('[data-sharding-filter]').trigger('submit')
    await flushPromises()
    expect(asked.at(-1)).toBe('crm')
    await wrapper.find('[data-sharding-detail="crm.users"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('***')
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.text()).toContain('2 KB')
  })

  it('says a shard’s size is hidden where personal data is hidden from you (twelfth review)', async () => {
    mockApi({
      'GET connections/c1/server/sharding': () => [200, view],
      'GET connections/c1/server/sharding/detail': (_b, url) => [
        200,
        {
          ns: url.searchParams.get('ns'),
          shards: [{ shard: 'rs0', size: null, count: 10 }],
          jumbo: [],
          refused: {},
          sizesHidden: true,
        },
      ],
    })
    const { wrapper } = mountApp(ShardingPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    await wrapper.find('[data-sharding-ns]').setValue('crm')
    await wrapper.find('[data-sharding-filter]').trigger('submit')
    await flushPromises()
    await wrapper.find('[data-sharding-detail="crm.users"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Hidden')
  })
})
