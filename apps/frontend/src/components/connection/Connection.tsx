import { useEffect, useState } from "react"
import { useSelector } from "react-redux"
import { nanoid } from "@reduxjs/toolkit"
import { HousePlug } from "lucide-react"
import { CONNECTED, CONNECTING, MAX_CONNECTIONS, RECONNECTING } from "@common/src/constants.ts"
import { toast } from "sonner"
import ConnectionForm from "../ui/connection-form.tsx"
import EditForm from "../ui/edit-form.tsx"
import { PasswordPromptModal } from "../ui/password-prompt-modal.tsx"
import RouteContainer from "../ui/route-container.tsx"
import { Button } from "../ui/button.tsx"
import { EmptyState } from "../ui/empty-state.tsx"
import { LoadingState } from "../ui/loading-state.tsx"
import { SearchInput } from "../ui/search-input.tsx"
import { Typography } from "../ui/typography.tsx"
import { wasRefreshedFrom } from "@/history.ts"
import { type ConnectionState } from "@/state/valkey-features/connection/connectionSlice.ts"
import {
  selectConnections, selectPromptedConnection, selectPromptDiscovery, type ConnectionPrompt
} from "@/state/valkey-features/connection/connectionSelectors.ts"
import { ConnectionEntry } from "@/components/connection/ConnectionEntry.tsx"
import { ClusterConnectionGroup } from "@/components/connection/ClusterConnectionGroup.tsx"
import { useAppDispatch } from "@/hooks/hooks.ts"
import { secureStorage, PASSWORD_NOT_STORED_WARNING } from "@/utils/secureStorage.ts"
import { clearEndpointDiscovery } from "@/state/valkey-features/topology/topologySlice"
import { passwordConnectionRequested } from "@/state/epics/passwordConnectionEpic"

const matchesSearch = (q: string, connection: ConnectionState) =>
  connection.searchableText.includes(q)

