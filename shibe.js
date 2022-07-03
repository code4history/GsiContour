const {loadImage, createCanvas} = require("canvas");
const fs = require("fs");
const {featureCollection, lineString, multiLineString} = require("@turf/helpers");
const proj4 = require("proj4");
const modified_geojson2mvt = require("./modified_geojson2vt");

const recursiveProjection = (array, zoom, x, y) => {
  const proj_key = `PROJKEY:${zoom}`;
  if (!proj4.defs(proj_key)) {
    proj4.defs(proj_key, `+proj=merc +a=${Math.pow(2, zoom + 7) / Math.PI} +b=${Math.pow(2, zoom + 7) / Math.PI} +lat_ts=0.0 +lon_0=0.0 +x_0=${Math.pow(2, zoom + 7)} +y_0=${Math.pow(2, zoom + 7)} +k=1.0 +units=m +nadgrids=@null +no_defs`);
  }

  return array[0] instanceof Array ?
    array.map((item) => recursiveProjection(item, zoom, x, y)) :
    proj4(proj_key, "EPSG:4326", [(array[0] + 0.5) + (x - 1) * 256, Math.pow(2, zoom + 7) * 2 - (array[1] + 0.5) -  (y - 1) * 256]);
};

const nw = [139.3799183454609, 36.31175782019106]
const se = [139.65114653268176, 36.19404450484788]
const GEO_R = 6378137;
const orgX = -1 * (2 * GEO_R * Math.PI / 2);
const orgY = (2 * GEO_R * Math.PI / 2);
const interval = 0.5;
const bold = 2.5;

const degrees2meters = function(lngLat) {
  var x = lngLat[0] * 20037508.34 / 180.0;
  var y = Math.log(Math.tan((90.0 + lngLat[1]) * Math.PI / 360.0)) / (Math.PI / 180.0);
  y = y * 20037508.34 / 180.0;
  return [x, y];
}

const lngLat2Tile = (lngLat, zoom = 15) => {
  const xy = degrees2meters(lngLat);
  const unit = 2 * GEO_R * Math.PI / Math.pow(2, zoom)

  const xtile = Math.floor((xy[0] - orgX) / unit);
  const ytile = Math.floor((orgY - xy[1]) / unit);
  return [xtile, ytile];
}



//let xy = degrees2meters(36.104600,140.085871);
//let level =17;



const main = async () => {
  const d3 = await import("d3");

  const zoom = 15;
  const tilenw = lngLat2Tile(nw, zoom)
  const tilese = lngLat2Tile(se, zoom)
  const wh = [(tilese[0] - tilenw[0] + 1) * 256, (tilese[1] - tilenw[1] + 1) * 256]
  const canvas = createCanvas(wh[0], wh[1]);
  const context = canvas.getContext('2d');

  const tiles = []
  for (let x = tilenw[0]; x <= tilese[0]; x++) {
    for (let y = tilenw[1]; y <= tilese[1]; y++) {
      tiles.push([x, y])
    }
  }

  tiles.forEach(async (tile) => {
    const tile_url = `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${zoom}/${tile[0]}/${tile[1]}.png`;
    const coord_images = await loadImage(tile_url);
    const lx = (tile[0] - tilenw[0]) * 256;
    const ly = (tile[1] - tilenw[1]) * 256;
    console.log(`${lx}_${ly}`)
    await context.drawImage(coord_images, lx, ly, 256, 256);
  })

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('./image.png', buffer);

  let r, g, b, xx, min = null, max = null;
  const u = 0.01 // 標高分解能0.01m
  const data = context.getImageData(0, 0, wh[0], wh[1]).data;
  const values = new Array(wh[0] * wh[1]);

  for (let ly = 0; ly < wh[0]; ly++) {
    for (let lx = 0; lx < wh[1]; lx++) {
      const k = ly * wh[0] + lx;
      const base = k * 4

      if ( data[ base + 3 ] === 0 )  {
        values[k] = 0;
      } else {
        r = data[ base ];
        g = data[ base + 1 ];
        b = data[ base + 2 ];
        xx = 2**16 * r + 2**8 * g + b;
        values[k] = ( xx <  2**23 ) ? xx * u: ( xx - 2 ** 24 ) * u;
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
    .size([wh[0], wh[1]])
    .thresholds(thresholds)
      (values);
  console.log(values)

  const noClip = featureCollection(contour_array.reduce((prev, contour) => {
    console.log(contour.coordinates)
    if (contour.coordinates.length === 0) return prev;
    const lineArray = [];
    //const coords = recursiveProjection(contour.coordinates, zoom, x, y);
    console.log(contour.coordinates)
    const coords = contour.coordinates//recursiveProjection(contour.coordinates, zoom, x, y);
    coords.forEach((coords1) => {
      const line = lineString(coords1[0], {value: contour.value});
      lineArray.push(line.geometry.coordinates);
    });
    if (lineArray.length === 0) return prev;
    const props = {
      height: contour.value,
      bold: contour.value % bold === 0
    };
    prev.push(multiLineString(lineArray, props));
    return prev;
  }, []));

  fs.writeFileSync(`./${zoom}.geojson`, JSON.stringify(noClip));
}

main()