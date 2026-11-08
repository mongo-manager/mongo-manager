# Map

Map draws where the documents of a collection are: their GeoJSON shapes (points, lines, polygons and collections of them) and legacy `[lng, lat]` coordinate pairs, on a map of its own. Points close together are clustered with a count; a shape opens a card about its document.

The plugin only reads. It changes nothing in the database.

## Where it appears

- **Collection tab:** a **Map** tab beside Documents, Aggregations and the other tabs of every collection and view.
- **Document action:** **Show on map** in the action menu of a document row in Documents draws that one document.
- **Cell values:** beside a GeoJSON point in Documents, its position as `lat, lng` (five decimals), for example `41.00820, 28.97840`.

## How to use it

Open a collection, then the **Map** tab. The documents of the current Documents query are read and their shapes drawn; the map fits itself to them.

- Drag to move, scroll or use **Zoom in** and **Zoom out** to zoom, **Fit to the shapes** to see everything again.
- A circle with a number holds several places close together: click it to zoom in.
- Click a point or shape to open its card: the document's name, a few of its fields, and **Open** to show the document in the app.
- **GeoJSON field** limits the map to one field when the documents hold shapes in several (for example `pickup` and `dropoff`); **All fields** shows them all.
- **Shapes** lists what was drawn (document, field, type). It is the keyboard way through the map: **Show it on the map** centres a shape, **Open** opens its document.

## Filtering by an area

The three buttons beside the field picker filter the documents by an area:

- **Draw an area:** click the map to add corners; click the first corner, double-click or press Enter to finish. Backspace takes the last corner back; Escape gives up, wherever the focus is.
- **Draw a circle:** click its centre, then its edge; its radius shows as you move, and its outline is the one the globe holds (wider toward a pole on the map).
- **Filter by the area in view:** the part of the world the map shows.

By keyboard: with the map focused, the arrows move it and Space puts a corner (or the circle's centre, then its edge) at the map's centre, where a cross shows. A second click on a tool in use puts it down; another field chosen stops a drawing.

The documents with a shape in the area are put in the Documents query, with MongoDB's `$geoWithin`. Each edge follows the line drawn on the map — corners are added along it, since MongoDB joins two corners by the shortest way round the globe, which bows toward a pole — and an area may cross the antimeridian. It works on GeoJSON shapes and `[lng, lat]` pairs alike and needs no index. A shape inside a Feature is filtered by its geometry, one in a FeatureCollection by the collection's features (a document is in when any of its shapes is), one in an array by the array's elements. When a field holds its shapes in more than one of these ways, the filter takes each. Shapes under a key no filter can name (one with a dot or a `$` in it, or an empty one) are left out, and the page says so beside the tools, before you filter.

The area goes beside the Documents filter in use: its other conditions are kept, and an area on the same field already there (an earlier drawing's, or one you wrote) is replaced. The Documents sort and projection are set back to none, as for any query a plugin puts there. A polygon whose edges cross, touch or double back, or whose corners are on one line, makes no area: the page says why. When the documents hold shapes in several fields, choose the one to filter by first; the page says so beside the buttons. **Show on map** (one document) has no drawing tools.

## What is read as a place

- A GeoJSON geometry in any field: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon` or `GeometryCollection`.
- A GeoJSON `Feature` or `FeatureCollection`.
- A legacy pair `[lng, lat]`, longitude first as MongoDB stores it, but only in a field named for a place: `loc`, `location`, `coordinates`, `coords`, `position`, `pos`, `point`, `geo`, `lnglat`, `lonlat`, `center` and their plurals or close variants. Two numbers elsewhere (a version, a size) are not taken as a place. A field named `latlng` is not read, as it usually holds latitude first.

Fields are looked for up to six levels deep, and inside arrays. A shape that is not valid GeoJSON is left out whole.

## Example

A `stores` collection:

```json
{ "_id": 1, "name": "Kadıköy", "location": { "type": "Point", "coordinates": [29.0275, 40.9903] } }
{ "_id": 2, "name": "Beşiktaş", "loc": [29.0094, 41.0422] }
```

Both appear on the Map tab. In Documents, the `location` cell of the first shows `40.99030, 29.02750` beside the value.

## Map tiles

Out of the box, no map tiles are loaded and no tile server is contacted: the map draws a grid of meridians and parallels, and a note says an administrator can set a tile server. With a tile server set, the shapes are drawn over real map tiles.

## Permissions

- **Read documents** (`documents:read`): to read the documents of the current query, and the one document of Show on map.

Reads go through the app with the signed-in user's rights and field masking. The plugin cannot read other collections.

## Settings

Administrators set these on the Plugins page. Everyone who uses the plugin can see them, so never put a secret (such as a private API key) here.

- **Tile server** (`tileUrl`): an http or https address template for raster tiles. `{z}`, `{x}` and `{y}` are filled in for each tile, `{-y}` counts rows from the south (TMS), `{s}` picks a subdomain (`a`, `b` or `c`) and `{r}` is left empty. Example: `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (check the tile provider's usage policy first).
- **Tile credits** (`tileAttribution`): the credit line shown on the map, as plain text, for example `© OpenStreetMap contributors`. When empty, the tile server's host name is shown.

The tile server's host, and only that host, is added to the images the plugin's frame may load. An address with credentials, or an unusual host, is refused.

## Limits

- At most the first 1,000 documents of the current query are read, in `_id` order, in pages that fit the app's 1 MB message limit. When there are more, the summary says "of the first 1,000 documents"; narrow the Documents filter to see others.
- Up to 50 shapes are taken from one document.
- A shape with more than 10,000 vertices is drawn thinned (every n-th point kept, the ends kept), and at most 1,000 parts of a multi-shape are drawn.
- The Shapes list shows its first 200 rows.
- Zoom goes to level 19; fitting stops at level 15 so that a single point is not drawn at street level.
- The map uses the Web Mercator projection: latitudes beyond about 85 degrees north or south are drawn at the edge.
