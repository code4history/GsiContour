const {loadImage, createCanvas} = require("canvas");
const fs = require("fs");
const {multiPolygon, featureCollection, lineString, multiLineString} = require("@turf/helpers");
const {polygonToLine} = require("@turf/polygon-to-line");
const bboxClip = require("@turf/bbox-clip").default;
const {toWgs84} = require("@turf/projection");
const {getGeom} = require("@turf/invariant");
const {JSDOM} = require('jsdom');
const proj4 = require("proj4");

const recursiveProjection = (array, zoom, x, y) => {
  const proj_key = `PROJKEY:${zoom}`;
  if (!proj4.defs(proj_key)) {
  	proj4.defs(proj_key, `+proj=merc +a=${Math.pow(2, zoom + 7) / Math.PI} +b=${Math.pow(2, zoom + 7) / Math.PI} +lat_ts=0.0 +lon_0=0.0 +x_0=${Math.pow(2, zoom + 7)} +y_0=${Math.pow(2, zoom + 7)} +k=1.0 +units=m +nadgrids=@null +no_defs`);
  }

  const isArray = array[0] instanceof Array;
  return array[0] instanceof Array ? 
    array.map((item) => recursiveProjection(item, zoom, x, y)) : 
    proj4(proj_key, "EPSG:4326", [(array[0] + 0.5) + (x - 1) * 256, Math.pow(2, zoom + 7) * 2 - (array[1] + 0.5) -  (y - 1) * 256]);
};

const recursiveKillNull = (array) => {
  return array.reduce((prev, item) => {
    item = item instanceof Array ? recursiveKillNull(item) : item;
    if (item != null) {
      if (prev == null) prev = [];
      prev.push(item);
    }
    return prev;
  }, undefined);
};

//console.log(recursiveProjection([256, 256], 15, 29084, 12842));

async function loader(zoom, x, y, dems) {
  const d3 = await import("d3");

  if (!(dems instanceof Array)) {
  	dems = dems == null ? [] : [dems];
  }
  zoom = zoom != null ? zoom : 15;
  x = x != null ? x : 29084;
  y = y != null ? y : 12842;
  if (!dems.length) dems.push("dem5a");
  const relative_coords = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]];
  const canvas = createCanvas(768, 768);
  const context = canvas.getContext('2d');
  const coord_images = await Promise.all(relative_coords.map(async (coords) => {
    const lx = x + coords[0];
    const ly = y + coords[1];
    return Promise.all(dems.map(async (dem) => {
      const tile_url = `https://cyberjapandata.gsi.go.jp/xyz/${dem}_png/${zoom}/${lx}/${ly}.png`;
      return loadImage(tile_url);
    }));
  }));
  relative_coords.map((coords, index) => {
    const lx = coords[0];
    const ly = coords[1];
    const image = coord_images[index][0];
    context.drawImage(image, (lx + 1) * 256, (ly + 1) * 256, 256, 256);
  });
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('./image.png', buffer);

  let r, g, b, xx, h
  const u = 0.01 // 標高分解能0.01m
  const data = context.getImageData(0, 0, 768, 768).data;
  const n = 768, m = 768, values = new Array(n * m);

  for (let ly = 0; ly < m; ly++) {
    for (let lx = 0; lx < n; lx++) {
      const k = ly * n + lx;
      const base = k * 4

      if ( data[ base + 3 ] == 0 )  {
        values[k] = 0;
      } else {
        r = data[ base ];
        g = data[ base + 1 ];
        b = data[ base + 2 ];
        xx = 2**16 * r + 2**8 * g + b;
        values[k] = ( xx <  2**23 ) ? xx * u: ( x - 2 ** 24 ) * u;
      }
    }
  }
  const contour_array = d3.contours()
    .size([n, m])
    .thresholds([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 10, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])
    (values);
  const document = new JSDOM().window.document;
  var svg = d3.select(document.body).append("svg").attr("width", 768).attr("height", 768);
  svg.selectAll("path")
    .data(contour_array)
    .enter()
    .append("path")
    .attr("d", d3.geoPath(d3.geoIdentity().scale(1)))
    .attr("stroke","white")
    .attr("stroke-width","0.5");

  fs.writeFileSync('./test.svg', document.body.innerHTML);

  const sw = recursiveProjection([256, 512], zoom, x, y);
  const ne = recursiveProjection([512, 216], zoom, x, y);
  const final = featureCollection(contour_array.reduce((prev, contour) => {
    if (contour.coordinates.length === 0) return prev;
    const lineArray = [];
    const coords = recursiveProjection(contour.coordinates, zoom, x, y);
    coords.forEach((coords1) => {
      const line = bboxClip(lineString(coords1[0], {value: contour.value}),[sw[0], sw[1], ne[0], ne[1]]);
      const lcoords = line.geometry.type === "MultiLineString" ? line.geometry.coordinates : [line.geometry.coordinates];
      lcoords.forEach((coords2) => {
        if (coords2.length !== 0) lineArray.push(coords2);
      });
    });
    if (lineArray.length === 0) return prev;
    prev.push(multiLineString(lineArray, {value: contour.value}));
    return prev;
  }, []));
  fs.writeFileSync('./test.geojson', JSON.stringify(final));
}







loader();