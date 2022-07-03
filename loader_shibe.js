const {loadImage, createCanvas, Image} = require("canvas");
const fs = require("fs");
const {featureCollection, lineString, multiLineString} = require("@turf/helpers");
const proj4 = require("proj4");
const modified_geojson2mvt = require("./modified_geojson2vt");
const https = require('https');

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

const images = {}

async function loader(zoom, x, y, dems, interval, bold) {
  const d3 = await import("d3");
  const fetch = (await import("node-fetch")).default;
  const opts = {
    agent: new https.Agent({
      keepAlive: true
    })
  };

  if (!(dems instanceof Array)) {
  	dems = dems == null ? [] : [dems];
  }
  zoom = zoom != null ? zoom : 15;
  x = x != null ? x : 29084;
  y = y != null ? y : 12841;
  if (!dems.length) dems.push("dem5a");
  interval = interval != null ? interval : 0.5;
  bold = bold != null ? bold : 2.5;
  const wh = 256 * 3;
  const relative_coords = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]];
  const canvas = createCanvas(wh, wh);
  const context = canvas.getContext('2d');
  const coord_images = await Promise.all(relative_coords.map(async (coords) => {
    const lx = x + coords[0];
    const ly = y + coords[1];
    return Promise.all(dems.map(async (dem) => {
      const tile_url = `https://cyberjapandata.gsi.go.jp/xyz/${dem}_png/${zoom}/${lx}/${ly}.png`;
      if (images[tile_url]) return images[tile_url];
      const image = await new Promise((res, rej) => {
        fetch(tile_url, opts).then((resp) => {
          return resp.buffer()
        }).then((buf) => {
          const img = new Image();
          img.onload = () => {
            res(img)
          };
          img.onerror = (err) => {
            rej(err)
          };
          img.src = buf;
        }).catch((e) => {
          console.log(e)
        })
      });
      //const image = await loadImage(tile_url);
      await new Promise((res) => {
        setTimeout(() => res(), 1000);
      })
      images[tile_url] = image;
      console.log(Object.keys(images).length)
      return image;
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
  const ne = recursiveProjection([512, 256], zoom, x, y);
  const noClip = featureCollection(contour_array.reduce((prev, contour) => {
    if (contour.coordinates.length === 0) return prev;
    const lineArray = [];
    const coords = recursiveProjection(contour.coordinates, zoom, x, y);
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

  return noClip;
  //const pbf = modified_geojson2mvt(noClip, zoom, x, y);

  //fs.writeFileSync(`./${zoom}_${x}_${y}.geojson`, JSON.stringify(noClip));
  //fs.writeFileSync(`./${zoom}_${x}_${y}.pbf`, pbf);
}

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

const main = async () => {
  const zoom = 15;
  const tilenw = lngLat2Tile(nw, zoom)
  const tilese = lngLat2Tile(se, zoom)

  const tiles = []
  for (let x = tilenw[0]; x <= tilese[0]; x++) {
    for (let y = tilenw[1]; y <= tilese[1]; y++) {
      tiles.push([x, y])
    }
  }

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const geoJson = await loader(zoom, tile[0], tile[1], ["dem5a"], interval, bold)
    console.log(geoJson)
  }



}

main()