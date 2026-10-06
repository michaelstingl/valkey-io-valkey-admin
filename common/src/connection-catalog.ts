import type { EndpointType } from "./constants"

/** Connection metadata without credentials; users enter passwords through the existing connect flow. */
export interface CatalogConnection {
  /** Stable catalog entry ID, independent of the discovered node's connection ID. */
  catalogId?: string
  /** Changes when connection settings change; display-only aliases do not affect it. */
  revision?: string
  connectionId: string
  /** Session-specific hint; the connect handler still enforces resume authorization. */
  resumeAvailable?: boolean
  /** Original connection details for rediscovery when a previously discovered node becomes unavailable. */
  sourceConnectionDetails?: CatalogConnection["connectionDetails"]
  connectionDetails: {
    host: string
    port: string
    username?: string
    alias?: string
    tls: boolean
    verifyTlsCertificate: boolean
    endpointType: EndpointType
    authType: "password"
    db: number
  }
}
