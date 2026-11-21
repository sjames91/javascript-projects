// Chispita Sprite: a pixel editor that can turn its pixels into circles.
// Square mode is a regular pixel editor. Circle mode draws every pixel as a circle the
// size of its cell, and adds a circle on every inside corner that overlaps the four
// square circles around it.
// In circle mode each layer has two controls:
//   smoothing - how smooth the outside edge is. The circles are blurred together and cut
//               off halfway, so straight edges stay straight and stair-steps become curves.
//   blend     - how softly colors average where circles overlap. 0 = flat averages with
//               crisp circle edges, 1 = circles fade into each other.

const sprite = {
  width: 16,
  height: 16,
  layers: [],
};

const settings = {
  color: "#e04040",
  brushSize: 1,     // in cells: paints every pixel within half this distance of the mouse
  fillShapes: false,
  circles: false,   // false = square pixels. true = circle mode, with corner circles
  showGrid: true,
  exportScale: 4,
};

const palette = [
  "#000000", "#ffffff", "#7a7a7a", "#c2c2c2",
  "#e04040", "#f08a30", "#f2d541", "#62c454",
  "#2f8f5b", "#3a8dde", "#2a4c9a", "#8f5bd6",
  "#e070b8", "#8a5a3c", "#f2c8a0", "#20232a",
];

const toolKeys = { b: "paint", l: "line", r: "rect", e: "ellipse", p: "polygon", z: "zoom" };

let currentLayer = 0;
let cellSize = 24;        // screen pixels per cell, changed by zooming
let fitSize = 24;         // the cell size that fits the whole sprite on screen (100% zoom)
let tool = "paint";
let painting = false;     // dragging with the paint brush
let erasing = false;      // the current stroke or shape erases instead of paints
let hover = null;         // the circle under the mouse
let shapeStart = null;    // line, rect and ellipse: where the drag started
let polygonPoints = [];   // polygon: the corners clicked so far
const undoStack = [];

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// ---------- Layers ----------

// The places a circle can go, every half cell. Each kind is its own grid:
//   centers  - the middle of each square (these are the pixels in square mode)
//   corners  - where four squares meet
//   betweenX - halfway between a square and the one to its right
//   betweenY - halfway between a square and the one below it
// Only centers are used in square mode. x0, y0 is the first spot, in cells.
function slotKinds() {
  const w = sprite.width;
  const h = sprite.height;
  return [
    { list: "centers", columns: w, rows: h, x0: 0.5, y0: 0.5 },
    { list: "corners", columns: w - 1, rows: h - 1, x0: 1, y0: 1 },
    { list: "betweenX", columns: w - 1, rows: h, x0: 1, y0: 0.5 },
    { list: "betweenY", columns: w, rows: h - 1, x0: 0.5, y0: 1 },
  ];
}

function makeLayer(name) {
  const layer = {
    name: name,
    visible: true,
    smoothing: 0.85,
    blend: 1,
  };
  for (const kind of slotKinds()) {
    layer[kind.list] = new Array(kind.columns * kind.rows).fill(null);
  }
  return layer;
}

// Every place a circle can go: { list, index, x, y }, with x, y in cells.
// In square mode only the centers can be painted.
function allSlots(includeCircleSpots) {
  const slots = [];
  for (const kind of slotKinds()) {
    if (kind.list !== "centers" && !includeCircleSpots) continue;
    for (let row = 0; row < kind.rows; row++) {
      for (let column = 0; column < kind.columns; column++) {
        slots.push({ list: kind.list, index: row * kind.columns + column, x: kind.x0 + column, y: kind.y0 + row });
      }
    }
  }
  return slots;
}

function newSprite(width, height) {
  sprite.width = width;
  sprite.height = height;
  sprite.layers = [makeLayer("Layer 1")];
  currentLayer = 0;
  undoStack.length = 0;
  fitCanvas();
  refresh();
}

// ---------- Rendering ----------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// How much a circle counts at a distance (in cells): 1 at its center, fading to 0 at `reach`.
function influence(distance, reach) {
  if (distance >= reach) return 0;
  const t = 1 - (distance / reach) * (distance / reach);
  return t * t;
}

function renderSprite(scale) {
  if (settings.circles) return renderCircles(scale);
  return renderSquares(scale);
}

