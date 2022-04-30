const {loadImage, createCanvas} = require("canvas");
const fs = require("fs");
const {featureCollection, lineString, multiLineString} = require("@turf/helpers");
const bboxClip = require("@turf/bbox-clip").default;
const proj4 = require("proj4");

const recursiveProjection = (array, zoom, x, y) => {
  const proj_key = `PROJKEY:${zoom}`;
  if (!proj4.defs(proj_key)) {
  	proj4.defs(proj_key, `+proj=merc +a=${Math.pow(2, zoom + 7) / Math.PI} +b=${Math.pow(2, zoom + 7) / Math.PI} +lat_ts=0.0 +lon_0=0.0 +x_0=${Math.pow(2, zoom + 7)} +y_0=${Math.pow(2, zoom + 7)} +k=1.0 +units=m +nadgrids=@null +no_defs`);
  }

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

async function loader(zoom, x, y, dems, interval) {
  const d3 = await import("d3");

  if (!(dems instanceof Array)) {
  	dems = dems == null ? [] : [dems];
  }
  zoom = zoom != null ? zoom : 15;
  x = x != null ? x : 29084;
  y = y != null ? y : 12842;
  if (!dems.length) dems.push("dem5a");
  interval = interval != null ? interval : 0.5;
  const wh = 256 * 3;
  const relative_coords = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]];
  const canvas = createCanvas(wh, wh);
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

  let r, g, b, xx, min = null, max = null;
  const u = 0.01 // 標高分解能0.01m
  const data = context.getImageData(0, 0, wh, wh).data;
  const values = new Array(wh * wh);

  for (let ly = 0; ly < wh; ly++) {
    for (let lx = 0; lx < wh; lx++) {
      const k = ly * wh + lx;
      const base = k * 4

      if ( data[ base + 3 ] === 0 )  {
        values[k] = 0;
      } else {
        r = data[ base ];
        g = data[ base + 1 ];
        b = data[ base + 2 ];
        xx = 2**16 * r + 2**8 * g + b;
        values[k] = ( xx <  2**23 ) ? xx * u: ( x - 2 ** 24 ) * u;
        if (min == null) {
          min = max = values[k];
        } else if (values[k] < min && values[k] > -100) {
          min = values[k];
        } else if (values[k] > max) {
          max = values[k];
        }
      }
    }
  }

  const intmin = Math.ceil(min / interval);
  const intmax = Math.floor(max / interval);
  const thresholds = [];
  for (let i = intmin; i <= intmax; i++) {
    thresholds.push(i * interval);
  }

  const contour_array = d3.contours()
    .size([wh, wh])
    .thresholds(thresholds)
    (values);

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