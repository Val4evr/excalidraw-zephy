import React, { useState, useEffect, useRef } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'

const ROOM_ID = (() => {
  const m = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?/)
  return m ? m[1] : ''
})()
const API_BASE = ROOM_ID ? `/api/r/${ROOM_ID}` : ''

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
  // Arrow element binding
  start?: { id: string };
  end?: { id: string };
  strokeStyle?: string;
  endArrowhead?: string;
  startArrowhead?: string;
  // Image element fields
  fileId?: string;
  status?: string;
  scale?: [number, number];
  angle?: number;
  link?: string | null;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  files?: Record<string, unknown>;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
const AUTO_SYNC_DEBOUNCE_MS = 1200;

// Helper function to clean elements for Excalidraw
const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
}

// Helper function to validate and fix element binding data
const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));

  return elements.map(element => {
    const fixedElement = { ...element };

    // Validate and fix boundElements
    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          // Ensure binding has required properties
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;

          // Ensure the referenced element exists
          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement) return false;

          // Validate binding type
          if (!['text', 'arrow'].includes(binding.type)) return false;

          return true;
        });

        // Remove boundElements if empty
        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        // Invalid boundElements format, set to null
        fixedElement.boundElements = null;
      }
    }

    // Validate and fix containerId
    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        // Container doesn't exist, remove containerId
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
}

const isImageElement = (element: Partial<ExcalidrawElement>): boolean => {
  return element.type === 'image'
}

const isShapeContainerType = (type: string | undefined): boolean => {
  return type === 'rectangle' || type === 'ellipse' || type === 'diamond'
}

const recenterBoundShapeTextElements = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map((el) => [el.id, el]))

  return elements.map((element) => {
    if (element.type !== 'text' || !element.containerId) {
      return element
    }

    const textElement = element as ExcalidrawElement & { type: 'text'; containerId: string; autoResize?: boolean }
    const container = elementMap.get(textElement.containerId) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined
    if (!container || !isShapeContainerType(container.type)) {
      return element
    }

    if (textElement.autoResize === false) {
      return element
    }

    if (
      typeof container.x !== 'number' ||
      typeof container.y !== 'number' ||
      typeof container.width !== 'number' ||
      typeof container.height !== 'number' ||
      typeof textElement.width !== 'number' ||
      typeof textElement.height !== 'number'
    ) {
      return element
    }

    return {
      ...element,
      x: container.x + (container.width - textElement.width) / 2,
      y: container.y + (container.height - textElement.height) / 2,
    }
  })
}

const normalizeImageElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const img = element as any
  return {
    ...img,
    angle: img.angle || 0,
    strokeColor: img.strokeColor || 'transparent',
    backgroundColor: img.backgroundColor || 'transparent',
    fillStyle: img.fillStyle || 'solid',
    strokeWidth: img.strokeWidth || 1,
    strokeStyle: img.strokeStyle || 'solid',
    roughness: img.roughness ?? 0,
    opacity: img.opacity ?? 100,
    groupIds: img.groupIds || [],
    roundness: null,
    seed: img.seed || Math.floor(Math.random() * 1000000),
    version: img.version || 1,
    versionNonce: img.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: img.isDeleted ?? false,
    boundElements: img.boundElements || null,
    link: img.link || null,
    locked: img.locked || false,
    status: img.status || 'saved',
    fileId: img.fileId,
    scale: img.scale || [1, 1],
  }
}

// Helper: restore startBinding/endBinding/boundElements after convertToExcalidrawElements strips them
const restoreBindings = (
  convertedElements: readonly any[],
  originalElements: Partial<ExcalidrawElement>[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }

  return convertedElements.map((el: any) => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;

    const patched = { ...el };

    if (orig.startBinding && !el.startBinding) {
      patched.startBinding = orig.startBinding;
    }
    if (orig.endBinding && !el.endBinding) {
      patched.endBinding = orig.endBinding;
    }
    if (orig.boundElements && (!el.boundElements || el.boundElements.length === 0)) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && el.elbowed === undefined) {
      patched.elbowed = orig.elbowed;
    }

    return patched;
  });
};

