// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Decimal128, MongoClient, ObjectId } from 'mongodb'

/**
 * README and Product Hunt media (2026-10-31): a small, made-up store — products, customers, orders
 * and events — so the screenshots and the video show a database as one would have it. Every name,
 * address and e-mail is invented (example.com); a fixed seed draws the same data every run.
 */
export const MEDIA_DB = 'acme'

export async function seedStore(uri: string): Promise<void> {
  const client = new MongoClient(uri)
  try {
    const db = client.db(MEDIA_DB)
    await db.dropDatabase()
    let seed = 11
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
    const first = [
      'Ada',
      'Liam',
      'Mila',
      'Noah',
      'Sofia',
      'Kenji',
      'Amara',
      'Lucas',
      'Elif',
      'Mateo',
      'Aiko',
      'Omar',
    ]
    const last = [
      'Lovelace',
      'Moreau',
      'Silva',
      'Novak',
      'Tanaka',
      'Okafor',
      'Rossi',
      'Kaya',
      'Jensen',
      'Weber',
    ]
    const cities = [
      'Berlin',
      'Lisbon',
      'Tokyo',
      'Toronto',
      'Istanbul',
      'Amsterdam',
      'Austin',
      'Seoul',
      'Paris',
    ]
    const products = Array.from({ length: 48 }, (_, i) => ({
      _id: new ObjectId(),
      sku: `SKU-${2000 + i}`,
      name: `${pick(['Linen', 'Oak', 'Copper', 'Wool', 'Glass', 'Stone', 'Cotton', 'Walnut'])} ${pick(['Lamp', 'Chair', 'Mug', 'Throw', 'Vase', 'Desk', 'Bowl', 'Shelf'])}`,
      category: pick(['home', 'kitchen', 'office', 'decor']),
      price: Decimal128.fromString((Math.round(rnd() * 30000) / 100 + 9).toFixed(2)),
      stock: Math.floor(rnd() * 140),
      rating: Math.round((3 + rnd() * 2) * 10) / 10,
      active: rnd() > 0.08,
    }))
    const customers = Array.from({ length: 120 }, (_, n) => {
      const f = pick(first)
      const l = pick(last)
      return {
        _id: new ObjectId(),
        name: `${f} ${l}`,
        email: `${f}.${l}${n + 1}`.toLowerCase() + '@example.com',
        city: pick(cities),
        plan: pick(['free', 'plus', 'pro']),
        createdAt: new Date(Date.UTC(2025, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27))),
      }
    })
    const orders = Array.from({ length: 1200 }, (_, i) => {
      const c = pick(customers)
      const items = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => {
        const p = pick(products)
        return { sku: p.sku, name: p.name, qty: 1 + Math.floor(rnd() * 3) }
      })
      const total = Math.round((20 + rnd() * 480) * 100) / 100
      const createdAt = new Date(
        Date.UTC(2026, 6 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24)),
      )
      const status = pick(['paid', 'paid', 'paid', 'shipped', 'shipped', 'pending', 'refunded'])
      return {
        _id: new ObjectId(),
        orderNo: `ORD-${30001 + i}`,
        status,
        customer: { id: c._id, name: c.name, city: c.city },
        items,
        total: Decimal128.fromString(total.toFixed(2)),
        currency: 'EUR',
        channel: pick(['web', 'web', 'mobile', 'marketplace']),
        tags: rnd() > 0.65 ? [pick(['gift', 'priority', 'b2b', 'returning'])] : [],
        createdAt,
        ...(status !== 'pending' ? { paidAt: new Date(createdAt.getTime() + 3_600_000) } : {}),
      }
    })
    await db.collection('products').insertMany(products)
    await db.collection('customers').insertMany(customers)
    await db.collection('orders').insertMany(orders)
    await db
      .collection('orders')
      .createIndexes([
        { key: { status: 1, createdAt: -1 } },
        { key: { orderNo: 1 }, unique: true },
        { key: { 'customer.id': 1 } },
      ])
    await db.collection('customers').createIndex({ email: 1 }, { unique: true })
    await db.createCollection('paid_orders', { viewOn: 'orders', pipeline: [{ $match: { status: 'paid' } }] })
    await db.collection('events').insertMany(
      Array.from({ length: 400 }, (_, i) => ({
        type: pick(['view', 'view', 'click', 'cart', 'buy']),
        at: new Date(Date.UTC(2026, 9, 1 + Math.floor(i / 20), i % 24)),
        customer: pick(customers)._id,
      })),
    )
  } finally {
    await client.close()
  }
}
