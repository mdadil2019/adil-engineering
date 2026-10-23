import { useEffect, useRef, useState } from "react";
import { fileOpen, fileSave } from "browser-fs-access";
import { createStore, get, set } from "idb-keyval";
import { debounce } from "@excalidraw/common";
import { isInitializedImageElement } from "@excalidraw/element";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";

import { useAtomValue } from "../app-jotai";
import { isCollaboratingAtom } from "../collab/Collab";
import { LocalData } from "../data/LocalData";
import { importFromLocalStorage } from "../data/localStorage";
import { useHandleAppTheme } from "../useHandleAppTheme";

import {
  createCanvas,
  createCollection,
  createWorkspace,
  parseWorkspace,
  serializeWorkspace,
  snapshotScene,
} from "./workspace";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

import type { ReactNode } from "react";

import type { Workspace, WorkspaceScene } from "./workspace";

const cacheStore = createStore("excalidraw-workspace", "workspace");
const CACHE_KEY = "current";

type WorkspaceCache = {
  document: string;
  dirty: boolean;
  fileName: string | null;
  fileHandle: FileSystemFileHandle | null;
};

export type WorkspaceEditorProps = {
  initialScene: WorkspaceScene;
  loadInitialSceneFromURL: boolean;
  onWorkspaceChange: NonNullable<ExcalidrawProps["onChange"]>;
  onWorkspaceReady: (api: ExcalidrawImperativeAPI) => void;
  busy: boolean;
  theme: ReturnType<typeof useHandleAppTheme>;
};

const findCanvas = (workspace: Workspace, id = workspace.activeCanvasId) =>
  workspace.collections
    .flatMap((collection) => collection.canvases)
    .find((canvas) => canvas.id === id);

const migrateCurrentCanvas = async () => {
  const previous = importFromLocalStorage();
  const fileIds = previous.elements
    .filter(isInitializedImageElement)
    .map((element) => element.fileId);
  const { loadedFiles } = await LocalData.fileStorage.getFiles(fileIds);
  return createWorkspace({
    elements: previous.elements,
    appState: previous.appState || {},
    files: Object.fromEntries(loadedFiles.map((file) => [file.id, file])),
  });
};