// Square mode: a regular pixel editor. Upper layers cover lower ones.
function renderSquares(scale) {
  const width = sprite.width * scale;
  const image = new ImageData(width, sprite.height * scale);
  for (let cy = 0; cy < sprite.height; cy++) {
    for (let cx = 0; cx < sprite.width; cx++) {
      let color = null;
      for (const layer of sprite.layers) {
        const value = layer.centers[cy * sprite.width + cx];
        if (layer.visible && value) color = value;
      }
      if (!color) continue;
      const [r, g, b] = hexToRgb(color);
      for (let py = cy * scale; py < (cy + 1) * scale; py++) {
        for (let px = cx * scale; px < (cx + 1) * scale; px++) {
          const i = (py * width + px) * 4;
          image.data[i] = r;
          image.data[i + 1] = g;
          image.data[i + 2] = b;
          image.data[i + 3] = 255;
        }
      }
    }
  }
  return image;
}

// Circle mode. For every image pixel, two things are worked out separately:
//
// Shape: each circle spreads an influence out to its layer's smoothing distance, divided
// so that a solid area adds up to 1. The pixel is filled where the total reaches 0.5,
// which is like blurring the drawing and cutting it off halfway: straight edges stay on
// the cell lines and stair-steps become smooth curves. A small core in the middle of each
// circle is always filled, so lone pixels and thin lines never blur away completely.
//
// Color: each circle's color only counts inside the circle, so where circles overlap
// their colors average and you see the circles. The layer's blend sets how soft that is:
// 0 = every circle counts the same all the way to its edge (crisp circle edges),
// 1 = circles count less toward their edge (overlaps fade into each other).
// Spots no circle covers (gaps the smoothing filled in) take a soft average of the
// circles around them.
//
// Every circle on a layer looks the same, so its numbers are worked out once as a "stamp"
// and then added in at each circle. Square circles and corner circles sit at different
// spots inside an image pixel, so each gets its own stamp.

// A stamp for a circle whose center is fractionX, fractionY of the way across an image pixel.
// offsetX, offsetY: where the stamp starts, in image pixels, from the pixel holding the center.
function makeStamp(fractionX, fractionY, scale, reach, blend, box, solidArea) {
  const offsetX = Math.floor(fractionX - box * scale);
  const offsetY = Math.floor(fractionY - box * scale);
  const size = Math.ceil(box * scale * 2) + 2;
  const stamp = {
    offsetX: offsetX,
    offsetY: offsetY,
    size: size,
    field: new Float32Array(size * size),
    inside: new Float32Array(size * size),   // color weight inside the circle, 0 outside it
    around: new Float32Array(size * size),   // soft color weight for gaps between circles
    distance: new Float32Array(size * size),
  };
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const dx = (offsetX + u + 0.5 - fractionX) / scale;
      const dy = (offsetY + v + 0.5 - fractionY) / scale;
      const distanceSquared = dx * dx + dy * dy;
      const distance = Math.sqrt(distanceSquared);
      const s = v * size + u;
      stamp.field[s] = influence(distance, reach) / solidArea;
      if (distance < 0.5) stamp.inside[s] = Math.max(0.0001, 1 - blend * distance / 0.5);
      stamp.around[s] = Math.exp(-distanceSquared / 0.25);
      stamp.distance[s] = distance;
    }
  }
  return stamp;
}

// Smooth edges below this is "off". The slider's lowest notch sits just under it.
const smoothingOn = 0.9;

