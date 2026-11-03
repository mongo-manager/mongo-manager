import { describe, expect, it } from 'vitest'
import { Long, ObjectId } from 'bson'
import { SchemaAnalyser, type SchemaAnalysis } from '../src/schema/analyse'
import { toCSharp, toGo, toPydantic } from '../src/schema/export'

const analyse = (docs: Array<Record<string, unknown>>): SchemaAnalysis => {
  const a = new SchemaAnalyser()
  for (const d of docs) a.add(d)
  return a.result()
}

const ORDERS = analyse([
  {
    _id: new ObjectId(),
    name: 'Ada',
    qty: 6,
    total: 1.5,
    big: Long.fromNumber(2 ** 40),
    tags: ['a'],
    address: { city: 'Izmir' },
    meta: 1,
    at: new Date(0),
    note: null,
  },
  {
    _id: new ObjectId(),
    name: 'Bob',
    total: 2.5,
    big: Long.fromNumber(1),
    tags: [],
    address: { city: 'Ankara' },
    meta: 'x',
    at: new Date(1),
    note: 'n',
  },
])

const HOSTILE = analyse([
  {
    _id: 1,
    class: 'x',
    func: 'x',
    def: 'x',
    'a-b': 'x',
    '"q"': 'x',
    'line\nbreak': 'x',
    '`tick`': 'x',
    '2nd': 'x',
    _private: 'x',
    Name: 'x',
    name: 'x',
  },
])

// Wave 1 review I3: names a language keeps for itself, or a tag cannot hold.
const CLASHING = analyse([
  {
    _id: 1,
    orders: 'x',
    json: 'x',
    model_name: 'x',
    'back\\slash': 'x',
    '-': 'x',
    名前: 'x',
  },
])