export const WorkspaceApp = ({
  renderEditor,
}: {
  renderEditor: (props: WorkspaceEditorProps, key: string) => ReactNode;
}) => {
  const theme = useHandleAppTheme();
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  const rootRef = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  const [dirty, setDirty] = useState(true);
  const dirtyRef = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileNameRef = useRef<string | null>(null);
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const cacheBlockedRef = useRef(false);
  const editorRef = useRef<{
    id: string;
    api: ExcalidrawImperativeAPI;
  } | null>(null);
  // Opening a file can reuse canvas IDs, so it also gets a fresh editor mount.
  const [generation, setGeneration] = useState(0);
  const sceneJSONRef = useRef("");
  const initialURLPendingRef = useRef(true);
  const writeQueueRef = useRef(Promise.resolve());

  const markDirty = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };

  const cacheWorkspace = () => {
    if (!workspaceRef.current || cacheBlockedRef.current) {
      return;
    }
    let document: string;
    try {
      // Keep the last complete recovery copy while an image is loading.
      document = serializeWorkspace(workspaceRef.current);
    } catch {
      return;
    }
    const cache: WorkspaceCache = {
      document,
      dirty: dirtyRef.current,
      fileName: fileNameRef.current,
      fileHandle: fileHandleRef.current,
    };
    // Serialize IDB writes so an earlier save cannot replace newer edits.
    writeQueueRef.current = writeQueueRef.current
      .then(() => set(CACHE_KEY, cache, cacheStore))
      .catch(() => {
        setError(
          "Browser recovery could not be saved. Save your workspace to disk.",
        );
      });
  };

  const captureCurrentCanvas = () => {
    const current = workspaceRef.current;
    const editor = editorRef.current;
    if (
      !current ||
      !editor ||
      editor.id !== current.activeCanvasId ||
      editor.api.isDestroyed ||
      editor.api.getAppState().isLoading
    ) {
      return;
    }
    const canvas = findCanvas(current);
    if (!canvas) {
      return;
    }
    const scene = snapshotScene(
      editor.api.getSceneElements(),
      editor.api.getAppState(),
      editor.api.getFiles(),
    );
    const json = JSON.stringify(scene);
    if (json !== sceneJSONRef.current) {
      canvas.scene = scene;
      sceneJSONRef.current = json;
      markDirty(true);
    }
  };

  // The callback reads refs, so drawing does not rerender the collection list.
  const flushRef = useRef(() => {});
  flushRef.current = () => {
    captureCurrentCanvas();
    cacheWorkspace();
  };
  const [scheduleSave] = useState(() =>
    debounce(() => flushRef.current(), 300),
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let recovered: Workspace | null = null;
      let cache: WorkspaceCache | undefined;
      try {
        cache = await get<WorkspaceCache>(CACHE_KEY, cacheStore);
        if (cache) {
          recovered = parseWorkspace(cache.document);
        }
      } catch {
        if (!cancelled) {
          // Never overwrite an unreadable recovery copy with the fallback.
          cacheBlockedRef.current = true;
          setError(
            "Could not restore the browser copy. You can open your saved workspace file.",
          );
        }
      }
      const initial = recovered || (await migrateCurrentCanvas());
      if (cancelled) {
        return;
      }
      workspaceRef.current = initial;
      setWorkspace(initial);
      if (recovered && cache) {
        dirtyRef.current = cache.dirty;
        setDirty(cache.dirty);
        fileHandleRef.current = cache.fileHandle;
        fileNameRef.current = cache.fileName;
        setFileName(cache.fileName);
      }
    };
    load().catch(() => {
      if (!cancelled) {
        setError(
          "Could not load the previous drawing. Open a saved workspace to continue.",
        );
        const initial = createWorkspace();
        workspaceRef.current = initial;
        setWorkspace(initial);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerDocument || !ownerWindow) {
      return;
    }
    const flush = () => scheduleSave.flush();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      captureCurrentCanvas();
      scheduleSave.flush();
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    ownerDocument.addEventListener("visibilitychange", flush);
    ownerWindow.addEventListener("pagehide", flush);
    ownerWindow.addEventListener("beforeunload", beforeUnload);
    return () => {
      scheduleSave.flush();
      scheduleSave.cancel();
      ownerDocument.removeEventListener("visibilitychange", flush);
      ownerWindow.removeEventListener("pagehide", flush);
      ownerWindow.removeEventListener("beforeunload", beforeUnload);
    };
    // Event handlers read the current workspace and editor from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleSave]);

  const updateWorkspace = (next: Workspace) => {
    workspaceRef.current = next;
    setWorkspace(next);
    markDirty(true);
    cacheWorkspace();
  };

  const selectCanvas = (id: string) => {
    const current = workspaceRef.current;
    if (!current || current.activeCanvasId === id || !findCanvas(current, id)) {
      return;
    }
    scheduleSave.cancel();
    captureCurrentCanvas();
    editorRef.current = null;
    updateWorkspace({ ...current, activeCanvasId: id });
  };

  const addCollection = (name: string) => {
    const current = workspaceRef.current;
    if (!current || !name.trim()) {
      return;
    }
    captureCurrentCanvas();
    updateWorkspace({
      ...current,
      collections: [...current.collections, createCollection(name)],
    });
  };

  const addCanvas = (collectionId: string, name: string) => {
    const current = workspaceRef.current;
    if (!current || !name.trim()) {
      return;
    }
    scheduleSave.cancel();
    captureCurrentCanvas();
    const canvas = createCanvas(name);
    editorRef.current = null;
    updateWorkspace({
      ...current,
      activeCanvasId: canvas.id,
      collections: current.collections.map((collection) =>
        collection.id === collectionId
          ? { ...collection, canvases: [...collection.canvases, canvas] }
          : collection,
      ),
    });
  };

  const saveWorkspace = async () => {
    if (busy || !workspaceRef.current) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      scheduleSave.cancel();
      captureCurrentCanvas();
      const document = serializeWorkspace(workspaceRef.current);
      const handle = await fileSave(
        new Blob([document], { type: "application/json" }),
        {
          fileName:
            fileNameRef.current || "My workspace.excalidraw-workspace.json",
          extensions: [".json"],
          description: "Excalidraw workspace",
        },
        fileHandleRef.current,
      );
      fileHandleRef.current = handle;
      cacheBlockedRef.current = false;
      fileNameRef.current =
        handle?.name ||
        fileNameRef.current ||
        "My workspace.excalidraw-workspace.json";
      setFileName(fileNameRef.current);
      captureCurrentCanvas();
      markDirty(serializeWorkspace(workspaceRef.current) !== document);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setError(
          (error as Error).message || "The workspace could not be saved.",
        );
      }
    } finally {
      captureCurrentCanvas();
      cacheWorkspace();
      setBusy(false);
    }
  };

  const openWorkspace = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const file = await fileOpen({
        extensions: [".json"],
        mimeTypes: ["application/json"],
        description: "Excalidraw workspace",
      });
      const next = parseWorkspace(await file.text());
      captureCurrentCanvas();
      const ownerWindow = rootRef.current?.ownerDocument.defaultView;
      if (
        dirtyRef.current &&
        !ownerWindow?.confirm(
          "Open this workspace and replace your current workspace? Changes not saved to a file will be lost.",
        )
      ) {
        return;
      }
      scheduleSave.cancel();
      editorRef.current = null;
      workspaceRef.current = next;
      cacheBlockedRef.current = false;
      setWorkspace(next);
      setGeneration((value) => value + 1);
      fileHandleRef.current = file.handle || null;
      fileNameRef.current = file.name;
      setFileName(file.name);
      markDirty(false);
      cacheWorkspace();
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setError(
          (error as Error).message || "The workspace could not be opened.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const activeCanvas = workspace && findCanvas(workspace);
  const activeCollection = workspace?.collections.find((collection) =>
    collection.canvases.some(
      (canvas) => canvas.id === workspace.activeCanvasId,
    ),
  );

  return (
    <div
      ref={rootRef}
      className={`excalidraw workspace-shell${
        theme.editorTheme === "dark" ? " theme--dark" : ""
      }`}
    >
      <WorkspaceSidebar
        workspace={workspace}
        dirty={dirty}
        busy={busy}
        disabled={isCollaborating}
        fileName={fileName}
        onAddCollection={addCollection}
        onAddCanvas={addCanvas}
        onSelectCanvas={selectCanvas}
        onSave={saveWorkspace}
        onOpen={openWorkspace}
      />
      <div className="workspace-content">
        {activeCanvas && (
          <div className="workspace-breadcrumb" aria-label="Current canvas">
            <span>{activeCollection?.name}</span>
            <span aria-hidden="true"> / </span>
            <strong>{activeCanvas.name}</strong>
          </div>
        )}
        {error && (
          <div className="workspace-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Dismiss workspace error"
            >
              ×
            </button>
          </div>
        )}
        {activeCanvas ? (
          renderEditor(
            {
              initialScene: {
                ...activeCanvas.scene,
                appState: {
                  ...activeCanvas.scene.appState,
                  name: activeCanvas.name,
                },
              },
              loadInitialSceneFromURL: initialURLPendingRef.current,
              onWorkspaceChange: (_elements, appState) => {
                if (
                  !appState.isLoading &&
                  editorRef.current?.id === activeCanvas.id
                ) {
                  scheduleSave();
                }
              },
              onWorkspaceReady: (api) => {
                if (workspaceRef.current?.activeCanvasId !== activeCanvas.id) {
                  return;
                }
                editorRef.current = { id: activeCanvas.id, api };
                const location =
                  rootRef.current?.ownerDocument.defaultView?.location;
                if (
                  initialURLPendingRef.current &&
                  location &&
                  (new URLSearchParams(location.search).has("id") ||
                    /^#(?:json|url|room)=/.test(location.hash))
                ) {
                  markDirty(true);
                }
                initialURLPendingRef.current = false;
                activeCanvas.scene = snapshotScene(
                  api.getSceneElements(),
                  api.getAppState(),
                  api.getFiles(),
                );
                sceneJSONRef.current = JSON.stringify(activeCanvas.scene);
              },
              busy,
              theme,
            },
            `${generation}:${activeCanvas.id}`,
          )
        ) : (
          <div className="workspace-empty">
            {workspace
              ? "Add a canvas to a collection to start drawing."
              : "Opening workspace…"}
          </div>
        )}
      </div>
    </div>
  );
};