function renderCircles(scale) {
  const width = sprite.width * scale;
  const height = sprite.height * scale;
  const count = width * height;
  // [red, green, blue, total weight] for colors inside circles, and for the gaps around them
  const inside = [0, 1, 2, 3].map(() => new Float32Array(count));
  const around = [0, 1, 2, 3].map(() => new Float32Array(count));
  const field = new Float32Array(count);
  const core = new Uint8Array(count);
  const hardCircle = new Uint8Array(count);   // inside a circle on a layer with smoothing off
  const slots = allSlots(true);
  const colors = {};

  // Every filled square is a full square pixel underneath its circles, colored by the
  // topmost visible layer that fills it. Smoothing only happens next to empty squares, and
  // only trims a square if that top layer has smoothing on.
  const filled = new Uint8Array(sprite.width * sprite.height);
  const squareColor = new Array(sprite.width * sprite.height).fill(null);
  const squareSmooth = new Uint8Array(sprite.width * sprite.height);
  // Outside its own circle a square still counts toward the color average, as much as its
  // circle counts at its edge: fully with blend 0, hardly at all with blend 1.
  const squareWeight = new Float32Array(sprite.width * sprite.height);
  for (const layer of sprite.layers) {
    if (!layer.visible) continue;
    layer.centers.forEach((color, index) => {
      if (!color) return;
      filled[index] = 1;
      squareColor[index] = hexToRgb(color);
      squareSmooth[index] = layer.smoothing >= smoothingOn ? 1 : 0;
      squareWeight[index] = Math.max(0.0001, 1 - layer.blend);
    });
  }
  const isFilled = (cx, cy) => cx >= 0 && cy >= 0 && cx < sprite.width && cy < sprite.height && filled[cy * sprite.width + cx];

  for (const layer of sprite.layers) {
    if (!layer.visible) continue;
    // Smoothing off: only the circles themselves are drawn, nothing fills the gaps between them.
    const smooth = layer.smoothing >= smoothingOn;
    const reach = smooth ? layer.smoothing : 0.5;
    const solidArea = smooth ? Math.PI * reach * reach / 3 : Infinity;   // what the influence adds up to over a solid area
    const coreRadius = smooth ? Math.max(0.3, Math.min(0.5, 0.5 - (reach - 0.9) * 0.4)) : 0.5;
    const box = smooth ? Math.max(reach, 1) : 0.5;
    const stamps = {};

    for (const slot of slots) {
      const color = layer[slot.list][slot.index];
      if (!color) continue;
      if (!colors[color]) colors[color] = hexToRgb(color);
      const [r, g, b] = colors[color];

      const originX = slot.x * scale;
      const originY = slot.y * scale;
      const fractionX = originX - Math.floor(originX);
      const fractionY = originY - Math.floor(originY);
      const key = fractionX + "," + fractionY;
      if (!stamps[key]) stamps[key] = makeStamp(fractionX, fractionY, scale, reach, layer.blend, box, solidArea);
      const stamp = stamps[key];
      const startX = Math.floor(originX) + stamp.offsetX;
      const startY = Math.floor(originY) + stamp.offsetY;

      for (let v = 0; v < stamp.size; v++) {
        const py = startY + v;
        if (py < 0 || py >= height) continue;
        for (let u = 0; u < stamp.size; u++) {
          const px = startX + u;
          if (px < 0 || px >= width) continue;
          const s = v * stamp.size + u;
          const i = py * width + px;

          field[i] += stamp.field[s];
          if (stamp.distance[s] < coreRadius) core[i] = 1;

          const insideWeight = stamp.inside[s];
          if (insideWeight > 0) {
            if (!smooth) hardCircle[i] = 1;
            inside[0][i] += r * insideWeight;
            inside[1][i] += g * insideWeight;
            inside[2][i] += b * insideWeight;
            inside[3][i] += insideWeight;
          }
          const aroundWeight = stamp.around[s];
          around[0][i] += r * aroundWeight;
          around[1][i] += g * aroundWeight;
          around[2][i] += b * aroundWeight;
          around[3][i] += aroundWeight;
        }
      }
    }
  }

  // For each image pixel:
  //   inside a filled square - shown, unless it's on the outside edge of a smooth square and
  //                            smoothing trims it. Colored by the circles over it, or by the
  //                            square itself where no circle reaches.
  //   in an empty square     - shown only where a circle pokes out over it, or smoothing
  //                            fills it in.
  const image = new ImageData(width, height);
  const smoothed = (i) => hardCircle[i] || core[i] || field[i] >= 0.5;
  for (let py = 0; py < height; py++) {
    const squareY = Math.floor(py / scale);
    const nearY = Math.floor((py + 0.5) / scale - 0.5);
    for (let px = 0; px < width; px++) {
      const squareX = Math.floor(px / scale);
      const nearX = Math.floor((px + 0.5) / scale - 0.5);
      const i = py * width + px;
      const square = squareY * sprite.width + squareX;
      const inCircle = inside[3][i] > 0;
      let color = null;

      if (filled[square]) {
        // The four nearest squares all filled = well inside the shape, never trimmed.
        const insideShape = isFilled(nearX, nearY) && isFilled(nearX + 1, nearY) && isFilled(nearX, nearY + 1) && isFilled(nearX + 1, nearY + 1);
        const trimmable = squareSmooth[square] && !insideShape;
        if (trimmable && !smoothed(i)) continue;
        let r = inside[0][i];
        let g = inside[1][i];
        let b = inside[2][i];
        let weight = inside[3][i];
        const dx = (px + 0.5) / scale - (squareX + 0.5);
        const dy = (py + 0.5) / scale - (squareY + 0.5);
        if (dx * dx + dy * dy >= 0.25) {
          const base = squareColor[square];
          const baseWeight = squareWeight[square];
          r += base[0] * baseWeight;
          g += base[1] * baseWeight;
          b += base[2] * baseWeight;
          weight += baseWeight;
        }
        color = [r / weight, g / weight, b / weight];
      } else {
        if (!smoothed(i)) continue;
        const source = inCircle ? inside : around;
        color = [source[0][i] / source[3][i], source[1][i] / source[3][i], source[2][i] / source[3][i]];
      }

      image.data[i * 4] = color[0];
      image.data[i * 4 + 1] = color[1];
      image.data[i * 4 + 2] = color[2];
      image.data[i * 4 + 3] = 255;
    }
  }
  return image;
}

