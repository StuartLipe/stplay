import type { Channel, ContentKind } from '../types'

const DB_NAME = 'sturplay-catalog-v1'
const STORE = 'catalog'
const DB_VERSION = 1

type CatalogRecord = {
  key: string
  playlistId: string
  kind: ContentKind
  items: Channel[]
  savedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('playlistId', 'playlistId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function recordKey(playlistId: string, kind: ContentKind) {
  return `${playlistId}:${kind}`
}

export async function loadDiskCatalog(
  playlistId: string,
  kind: ContentKind,
): Promise<Channel[] | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(recordKey(playlistId, kind))
      req.onsuccess = () => {
        const row = req.result as CatalogRecord | undefined
        resolve(row?.items?.length ? row.items : null)
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

export async function saveDiskCatalog(
  playlistId: string,
  kind: ContentKind,
  items: Channel[],
): Promise<void> {
  if (!items.length) return
  try {
    const db = await openDb()
    const row: CatalogRecord = {
      key: recordKey(playlistId, kind),
      playlistId,
      kind,
      items,
      savedAt: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(row)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // quota / private mode — ignora
  }
}

export async function clearDiskCatalog(playlistId?: string, kind?: ContentKind): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      if (!playlistId) {
        store.clear()
      } else if (kind) {
        store.delete(recordKey(playlistId, kind))
      } else {
        const index = store.index('playlistId')
        const req = index.openCursor(IDBKeyRange.only(playlistId))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          cursor.delete()
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // ignore
  }
}
