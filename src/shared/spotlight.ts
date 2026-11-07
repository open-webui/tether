import type { Connection } from './connections'
import type { TetherEvent } from './events'

export interface SpotlightInit {
  language: string
  connections: Connection[]
  selected: string | null
  width: number
  height: number
  position: { x: number; y: number } | null
  dark: boolean
  clipboard: string
  useScreenPicker: boolean
}

export interface SpotlightAPI {
  onInit(callback: (state: SpotlightInit) => void): () => void
  onHide(callback: () => void): () => void
  close(): Promise<void>
  addConnection(): Promise<void>
  sendEvent(connection: Connection, event: TetherEvent): Promise<void>
  capture(rect?: { x: number; y: number; width: number; height: number }): Promise<string>
  savePosition(position: { x: number; y: number }): Promise<void>
}