// Square lines, plus a dot on each inside corner where a corner circle can go.
function drawGrid() {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= sprite.width; x++) {
    ctx.moveTo(x * cellSize + 0.5, 0);
    ctx.lineTo(x * cellSize + 0.5, canvas.height);
  }
  for (let y = 0; y <= sprite.height; y++) {
    ctx.moveTo(0, y * cellSize + 0.5);
    ctx.lineTo(canvas.width, y * cellSize + 0.5);
  }
  ctx.stroke();

  if (cellSize >= 10 && settings.circles) drawSpotMarkers();
}

// Circle mode: a marker on every spot a circle can go. Filled = painted on the selected
// layer, hollow = empty. Dark edges keep them visible on any color.
function drawSpotMarkers() {
  const layer = sprite.layers[currentLayer];
  const radius = Math.max(1.5, Math.min(3, cellSize / 16));
  const painted = new Path2D();
  const empty = new Path2D();
  for (const slot of allSlots(true)) {
    const x = slot.x * cellSize;
    const y = slot.y * cellSize;
    const path = layer[slot.list][slot.index] ? painted : empty;
    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, Math.PI * 2);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fill(painted);
  ctx.stroke(painted);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.stroke(empty);
}

// Outlines one pixel: a circle in circle mode, a square in square mode. Radius is in cells.
function outline(x, y, radius) {
  ctx.beginPath();
  if (settings.circles) {
    ctx.arc(x * cellSize, y * cellSize, radius * cellSize, 0, Math.PI * 2);
  } else {
    ctx.rect((x - radius) * cellSize, (y - radius) * cellSize, radius * 2 * cellSize, radius * 2 * cellSize);
  }
  ctx.stroke();
}

// Brush: an outline the size of the brush. Shapes: an outline on every pixel they'll paint.
function drawPreview() {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 1.5;
  const shape = currentShape();
  if (shape) {
    for (const slot of shapeSlots(shape)) outline(slot.x, slot.y, 0.5);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.beginPath();
    shape.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x * cellSize, p.y * cellSize);
      else ctx.lineTo(p.x * cellSize, p.y * cellSize);
    });
    if (shape.closed) ctx.closePath();
    ctx.stroke();
    return;
  }
  if (hover && tool !== "zoom") outline(hover.x, hover.y, Math.max(0.5, settings.brushSize / 2));
}

function fitCanvas() {
  const area = document.querySelector(".canvas-area");
  const room = Math.min(area.clientWidth, area.clientHeight) - 32;
  fitSize = Math.max(2, Math.floor(room / Math.max(sprite.width, sprite.height)));
  cellSize = fitSize;
  sizeCanvas();
}

function sizeCanvas() {
  canvas.width = sprite.width * cellSize;
  canvas.height = sprite.height * cellSize;
  document.getElementById("zoom-value").textContent = Math.round(cellSize / fitSize * 100) + "%";
}

// The sprite is rendered at most 32 pixels per cell, then stretched to the zoom.
// It's only re-rendered when the drawing changes, so moving the mouse stays fast.
// While you're painting or dragging a slider it renders rougher (drafting), then sharp
// again when you let go.
const renderCanvas = document.createElement("canvas");
let renderedScale = 0;
let spriteChanged = true;
let drafting = false;