describe('schema export: names the language reserves (wave 1 review I3)', () => {
  it('C#: no property named like its class, and extra fields ignored on read', () => {
    const cs = toCSharp(CLASHING, 'orders')
    expect(cs).toContain('[BsonIgnoreExtraElements]\npublic class Orders\n{')
    expect(cs).toContain('    [BsonElement("orders")]\n    public string Orders2 { get; set; } = null!;')
    expect(cs).not.toMatch(/public \S+ Orders \{/)
  })

  it('Go: a backslash or a lone "-" is no tag; a name starts with a capital letter', () => {
    const go = toGo(CLASHING, 'orders')
    expect(go).toContain('// "back\\\\slash" is left out: a struct tag cannot hold it.')
    expect(go).toContain('// "-" is left out: a struct tag cannot hold it.')
    expect(go).not.toContain('bson:"-"')
    expect(go).not.toContain('bson:"back')
    expect(go).toMatch(/\tF名前 +string +`bson:"名前" json:"名前"`/)
  })

  it('Pydantic: no field shadows the model’s own names', () => {
    const py = toPydantic(CLASHING, 'orders')
    expect(py).toContain('    json_: str = Field(alias="json")')
    expect(py).toContain('    f_model_name: str = Field(alias="model_name")')
    expect(py).not.toMatch(/^ {4}json:/m)
    expect(py).not.toMatch(/^ {4}model_name:/m)
  })
})

describe('schema export: Pydantic (wave 1)', () => {
  const py = toPydantic(ORDERS, 'orders')
  it('writes a Pydantic v2 model per object, optional where a field is not always there', () => {
    expect(py).toContain('from pydantic import BaseModel, ConfigDict, Field')
    expect(py).toContain('class OrdersAddress(BaseModel):\n    city: str')
    expect(py).toContain('class Orders(BaseModel):')
    expect(py).toContain('    id: ObjectId = Field(alias="_id")')
    expect(py).toContain('    address: OrdersAddress')
    expect(py).toContain('    at: datetime')
    expect(py).toContain('    big: int')
    expect(py).toContain('    meta: int | str')
    expect(py).toContain('    note: str | None = None')
    expect(py).toContain('    qty: int | None = None')
    expect(py).toContain('    tags: list[str]')
    expect(py).toContain('    total: float')
    // The nested model comes before the one that uses it.
    expect(py.indexOf('class OrdersAddress')).toBeLessThan(py.indexOf('class Orders('))
  })

  it('keeps any field name usable: keywords, odd characters, a leading underscore by alias', () => {
    const h = toPydantic(HOSTILE, 'h')
    expect(h).toContain('    class_: str = Field(alias="class")')
    expect(h).toContain('    def_: str = Field(alias="def")')
    expect(h).toContain('    a_b: str = Field(alias="a-b")')
    expect(h).toContain('    q: str = Field(alias="\\"q\\"")')
    expect(h).toContain('    line_break: str = Field(alias="line\\nbreak")')
    expect(h).toContain('    f_2nd: str = Field(alias="2nd")')
    expect(h).toContain('    private: str = Field(alias="_private")')
    expect(h).not.toMatch(/^\s+"/m)
  })
})

describe('schema export: Go (wave 1)', () => {
  const go = toGo(ORDERS, 'orders')
  it('writes structs with bson tags, pointers for optional values', () => {
    expect(go).toContain('"go.mongodb.org/mongo-driver/bson/primitive"')
    expect(go).toContain('"time"')
    expect(go).toMatch(/type Orders struct \{/)
    expect(go).toMatch(/\tID +primitive\.ObjectID +`bson:"_id" json:"_id"`/)
    expect(go).toMatch(/\tAddress +OrdersAddress +`bson:"address" json:"address"`/)
    expect(go).toMatch(/\tAt +time\.Time +`bson:"at" json:"at"`/)
    expect(go).toMatch(/\tBig +int64 +`bson:"big" json:"big"`/)
    expect(go).toMatch(/\tMeta +any +`bson:"meta" json:"meta"`/)
    expect(go).toMatch(/\tQty +\*int32 +`bson:"qty,omitempty" json:"qty,omitempty"`/)
    expect(go).toMatch(/\tNote +\*string +`bson:"note,omitempty" json:"note,omitempty"`/)
    expect(go).toMatch(/\tTags +\[\]string +`bson:"tags" json:"tags"`/)
    expect(go).toMatch(/type OrdersAddress struct \{\n\tCity +string +`bson:"city" json:"city"`\n\}/)
  })

  it('leaves out a field a struct tag cannot name, saying so; names stay exported and distinct', () => {
    const h = toGo(HOSTILE, 'h')
    expect(h).toContain('// "\\"q\\"" is left out: a struct tag cannot hold it.')
    expect(h).toContain('// "`tick`" is left out: a struct tag cannot hold it.')
    expect(h).toContain('// "line\\nbreak" is left out: a struct tag cannot hold it.')
    expect(h).toMatch(/\tName +string +`bson:"Name"/)
    expect(h).toMatch(/\tName2 +string +`bson:"name"/)
    expect(h).toMatch(/\tF2nd +string +`bson:"2nd"/)
  })
})

describe('schema export: C# (wave 1)', () => {
  const cs = toCSharp(ORDERS, 'orders')
  it('writes classes for the MongoDB C# driver, nullable where a field is not always there', () => {
    expect(cs).toContain('using MongoDB.Bson;')
    expect(cs).toContain('using MongoDB.Bson.Serialization.Attributes;')
    expect(cs).toContain('public class Orders\n{')
    expect(cs).toContain('    [BsonId]\n    public ObjectId Id { get; set; }')
    expect(cs).toContain(
      '    [BsonElement("address")]\n    public OrdersAddress Address { get; set; } = null!;',
    )
    expect(cs).toContain(
      '    [BsonElement("qty")]\n    [BsonIgnoreIfNull]\n    public int? Qty { get; set; }',
    )
    expect(cs).toContain(
      '    [BsonElement("note")]\n    [BsonIgnoreIfNull]\n    public string? Note { get; set; }',
    )
    expect(cs).toContain('    [BsonElement("meta")]\n    public BsonValue Meta { get; set; } = null!;')
    expect(cs).toContain('    [BsonElement("tags")]\n    public List<string> Tags { get; set; } = null!;')
    expect(cs).toContain('public class OrdersAddress\n{')
  })

  it('keeps odd names inert in string literals', () => {
    const h = toCSharp(HOSTILE, 'h')
    expect(h).toContain('[BsonElement("\\"q\\"")]')
    expect(h).toContain('[BsonElement("line\\nbreak")]')
    expect(h).toContain('[BsonElement("class")]\n    public string Class { get; set; } = null!;')
  })
})
