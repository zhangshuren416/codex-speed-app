// 边缘吸附的纯几何计算：不依赖 Electron，可单测。
// 主进程（index.mjs）按当前缩放传入像素尺寸，这里只负责算 bounds / 选边。
//
// 约定：
//   * area 是显示器工作区 { x, y, width, height }（已排除任务栏）；
//   * edge ∈ left/right/top/bottom；
//   * anchor 是气泡沿吸附边的坐标（左右边=y，上下边=x），可为任意值，内部夹回工作区。

export const BUBBLE_SIZE_CSS = 40; // 气泡边长（CSS 像素，与 hud.css 的 .bubble 一致）
export const SNAP_DISTANCE = 24; // 松手时窗口边缘距工作区边缘 ≤ 该值即吸附

export function clampAlong(value, min, max) {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max));
}

/** 气泡 bounds：贴住工作区边缘，side 为气泡边长（像素）。 */
export function bubbleBounds(area, edge, anchor, side) {
  if (edge === "left" || edge === "right") {
    const y = clampAlong(anchor, area.y, area.y + area.height - side);
    const x = edge === "left" ? area.x : area.x + area.width - side;
    return { x, y, width: side, height: side };
  }
  const x = clampAlong(anchor, area.x, area.x + area.width - side);
  const y = edge === "top" ? area.y : area.y + area.height - side;
  return { x, y, width: side, height: side };
}

/** 展开 bounds：同样贴边，沿边方向以气泡为中心，夹回工作区内。 */
export function expandedBounds(area, edge, anchor, width, height, side) {
  const center = anchor + side / 2;
  if (edge === "left" || edge === "right") {
    const y = clampAlong(center - height / 2, area.y, area.y + area.height - height);
    const x = edge === "left" ? area.x : area.x + area.width - width;
    return { x, y, width, height };
  }
  const x = clampAlong(center - width / 2, area.x, area.x + area.width - width);
  const y = edge === "top" ? area.y : area.y + area.height - height;
  return { x, y, width, height };
}

/** 松手时判断该吸到哪条边：取阈值内最近的一条；都不够近返回 null。 */
export function snapTargetFor(bounds, area, side, threshold = SNAP_DISTANCE) {
  const candidates = [
    ["left", bounds.x - area.x],
    ["right", area.x + area.width - (bounds.x + bounds.width)],
    ["top", bounds.y - area.y],
    ["bottom", area.y + area.height - (bounds.y + bounds.height)],
  ];
  let best = null;
  for (const [edge, distance] of candidates) {
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = { edge, distance };
    }
  }
  if (!best) return null;
  const center =
    best.edge === "left" || best.edge === "right"
      ? bounds.y + bounds.height / 2
      : bounds.x + bounds.width / 2;
  return { edge: best.edge, anchor: Math.round(center - side / 2) };
}