function draw() {
  const scale = Math.min(cellSize, drafting ? 10 : 32);
  if (spriteChanged || scale !== renderedScale) {
    const image = renderSprite(scale);
    renderCanvas.width = image.width;
    renderCanvas.height = image.height;
    renderCanvas.getContext("2d").putImageData(image, 0, 0);
    renderedScale = scale;
    spriteChanged = false;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(renderCanvas, 0, 0, canvas.width, canvas.height);
  if (settings.showGrid) drawGrid();
  drawPreview();
}

function redrawSprite() {
  spriteChanged = true;
  draw();
}

function startDraft() {
  drafting = true;
}

function endDraft() {
  if (!drafting) return;
  drafting = false;
  draw();
}

function refresh() {
  redrawSprite();
  drawLayerList();
  autosave();
}

// ---------- Zoom ----------

// Zooms so the point under (clientX, clientY) stays under the mouse.
function zoomTo(newSize, clientX, clientY) {
  const area = document.querySelector(".canvas-area");
  const biggest = Math.max(sprite.width, sprite.height);
  const maxSize = Math.min(200, Math.floor(8000 / biggest));
  newSize = Math.max(2, Math.min(maxSize, Math.round(newSize)));
  if (newSize === cellSize) return;

  const before = canvas.getBoundingClientRect();
  const cellX = (clientX - before.left) / cellSize;
  const cellY = (clientY - before.top) / cellSize;
  cellSize = newSize;
  sizeCanvas();
  draw();
  const after = canvas.getBoundingClientRect();
  area.scrollLeft += after.left + cellX * cellSize - clientX;
  area.scrollTop += after.top + cellY * cellSize - clientY;
}

function zoomAtCenter(factor) {
  const box = document.querySelector(".canvas-area").getBoundingClientRect();
  zoomTo(cellSize * factor, box.left + box.width / 2, box.top + box.height / 2);
}

document.querySelector(".canvas-area").addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.25 : 0.8;
  zoomTo(cellSize * factor, event.clientX, event.clientY);
}, { passive: false });

document.getElementById("zoom-in").addEventListener("click", () => zoomAtCenter(1.25));
document.getElementById("zoom-out").addEventListener("click", () => zoomAtCenter(0.8));
document.getElementById("zoom-fit").addEventListener("click", () => {
  fitCanvas();
  draw();
});

// ---------- Geometry ----------

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToOutline(p, points, closed) {
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
  let best = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    best = Math.min(best, distanceToSegment(p, points[i], points[(i + 1) % points.length]));
  }
  return best;
}

function insidePolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------- Shapes ----------

// The shape being drawn right now: { points, closed, filled }, or null.
function currentShape() {
  if (tool === "polygon" && polygonPoints.length > 0) {
    const points = hover ? polygonPoints.concat([hover]) : polygonPoints;
    return { points: points, closed: points.length > 2, filled: settings.fillShapes };
  }
  if (!shapeStart || !hover) return null;
  const a = shapeStart;
  const b = hover;
  if (tool === "line") {
    return { points: [a, b], closed: false, filled: false };
  }
  if (tool === "rect") {
    const points = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
    return { points: points, closed: true, filled: settings.fillShapes };
  }
  if (tool === "ellipse") {
    const centerX = (a.x + b.x) / 2;
    const centerY = (a.y + b.y) / 2;
    const radiusX = Math.abs(b.x - a.x) / 2;
    const radiusY = Math.abs(b.y - a.y) / 2;
    const points = [];
    for (let i = 0; i < 64; i++) {
      const angle = i / 64 * Math.PI * 2;
      points.push({ x: centerX + Math.cos(angle) * radiusX, y: centerY + Math.sin(angle) * radiusY });
    }
    return { points: points, closed: true, filled: settings.fillShapes };
  }
  return null;
}

// Every circle a shape paints: near its outline (within half the brush), or inside it when filled.
function shapeSlots(shape) {
  const half = settings.brushSize / 2;
  return allSlots(settings.circles).filter((slot) => {
    if (distanceToOutline(slot, shape.points, shape.closed) < half) return true;
    return shape.filled && shape.closed && insidePolygon(slot, shape.points);
  });
}

function brushSlots(center) {
  const half = Math.max(0.5, settings.brushSize / 2) - 0.001;
  return allSlots(settings.circles).filter((slot) => Math.hypot(slot.x - center.x, slot.y - center.y) < half);
}

function paintSlots(slots) {
  const layer = sprite.layers[currentLayer];
  const value = erasing ? null : settings.color;
  let changed = false;
  for (const slot of slots) {
    if (layer[slot.list][slot.index] === value) continue;
    layer[slot.list][slot.index] = value;
    changed = true;
  }
  if (changed) redrawSprite();
}

function finishShape() {
  const shape = currentShape();
  shapeStart = null;
  polygonPoints = [];
  if (!shape) return;
  saveUndo();
  paintSlots(shapeSlots(shape));
  autosave();
  draw();
}

function cancelShape() {
  shapeStart = null;
  polygonPoints = [];
  draw();
}

// ---------- Painting ----------

function saveUndo() {
  undoStack.push(JSON.stringify(sprite));
  if (undoStack.length > 50) undoStack.shift();
}