const convertElementsPreservingImageProps = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  if (elements.length === 0) return []

  const validatedElements = validateAndFixBindings(elements)
  const imageElements = validatedElements.filter(isImageElement).map(normalizeImageElement)
  const nonImageElements = validatedElements.filter(el => !isImageElement(el))
  // convertToExcalidrawElements may expand labeled shapes into [shape, textElement],
  // so we cannot assume a 1:1 mapping — return all converted elements directly.
  const convertedNonImageElements = convertToExcalidrawElements(nonImageElements as any, { regenerateIds: false })
  const restoredNonImageElements = restoreBindings(convertedNonImageElements, nonImageElements)
  return recenterBoundShapeTextElements([...restoredNonImageElements, ...imageElements])
}

function BoardNotFound(): JSX.Element {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#444',
      textAlign: 'center',
      padding: '24px'
    }}>
      <div>
        <h1 style={{ fontSize: 28, marginBottom: 8 }}>Board not found</h1>
        <p style={{ color: '#666' }}>This URL doesn't point to a valid board. Check your share link.</p>
      </div>
    </div>
  )
}

function App(): JSX.Element {
  if (!ROOM_ID) return <BoardNotFound />
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  // Ref so WS message handlers (captured in stale closures) always see the latest API instance
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)

  // Track which file binary IDs we've already uploaded to the server, so each sync only
  // POSTs the binaries the server doesn't have yet (and we never re-upload on every change).
  const uploadedFileIdsRef = useRef<Set<string>>(new Set())

  // Camera (scroll/zoom) is per-viewer, not part of room state — each device should
  // remember where IT was looking. localStorage keyed by roomId.
  const VIEW_LS_KEY = `excalidraw-view:${ROOM_ID}`
  const viewSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewRestoredRef = useRef<boolean>(false)

  const saveViewToLocalStorage = (appState: { scrollX?: number; scrollY?: number; zoom?: { value?: number } | number } | null | undefined): void => {
    if (!appState || !ROOM_ID) return
    if (viewSaveTimerRef.current) clearTimeout(viewSaveTimerRef.current)
    viewSaveTimerRef.current = setTimeout(() => {
      try {
        const zoomVal = typeof appState.zoom === 'number' ? appState.zoom : appState.zoom?.value
        localStorage.setItem(VIEW_LS_KEY, JSON.stringify({
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: zoomVal,
        }))
      } catch {}
    }, 400)
  }

  // Sync state management
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncInFlightRef = useRef<boolean>(false)
  const suppressAutoSyncCountRef = useRef<number>(0)
  const userInteractedRef = useRef<boolean>(false)

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    api.updateScene(scene)
    setTimeout(() => {
      suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
    }, 0)
  }

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
    }
  }, [])

  // Flush pending sync when the user is about to leave / reload / hide the tab.
  // Auto-sync debounces 1.2s after the last edit; without this hook a quick reload
  // after a drag would lose the change. sendBeacon is the canonical mechanism for
  // unload-time POSTs and is honored by browsers even after the page begins tearing down.
  useEffect(() => {
    const flush = (): void => {
      const api = excalidrawAPIRef.current
      if (!api) return
      // Cancel any pending debounced sync — we're firing it now.
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
        autoSyncTimerRef.current = null
      }

      const activeElements = api.getSceneElements().filter(el => !el.isDeleted)
      const payload = JSON.stringify({
        elements: activeElements.map(e => ({ ...e })),
        timestamp: new Date().toISOString(),
      })
      try {
        const blob = new Blob([payload], { type: 'application/json' })
        navigator.sendBeacon(`${API_BASE}/elements/sync`, blob)
      } catch (e) {
        console.warn('Beacon sync failed:', e)
      }

      // Also flush any newly-attached file binaries that haven't been uploaded yet.
      const files = api.getFiles?.() || {}
      const newFiles: any[] = []
      for (const [id, f] of Object.entries(files) as [string, any][]) {
        if (uploadedFileIdsRef.current.has(id)) continue
        if (!f || !f.dataURL) continue
        newFiles.push({
          id,
          dataURL: f.dataURL,
          mimeType: f.mimeType || 'image/png',
          created: typeof f.created === 'number' ? f.created : Date.now(),
        })
      }
      if (newFiles.length > 0) {
        try {
          const blob = new Blob([JSON.stringify({ files: newFiles })], { type: 'application/json' })
          navigator.sendBeacon(`${API_BASE}/files`, blob)
        } catch (e) {
          console.warn('Beacon files flush failed:', e)
        }
      }
    }

    const onVisibility = (): void => { if (document.hidden) flush() }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
  }, [])

  // Load existing elements when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements()

      // Restore camera (scroll/zoom) from localStorage once, after first API attach.
      if (!viewRestoredRef.current) {
        viewRestoredRef.current = true
        try {
          const raw = localStorage.getItem(VIEW_LS_KEY)
          if (raw) {
            const v = JSON.parse(raw)
            if (typeof v.scrollX === 'number' && typeof v.scrollY === 'number') {
              const appStatePatch: any = {
                scrollX: v.scrollX,
                scrollY: v.scrollY,
              }
              if (typeof v.zoom === 'number') appStatePatch.zoom = { value: v.zoom }
              suppressAutoSyncCountRef.current += 1
              excalidrawAPI.updateScene({ appState: appStatePatch })
              setTimeout(() => {
                suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
              }, 0)
            }
          }
        } catch {}
      }

      // Ensure WebSocket is connected for real-time updates
      if (!isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected])

  // Guard against non-JSON responses (Cloudflare 502 HTML during canvas restart, etc.):
  // peek at status + content-type before parsing as JSON. Returns null on any non-JSON case.
  const fetchJsonSafely = async (url: string): Promise<any | null> => {
    try {
      const r = await fetch(url)
      if (!r.ok) return null
      const ct = r.headers.get('content-type') || ''
      if (!ct.toLowerCase().includes('application/json')) return null
      return await r.json()
    } catch {
      return null
    }
  }

  const loadExistingElements = async (): Promise<void> => {
    const result = await fetchJsonSafely(`${API_BASE}/elements`) as ApiResponse | null
    if (result && result.success && result.elements && result.elements.length > 0) {
      const cleanedElements = result.elements.map(cleanElementForExcalidraw)
      const convertedElements = convertElementsPreservingImageProps(cleanedElements)
      if (excalidrawAPI) {
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: convertedElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }
    }

    const filesResult = await fetchJsonSafely(`${API_BASE}/files`) as ApiResponse | null
    if (filesResult && filesResult.files) {
      excalidrawAPI?.addFiles(Object.values(filesResult.files))
      // Seed the uploaded-set with whatever the server already has, so we don't re-upload on first sync.
      for (const id of Object.keys(filesResult.files)) {
        uploadedFileIdsRef.current.add(id)
      }
    }
  }

  // Compare Excalidraw's in-memory BinaryFiles against uploadedFileIdsRef and POST any
  // new ones. Called from syncToBackend after element sync. Cheap when nothing's new.
  const syncFilesToBackend = async (): Promise<void> => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const allFiles = api.getFiles?.() || {}
    const newFiles: any[] = []
    for (const [id, f] of Object.entries(allFiles) as [string, any][]) {
      if (uploadedFileIdsRef.current.has(id)) continue
      if (!f || !f.dataURL) continue
      newFiles.push({
        id,
        dataURL: f.dataURL,
        mimeType: f.mimeType || 'image/png',
        created: typeof f.created === 'number' ? f.created : Date.now(),
      })
    }
    if (newFiles.length === 0) return
    try {
      const r = await fetch(`${API_BASE}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: newFiles }),
      })
      if (r.ok) {
        for (const f of newFiles) uploadedFileIdsRef.current.add(f.id)
        console.log(`Uploaded ${newFiles.length} file(s) to backend`)
      } else {
        console.warn('File upload failed:', r.status, r.statusText)
      }
    } catch (err) {
      console.warn('File upload error:', err)
    }
  }

  const connectWebSocket = (): void => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/r/${ROOM_ID}`

    websocketRef.current = new WebSocket(wsUrl)

    websocketRef.current.onopen = () => {
      setIsConnected(true)

      if (excalidrawAPI) {
        setTimeout(loadExistingElements, 100)
      }
    }

    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }

    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)

      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }

    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      return
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const mergeAndApplySceneElements = (incomingElements: Partial<ExcalidrawElement>[]): void => {
        if (incomingElements.length === 0) return

        const incomingById = new Map<string, Partial<ExcalidrawElement>>()
        incomingElements.forEach((element) => {
          if (element.id) {
            incomingById.set(element.id, element)
          }
        })

        const mergedElements: Partial<ExcalidrawElement>[] = currentElements.map((element) => {
          const incoming = incomingById.get(element.id)
          if (!incoming) return element
          incomingById.delete(element.id)
          return { ...element, ...incoming }
        })

        mergedElements.push(...incomingById.values())

        const convertedElements = convertElementsPreservingImageProps(mergedElements)
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: convertedElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }

      switch (data.type) {
        case 'initial_elements':
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            const convertedElements = convertElementsPreservingImageProps(cleanedElements)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          // Load files for image elements
          if ((data as any).files) {
            excalidrawAPI.addFiles(Object.values((data as any).files))
          }
          break

        case 'files_added':
          if (Array.isArray((data as any).files)) {
            excalidrawAPI.addFiles((data as any).files)
          }
          break

        case 'element_created':
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            // Rebuild against full scene so text/container bindings remain intact.
            mergeAndApplySceneElements([cleanedNewElement])
          }
          break

        case 'element_updated':
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            // Convert with full scene context so text metrics/container placement can refresh.
            mergeAndApplySceneElements([cleanedUpdatedElement])
          }
          break

        case 'element_deleted':
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'elements_batch_created':
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            mergeAndApplySceneElements(cleanedBatchElements)
          }
          break

        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          // Sync confirmation already handled by HTTP response
          break

        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break

        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          break

        case 'export_image_request':
          if (data.requestId) {
            try {
              const elements = excalidrawAPI.getSceneElements()
              const appState = excalidrawAPI.getAppState()
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch(`${API_BASE}/export/image/result`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch(`${API_BASE}/export/image/result`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch(`${API_BASE}/export/image/result`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => { })
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch(`${API_BASE}/export/image/result`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => { })
                }
                reader.readAsDataURL(blob)
              }
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch(`${API_BASE}/export/image/result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements()
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, { fitToViewport: true, animate: true })
                }
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], { fitToViewport: false, animate: true })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                // Direct zoom/scroll control
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState })
                }
              }

              await fetch(`${API_BASE}/viewport/result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch(`${API_BASE}/viewport/result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => { })
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: false })
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  excalidrawAPI.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  // Data format conversion for backend
  const convertToBackendFormat = (element: ExcalidrawElement): ServerElement => {
    return {
      ...element
    } as ServerElement
  }

  // Format sync time display
  const formatSyncTime = (time: Date | null): string => {
    if (!time) return ''
    return time.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  // Main sync function
  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options

    if (!excalidrawAPI) {
      console.warn('Excalidraw API not available')
      return
    }

    if (syncInFlightRef.current) {
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    syncInFlightRef.current = true
    if (!silent) {
      setSyncStatus('syncing')
    }

    try {
      // 1. Get current elements
      const currentElements = excalidrawAPI.getSceneElements()
      console.log(`Syncing ${currentElements.length} elements to backend`)

      // Filter out deleted elements
      const activeElements = currentElements.filter(el => !el.isDeleted)

      // 3. Convert to backend format
      const backendElements = activeElements.map(convertToBackendFormat)

      // 4. Send to backend
      const response = await fetch(`${API_BASE}/elements/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          elements: backendElements,
          timestamp: new Date().toISOString()
        })
      })

      if (response.ok) {
        const result: ApiResponse = await response.json()
        setLastSyncTime(new Date())
        console.log(`Sync successful: ${result.count} elements synced`)

        // After elements are synced, push any new file binaries (image dataURLs) the
        // server doesn't have yet. Without this, imported scenes with images render
        // in-memory but the binaries vanish on the next reload.
        await syncFilesToBackend()

        if (!silent) {
          setSyncStatus('success')
          // Reset status after 2 seconds
          setTimeout(() => setSyncStatus('idle'), 2000)
        }
      } else {
        const error: ApiResponse = await response.json()
        console.error('Sync failed:', error.error)
        if (!silent) {
          setSyncStatus('error')
        }
      }
    } catch (error) {
      console.error('Sync error:', error)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
    }
  }

  // Tracks scene size from the previous onChange so we can detect large bulk
  // additions (imports, paste-large-scene) and bypass the debounce.
  const lastSceneCountRef = useRef<number>(0)

  const scheduleAutoSync = (immediate: boolean = false): void => {
    if (!isConnected || !excalidrawAPI) {
      return
    }
    if (!userInteractedRef.current && !immediate) {
      return
    }
    if (suppressAutoSyncCountRef.current > 0) {
      return
    }
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }

    // Bulk additions (imports) get a near-zero delay so they're persisted before any
    // reload. Normal edits keep the 1.2s debounce so we don't hammer the server.
    const delay = immediate ? 50 : AUTO_SYNC_DEBOUNCE_MS

    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      if (suppressAutoSyncCountRef.current > 0 || syncInFlightRef.current) {
        return
      }
      void syncToBackend({ silent: true })
    }, delay)
  }

  const clearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        // Get all current elements and delete them from backend
        const response = await fetch(`${API_BASE}/elements`)
        const result: ApiResponse = await response.json()

        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element =>
            fetch(`${API_BASE}/elements/${element.id}`, { method: 'DELETE' })
          )
          await Promise.all(deletePromises)
        }

        // Clear the frontend canvas
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        // Still clear frontend even if backend fails
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <h1>Excalidraw Canvas</h1>
        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <div className="sync-status">
            {syncStatus === 'syncing' && <span className="sync-time">Syncing…</span>}
            {syncStatus === 'error' && <span className="sync-error">Sync failed</span>}
            {lastSyncTime && syncStatus !== 'syncing' && syncStatus !== 'error' && (
              <span className="sync-time">Last sync: {formatSyncTime(lastSyncTime)}</span>
            )}
          </div>
        </div>
      </div>

      {/* Canvas Container */}
      <div className="canvas-container">
        <div
          onPointerDownCapture={() => {
            userInteractedRef.current = true
          }}
          onKeyDownCapture={() => {
            userInteractedRef.current = true
          }}
          style={{ width: '100%', height: '100%' }}
        >
          <Excalidraw
            excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
            onChange={(elements, appState, files) => {
              // Heuristic: if elements grew by >5 in one onChange OR new files appeared,
              // it's almost certainly an import / paste / undo-of-large-deletion. Fire
              // sync immediately instead of waiting for the 1.2s debounce, otherwise a
              // quick reload would lose it (sendBeacon caps at 64KB so big payloads
              // can't be salvaged via unload-flush alone).
              const prev = lastSceneCountRef.current
              const next = elements.length
              const delta = next - prev
              const sceneFilesCount = files ? Object.keys(files).length : 0
              const newFiles = sceneFilesCount > uploadedFileIdsRef.current.size
              const immediate = delta > 5 || newFiles
              lastSceneCountRef.current = next
              userInteractedRef.current = true   // bulk additions count as intent
              scheduleAutoSync(immediate)
              saveViewToLocalStorage(appState as any)
            }}
            initialData={{
              elements: [],
              appState: {
                theme: 'light',
                viewBackgroundColor: '#ffffff'
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}

export default App
