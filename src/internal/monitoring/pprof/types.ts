export type PprofRequestTargetType = 'heap' | 'heap-snapshot' | 'profile'
export type ProfileClass = 'auto' | 'manual'
export type ProfileKind = 'cpu' | 'heap'

export interface PprofStoredProfile {
  id: string
  class: ProfileClass
  kind: ProfileKind
  service: string
  reason: string
  startedAt: string
  durationSeconds: number
  hostname: string
  applicationId?: string
  workerId?: string
  processId: number
  build: string
  size?: number
  etag?: string
}

export interface PprofStoredProfileList {
  profiles: PprofStoredProfile[]
  cursor?: string
}