function undo() {
  if (undoStack.length === 0) return;
  const saved = JSON.parse(undoStack.pop());
  sprite.width = saved.width;
  sprite.height = saved.height;
  sprite.layers = saved.layers;
  currentLayer = Math.min(currentLayer, sprite.layers.length - 1);
  fitCanvas();
  refresh();
}

// The spot nearest the mouse. In square mode that's the square it's in. In circle mode
// spots sit every half cell, so the mouse snaps to the nearest half cell and the spot's
// kind comes from whether x and y land on a square's middle or on a grid line.
// Returns { list, index, x, y }, or null off the sprite.
function circleAt(event) {
  const box = canvas.getBoundingClientRect();
  const fx = (event.clientX - box.left) / cellSize;
  const fy = (event.clientY - box.top) / cellSize;
  if (fx < 0 || fy < 0 || fx >= sprite.width || fy >= sprite.height) return null;

  let x = Math.floor(fx) + 0.5;
  let y = Math.floor(fy) + 0.5;
  if (settings.circles) {
    x = Math.max(0.5, Math.min(sprite.width - 0.5, Math.round(fx * 2) / 2));
    y = Math.max(0.5, Math.min(sprite.height - 0.5, Math.round(fy * 2) / 2));
  }

  const onLineX = Number.isInteger(x);
  const onLineY = Number.isInteger(y);
  let list = "centers";
  if (onLineX && onLineY) list = "corners";
  else if (onLineX) list = "betweenX";
  else if (onLineY) list = "betweenY";

  const kind = slotKinds().find((k) => k.list === list);
  const index = (y - kind.y0) * kind.columns + (x - kind.x0);
  return { list: list, index: index, x: x, y: y };
}

// Picks the color from the topmost visible layer that has this circle painted.
function pickAt(circle) {
  for (let i = sprite.layers.length - 1; i >= 0; i--) {
    const layer = sprite.layers[i];
    const color = layer[circle.list][circle.index];
    if (layer.visible && color) {
      setColor(color);
      return;
    }
  }
}

// ---------- Panning ----------

// Hold the middle mouse button (the wheel) and drag to move around a zoomed-in sprite.
const canvasArea = document.querySelector(".canvas-area");
let panStart = null;

canvasArea.addEventListener("pointerdown", (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  panStart = { x: event.clientX, y: event.clientY, left: canvasArea.scrollLeft, top: canvasArea.scrollTop };
  canvasArea.setPointerCapture(event.pointerId);
  canvasArea.classList.add("panning");
});

canvasArea.addEventListener("pointermove", (event) => {
  if (!panStart) return;
  canvasArea.scrollLeft = panStart.left - (event.clientX - panStart.x);
  canvasArea.scrollTop = panStart.top - (event.clientY - panStart.y);
});

canvasArea.addEventListener("pointerup", (event) => {
  if (event.button !== 1 || !panStart) return;
  panStart = null;
  canvasArea.classList.remove("panning");
});

// Stops the browser's own middle-click scrolling from taking over.
canvasArea.addEventListener("mousedown", (event) => {
  if (event.button === 1) event.preventDefault();
});

// ---------- Mouse on the canvas ----------

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 1) return;
  if (tool === "zoom") {
    const factor = event.button === 2 ? 0.5 : 2;
    zoomTo(cellSize * factor, event.clientX, event.clientY);
    return;
  }
  const circle = circleAt(event);
  if (!circle) return;
  if (event.altKey) {
    pickAt(circle);
    return;
  }

  if (tool === "paint") {
    saveUndo();
    painting = true;
    startDraft();
    erasing = event.button === 2;
    canvas.setPointerCapture(event.pointerId);
    paintSlots(brushSlots(circle));
  } else if (tool === "polygon") {
    if (polygonPoints.length === 0) erasing = event.button === 2;
    const first = polygonPoints[0];
    if (polygonPoints.length > 2 && first.x === circle.x && first.y === circle.y) {
      hover = null;
      finishShape();
    } else {
      polygonPoints.push(circle);
      draw();
    }
  } else {
    shapeStart = circle;
    erasing = event.button === 2;
    canvas.setPointerCapture(event.pointerId);
    draw();
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (panStart) return;
  hover = circleAt(event) || hover;
  if (painting && hover) paintSlots(brushSlots(hover));
  draw();
});

canvas.addEventListener("pointerleave", () => {
  if (painting || shapeStart) return;
  hover = null;
  draw();
});

canvas.addEventListener("pointerup", () => {
  if (painting) {
    painting = false;
    endDraft();
    autosave();
  }
  if (shapeStart) finishShape();
});

