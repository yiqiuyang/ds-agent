import type { DshApi } from '../../preload/index'

declare global {
  interface Window {
    dsh: DshApi
  }
}

export {}