export function Connection() {
  const dispatch = useAppDispatch()
  const [showConnectionForm, setShowConnectionForm] = useState(false)
  const [showEditForm, setShowEditForm] = useState(false)
  const [editingConnectionId, setEditingConnectionId] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState("")
  const [passwordPrompt, setPasswordPrompt] = useState<ConnectionPrompt | undefined>(undefined)
  const connections = useSelector(selectConnections)
  const [discoveryId, setDiscoveryId] = useState<string | undefined>(undefined)
  const discovery = useSelector(selectPromptDiscovery(discoveryId))
  const promptedConnection = useSelector(selectPromptedConnection(passwordPrompt))
  useEffect(() => () => {
    if (discoveryId) dispatch(clearEndpointDiscovery({ discoveryId }))
  }, [dispatch, discoveryId])

  const handleEditConnection = (connectionId: string) => {
    setEditingConnectionId(connectionId)
    setShowEditForm(true)
  }

  const handleCloseEditForm = () => {
    setShowEditForm(false)
    setEditingConnectionId(undefined)
  }

  const handlePasswordRequired = (connectionId: string) => {
    const catalogId = connections[connectionId]?.catalogId
    const prompt: ConnectionPrompt = catalogId !== undefined
      ? { kind: "catalog", id: catalogId } : { kind: "connection", id: connectionId }
    if (discoveryId) dispatch(clearEndpointDiscovery({ discoveryId }))
    setDiscoveryId(undefined)
    setPasswordPrompt(prompt)
  }

  const handlePasswordSubmit = async (password: string, username?: string) => {
    if (!passwordPrompt) return
    if (discoveryId) dispatch(clearEndpointDiscovery({ discoveryId }))
    const attemptId = nanoid()
    setDiscoveryId(attemptId)
    const result = await secureStorage.encryptForStorage(password)
    if (!result.ok && secureStorage.isElectron()) toast.warning(PASSWORD_NOT_STORED_WARNING, { duration: 10_000 })
    dispatch(passwordConnectionRequested({
      prompt: passwordPrompt,
      discoveryId: attemptId,
      username,
      password: result.ok ? result.value : password,
      isPasswordEncrypted: result.ok,
    }))
  }

  // check if any connection is resuming (reconnecting, connecting, or connected) after a refresh
  // CONNECTED is included to avoid a flash of the connection list
  const isResuming = Object.entries(connections).some(([connectionId, connection]) =>
    wasRefreshedFrom(connectionId) &&
    (connection.status === RECONNECTING ||
      connection.status === CONNECTING ||
      connection.status === CONNECTED),
  )

  const isPromptConnecting = promptedConnection?.status === CONNECTING || discovery?.status === "pending"
  const promptErrorMessage = promptedConnection?.errorMessage || discovery?.errorMessage
  const promptConnectionLabel = promptedConnection
    ? promptedConnection.connectionDetails.alias
      || `${promptedConnection.connectionDetails.host}:${promptedConnection.connectionDetails.port}`
    : ""

  // Preconfigured entries are visible before their first connection; manual entries still require history.
  const visibleConnections = Object.entries(connections)
    .filter(([, connection]) => connection.preconfigured || (connection.connectionHistory ?? []).length > 0)
    .sort(([, a], [, b]) =>
      (b.connectionHistory?.length ?? 0) - (a.connectionHistory?.length ?? 0),
    )

  // grouping connections
  const { clusterGroups, standaloneConnections } = visibleConnections.reduce<{
    clusterGroups: Record<string, Array<{ connectionId: string; connection: ConnectionState }>>
    standaloneConnections: Array<{ connectionId: string; connection: ConnectionState }>
  }>(
    (acc, [connectionId, connection]) => {
      const clusterId = connection.connectionDetails.clusterId
      if (clusterId)
        (acc.clusterGroups[clusterId] ??= []).push({ connectionId, connection })
      else
        acc.standaloneConnections.push({ connectionId, connection })
      return acc
    },
    { clusterGroups: {}, standaloneConnections: [] },
  )

  const hasConnections = visibleConnections.length > 0

  // Filter by search query
  const q = searchQuery.toLowerCase()
  const filteredClusterGroups: typeof clusterGroups = {}
  if (q) {
    for (const [clusterId, conns] of Object.entries(clusterGroups)) {
      const matched = conns.filter(({ connection }) => matchesSearch(q, connection))
      if (matched.length > 0) filteredClusterGroups[clusterId] = matched
    }
  }
  const filteredStandaloneConnections = q
    ? standaloneConnections.filter(({ connection }) => matchesSearch(q, connection))
    : standaloneConnections

  const hasFilteredClusters = q ? Object.keys(filteredClusterGroups).length > 0 : Object.keys(clusterGroups).length > 0
  const hasFilteredStandalone = q ? filteredStandaloneConnections.length > 0 : standaloneConnections.length > 0
  const hasAnyResults = hasFilteredClusters || hasFilteredStandalone
  const displayClusterGroups = q ? filteredClusterGroups : clusterGroups

  const totalResults = filteredStandaloneConnections.length +
    Object.values(displayClusterGroups).reduce((sum, conns) => sum + conns.length, 0)
    
  const highlight = q && totalResults < MAX_CONNECTIONS ? q : ""

  return (
    <RouteContainer className="relative" title="connection">
      {isResuming && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/60 dark:bg-tw-dark-primary/60 backdrop-blur-xs">
          <LoadingState message="Reconnecting..." />
        </div>
      )}

      {/* top header */}
      <div className="flex items-center justify-between h-10">
        <Typography className="flex items-center gap-2" variant="heading">
          <HousePlug size={20} /> Connections
        </Typography>
        {hasConnections && (
          <Button
            onClick={() => setShowConnectionForm(!showConnectionForm)}
            size="sm"
            variant={"default"}
          >
            + Add Connection
          </Button>
        )}
      </div>

      {showConnectionForm && <ConnectionForm onClose={() => setShowConnectionForm(false)} />}
      {showEditForm && <EditForm connectionId={editingConnectionId} onClose={handleCloseEditForm} />}
      {passwordPrompt !== undefined && promptedConnection && promptedConnection.status !== CONNECTED && <PasswordPromptModal
        connectionLabel={promptConnectionLabel}
        defaultUsername={promptedConnection?.preconfigured ? promptedConnection.connectionDetails.username ?? "default" : undefined}
        errorMessage={promptErrorMessage}
        isConnecting={isPromptConnecting}
        key={`${passwordPrompt.kind}:${passwordPrompt.id}`}
        onClose={() => {
          if (discoveryId) dispatch(clearEndpointDiscovery({ discoveryId }))
          setPasswordPrompt(undefined)
        }}
        onSubmit={handlePasswordSubmit}
        open
      />}

      {!hasConnections ? (
        <EmptyState
          action={
            <Button
              onClick={() => setShowConnectionForm(!showConnectionForm)}
              size="sm"
              variant={"default"}
            >
              + Add Connection
            </Button>
          }
          description="Click '+ Add Connection' button to connect to a Valkey instance or cluster."
          title="You Have No Connections!"
        />
      ) : (
        <>
          {/* Search */}
          <SearchInput
            onChange={(e) => setSearchQuery(e.target.value)}
            onClear={() => setSearchQuery("")}
            placeholder="Search connections by host, port, or alias..."
            value={searchQuery}
          />
          <div className="flex-1 h-full border border-input rounded-md shadow-xs overflow-y-auto px-4 py-2">
            {!hasAnyResults && q ? (
              <div className="text-center py-8 text-muted-foreground min-h-40">
                No connections match "{searchQuery}"
              </div>
            ) : (
              <>
                {/* for clusters */}
                {hasFilteredClusters && (
                  <div className="mb-8">
                    <Typography className="mb-2" variant="bodyLg">Clusters</Typography>
                    <div>
                      {Object.entries(displayClusterGroups).map(([clusterId, clusterConnections]) => (
                        <ClusterConnectionGroup
                          clusterId={clusterId}
                          connections={clusterConnections}
                          highlight={highlight}
                          key={clusterId}
                          onEdit={handleEditConnection}
                          onPasswordRequired={handlePasswordRequired}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* for standalone instances */}
                {hasFilteredStandalone && (
                  <div>
                    <Typography className="mb-2" variant="bodyLg">Instances</Typography>
                    <div>
                      {filteredStandaloneConnections.map(({ connectionId, connection }) => (
                        <ConnectionEntry
                          connection={connection}
                          connectionId={connectionId}
                          highlight={highlight}
                          key={connectionId}
                          onEdit={handleEditConnection}
                          onPasswordRequired={handlePasswordRequired}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div></>
      )}
    </RouteContainer>
  )
}