canvas.addEventListener("dblclick", () => {
  if (tool === "polygon") {
    hover = null;
    finishShape();
  }
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

// ---------- Tools ----------

function setTool(name) {
  tool = name;
  cancelShape();
  canvas.classList.toggle("zoom-tool", tool === "zoom");
  for (const button of document.querySelectorAll("[data-tool]")) {
    button.classList.toggle("active", button.dataset.tool === tool);
  }
}

for (const button of document.querySelectorAll("[data-tool]")) {
  button.addEventListener("click", () => setTool(button.dataset.tool));
}

const brushInput = document.getElementById("brush-size");

function setBrushSize(size) {
  settings.brushSize = Math.max(1, Math.min(8, size));
  brushInput.value = settings.brushSize;
  document.getElementById("brush-value").textContent = settings.brushSize;
  draw();
}

brushInput.addEventListener("input", () => setBrushSize(Number(brushInput.value)));

document.getElementById("fill-shapes").addEventListener("change", (event) => {
  settings.fillShapes = event.target.checked;
  draw();
});

const circlesInput = document.getElementById("circles");

// Switches between square pixels and circle mode. The drawing stays the same either way.
function setCircles(on) {
  settings.circles = on;
  circlesInput.checked = on;
  document.querySelector(".layers").classList.toggle("square-mode", !on);
  redrawSprite();
}

circlesInput.addEventListener("change", () => setCircles(circlesInput.checked));

document.addEventListener("keydown", (event) => {
  if (event.target.tagName === "INPUT") return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "z") {
    event.preventDefault();
    undo();
  } else if (event.key === "Enter") {
    hover = null;
    finishShape();
  } else if (event.key === "Escape") {
    cancelShape();
  } else if (key === "c") {
    setCircles(!settings.circles);
  } else if (toolKeys[key]) {
    setTool(toolKeys[key]);
  } else if (key === "[") {
    setBrushSize(settings.brushSize - 1);
  } else if (key === "]") {
    setBrushSize(settings.brushSize + 1);
  } else if (key === "=" || key === "+") {
    zoomAtCenter(1.25);
  } else if (key === "-") {
    zoomAtCenter(0.8);
  } else if (key === "0") {
    fitCanvas();
    draw();
  }
});

// ---------- Color ----------

function setColor(color) {
  settings.color = color;
  document.getElementById("color").value = color;
}

function drawPalette() {
  const holder = document.getElementById("palette");
  for (const color of palette) {
    const swatch = document.createElement("div");
    swatch.className = "swatch";
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener("click", () => setColor(color));
    holder.appendChild(swatch);
  }
}

document.getElementById("color").addEventListener("input", (event) => {
  settings.color = event.target.value;
});

// ---------- Layer panel ----------

// The Smooth edges and Color blend sliders always show the selected layer.
const layerSliders = ["smoothing", "blend"];

function showLayerSliders() {
  const layer = sprite.layers[currentLayer];
  for (const field of layerSliders) {
    document.getElementById("layer-" + field).value = layer[field];
    document.getElementById("layer-" + field + "-value").textContent = layer[field].toFixed(2);
  }
  if (layer.smoothing < smoothingOn) document.getElementById("layer-smoothing-value").textContent = "off";
}

for (const field of layerSliders) {
  const input = document.getElementById("layer-" + field);
  input.addEventListener("input", () => {
    startDraft();
    sprite.layers[currentLayer][field] = Number(input.value);
    showLayerSliders();
    redrawSprite();
  });
  input.addEventListener("change", () => {
    endDraft();
    autosave();
  });
}

function selectLayer(index) {
  currentLayer = index;
  drawLayerList();
}

function drawLayerList() {
  const list = document.getElementById("layer-list");
  list.innerHTML = "";
  for (let i = sprite.layers.length - 1; i >= 0; i--) {
    const layer = sprite.layers[i];
    const row = document.createElement("li");
    if (i === currentLayer) row.className = "selected";

    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = layer.visible;
    visible.title = "Show / hide";
    visible.addEventListener("click", (event) => event.stopPropagation());
    visible.addEventListener("change", () => {
      layer.visible = visible.checked;
      refresh();
    });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name;
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", () => {
      const newName = prompt("Layer name", layer.name);
      if (newName) {
        layer.name = newName;
        refresh();
      }
    });

    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Delete layer";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteLayer(i);
    });

    row.addEventListener("click", () => selectLayer(i));
    row.append(visible, name, remove);
    list.appendChild(row);
  }
  showLayerSliders();
}

