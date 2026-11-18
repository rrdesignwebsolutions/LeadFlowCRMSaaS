export const DEFAULT_SIDEBAR_WIDTH = 340
export const MIN_SIDEBAR_WIDTH = 270
export const MAX_SIDEBAR_WIDTH = 700
export const MIN_CHAT_WIDTH = 320
export const RESIZER_WIDTH = 8

export function sidebarWidthLimit(containerWidth: number) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, containerWidth - MIN_CHAT_WIDTH - RESIZER_WIDTH))
}

export function clampSidebarWidth(width: number, containerWidth: number) {
  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(sidebarWidthLimit(containerWidth), width)))
}