function deleteLayer(index) {
  if (sprite.layers.length === 1) return;
  saveUndo();
  sprite.layers.splice(index, 1);
  currentLayer = Math.min(currentLayer, sprite.layers.length - 1);
  refresh();
}

document.getElementById("add-layer").addEventListener("click", () => {
  saveUndo();
  sprite.layers.push(makeLayer("Layer " + (sprite.layers.length + 1)));
  currentLayer = sprite.layers.length - 1;
  refresh();
});

document.getElementById("clear-layer").addEventListener("click", () => {
  saveUndo();
  for (const kind of slotKinds()) sprite.layers[currentLayer][kind.list].fill(null);
  refresh();
});

document.getElementById("undo").addEventListener("click", undo);

// ---------- Settings ----------

document.getElementById("show-grid").addEventListener("change", (event) => {
  settings.showGrid = event.target.checked;
  draw();
});

document.getElementById("export-scale").addEventListener("change", (event) => {
  settings.exportScale = Number(event.target.value);
});

document.getElementById("new-sprite").addEventListener("click", () => {
  if (!confirm("Start a new sprite? Unsaved work will be lost.")) return;
  const width = Number(document.getElementById("grid-width").value) || 16;
  const height = Number(document.getElementById("grid-height").value) || 16;
  newSprite(width, height);
});

// ---------- Files ----------

function download(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

document.getElementById("export-png").addEventListener("click", () => {
  const image = renderSprite(settings.exportScale);
  const out = document.createElement("canvas");
  out.width = image.width;
  out.height = image.height;
  out.getContext("2d").putImageData(image, 0, 0);
  out.toBlob((blob) => download(blob, "chispita_sprite.png"));
});

document.getElementById("save-project").addEventListener("click", () => {
  const project = { sprite: sprite, settings: settings };
  const blob = new Blob([JSON.stringify(project)], { type: "application/json" });
  download(blob, "chispita_sprite.json");
});

document.getElementById("open-project").addEventListener("click", () => {
  document.getElementById("open-file").click();
});

document.getElementById("open-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  loadProject(JSON.parse(await file.text()));
  event.target.value = "";
});

// Brings layers from older saves up to date:
// - the first versions kept square and corner circles on separate layers ("cells")
// - smoothing used to be one setting for the whole sprite, and there was no blend
// - there were no in-between spots (betweenX, betweenY)
function upgradeLayer(layer, oldSmoothing) {
  for (const kind of slotKinds()) {
    if (layer.centers && !layer[kind.list]) layer[kind.list] = new Array(kind.columns * kind.rows).fill(null);
  }
  let upgraded = layer;
  if (!layer.centers) {
    upgraded = makeLayer(layer.name);
    upgraded.visible = layer.visible;
    if (layer.offset) {
      upgraded.corners = layer.cells;
    } else {
      upgraded.centers = layer.cells;
    }
  }
  if (!upgraded.smoothing) upgraded.smoothing = oldSmoothing || 0.85;
  upgraded.smoothing = Math.max(0.85, upgraded.smoothing);
  if (upgraded.blend === undefined) upgraded.blend = 1;
  return upgraded;
}

function loadProject(project) {
  sprite.width = project.sprite.width;
  sprite.height = project.sprite.height;
  sprite.layers = project.sprite.layers.map((layer) => upgradeLayer(layer, project.settings.smoothing));
  Object.assign(settings, project.settings);
  delete settings.smoothing;
  delete settings.weighted;
  delete settings.useCorners;
  currentLayer = 0;
  undoStack.length = 0;
  setColor(settings.color);
  setBrushSize(settings.brushSize || 1);
  document.getElementById("fill-shapes").checked = settings.fillShapes;
  setCircles(Boolean(settings.circles));
  document.getElementById("show-grid").checked = settings.showGrid;
  document.getElementById("export-scale").value = settings.exportScale;
  document.getElementById("grid-width").value = sprite.width;
  document.getElementById("grid-height").value = sprite.height;
  fitCanvas();
  refresh();
}

// Keeps your work if the page is closed. Browser storage can be blocked, so failures are ignored.
function autosave() {
  try {
    localStorage.setItem("chispita_sprite", JSON.stringify({ sprite: sprite, settings: settings }));
  } catch (error) {}
}

function autoload() {
  try {
    const saved = localStorage.getItem("chispita_sprite");
    if (saved) {
      loadProject(JSON.parse(saved));
      return true;
    }
  } catch (error) {}
  return false;
}

// ---------- Start ----------

drawPalette();
setBrushSize(1);
setCircles(false);
if (!autoload()) newSprite(16, 16);
