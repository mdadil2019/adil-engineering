import { nanoid } from "nanoid";

import {
  clearAppStateForLocalStorage,
  getDefaultAppState,
} from "@excalidraw/excalidraw/appState";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export type WorkspaceScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

export type WorkspaceCanvas = {
  id: string;
  name: string;
  scene: WorkspaceScene;
};

export type WorkspaceCollection = {
  id: string;
  name: string;
  canvases: WorkspaceCanvas[];
};

export type Workspace = {
  type: "excalidraw-workspace";
  version: 1;
  collections: WorkspaceCollection[];
  activeCanvasId: string | null;
};

const cleanSceneAppState = (appState: Partial<AppState>): Partial<AppState> => {
  const state = clearAppStateForLocalStorage(appState);
  // These browser preferences describe a live interaction, not the canvas.
  delete state.cursorButton;
  delete state.editingGroupId;
  delete state.openMenu;
  delete state.openSidebar;
  delete state.previousSelectedElementIds;
  delete state.selectedElementIds;
  delete state.selectedGroupIds;
  delete state.selectedLinearElement;
  return state;
};

/** Take a detached snapshot, including image data used by this canvas. */
export const snapshotScene = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): WorkspaceScene => {
  const exported = JSON.parse(
    serializeAsJSON(
      elements.filter((element) => !element.isDeleted),
      appState,
      files,
      "local",
    ),
  );
  return {
    elements: exported.elements,
    appState: JSON.parse(JSON.stringify(cleanSceneAppState(appState))),
    files: exported.files,
  };
};

export const createCanvas = (
  name = "Untitled",
  scene?: WorkspaceScene,
): WorkspaceCanvas => ({
  id: nanoid(),
  name: name.trim() || "Untitled",
  scene: scene
    ? snapshotScene(scene.elements, scene.appState, scene.files)
    : { elements: [], appState: {}, files: {} },
});

export const createCollection = (name: string): WorkspaceCollection => ({
  id: nanoid(),
  name: name.trim() || "Untitled collection",
  canvases: [],
});

export const createWorkspace = (initialScene?: WorkspaceScene): Workspace => {
  const canvas = createCanvas("Untitled", initialScene);
  const collection = createCollection("My collection");
  collection.canvases.push(canvas);
  return {
    type: "excalidraw-workspace",
    version: 1,
    collections: [collection],
    activeCanvasId: canvas.id,
  };
};

const assertCompleteScene = (scene: WorkspaceScene) => {
  for (const element of scene.elements) {
    if (
      !element.isDeleted &&
      element.type === "image" &&
      element.fileId &&
      !Object.prototype.hasOwnProperty.call(scene.files, element.fileId)
    ) {
      throw new Error(
        "An image has not finished loading. Wait for it to load before saving the workspace.",
      );
    }
  }
};

export const serializeWorkspace = (workspace: Workspace): string => {
  const collections = workspace.collections.map((collection) => ({
    ...collection,
    canvases: collection.canvases.map((canvas) => {
      assertCompleteScene(canvas.scene);
      return {
        ...canvas,
        scene: snapshotScene(
          canvas.scene.elements,
          canvas.scene.appState,
          canvas.scene.files,
        ),
      };
    }),
  }));
  return JSON.stringify({ ...workspace, collections }, null, 2);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();

const invalidWorkspace = (): never => {
  throw new Error("This file is not a valid Excalidraw workspace.");
};

const parseScene = (value: unknown): WorkspaceScene => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.elements) ||
    !isRecord(value.appState) ||
    !isRecord(value.files)
  ) {
    return invalidWorkspace();
  }

  const elementIds = new Set<string>();
  for (const element of value.elements) {
    if (
      !isRecord(element) ||
      !isNonEmptyString(element.id) ||
      elementIds.has(element.id) ||
      !isNonEmptyString(element.type) ||
      !["x", "y", "width", "height"].every(
        (key) =>
          typeof element[key] === "number" && Number.isFinite(element[key]),
      )
    ) {
      return invalidWorkspace();
    }
    elementIds.add(element.id);
  }

  for (const [id, file] of Object.entries(value.files)) {
    if (
      !isRecord(file) ||
      file.id !== id ||
      !isNonEmptyString(file.mimeType) ||
      !isNonEmptyString(file.dataURL) ||
      !file.dataURL.startsWith("data:") ||
      typeof file.created !== "number" ||
      !Number.isFinite(file.created)
    ) {
      return invalidWorkspace();
    }
  }

  // Check the shape of persisted settings before passing them to the upstream
  // migration helpers. Unknown settings are discarded by its storage whitelist.
  const defaults = getDefaultAppState();
  const appState = cleanSceneAppState(value.appState);
  for (const [key, setting] of Object.entries(appState)) {
    // A null arrowhead means no arrowhead, even though the default end is
    // "arrow". Grid settings and the other non-null defaults remain required.
    if (
      key === "currentItemStartArrowhead" ||
      key === "currentItemEndArrowhead"
    ) {
      if (setting !== null && typeof setting !== "string") {
        return invalidWorkspace();
      }
      continue;
    }
    const defaultValue = defaults[key as keyof typeof defaults];
    if (
      defaultValue !== undefined &&
      defaultValue !== null &&
      (typeof setting !== typeof defaultValue ||
        (typeof defaultValue === "number" && !Number.isFinite(setting)) ||
        (typeof defaultValue === "object" && !isRecord(setting)))
    ) {
      return invalidWorkspace();
    }
  }
  if (
    appState.zoom !== undefined &&
    (!isRecord(appState.zoom) ||
      typeof appState.zoom.value !== "number" ||
      !Number.isFinite(appState.zoom.value) ||
      appState.zoom.value <= 0)
  ) {
    return invalidWorkspace();
  }

  const elements = restoreElements(
    value.elements as ExcalidrawElement[],
    null,
    { repairBindings: true },
  );
  // Restoration drops unsupported or corrupt elements. Reject the whole file
  // instead of silently opening a workspace with missing drawings.
  if (elements.length !== value.elements.length) {
    return invalidWorkspace();
  }
  const scene = snapshotScene(
    elements,
    restoreAppState(appState, null),
    value.files as BinaryFiles,
  );
  assertCompleteScene(scene);
  return scene;
};

/** Validate the whole file before the caller replaces the current workspace. */
export const parseWorkspace = (json: string): Workspace => {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return invalidWorkspace();
  }
  if (!isRecord(data) || data.type !== "excalidraw-workspace") {
    return invalidWorkspace();
  }
  if (data.version !== 1) {
    throw new Error("This workspace version is not supported.");
  }
  if (!Array.isArray(data.collections)) {
    return invalidWorkspace();
  }

  const collectionIds = new Set<string>();
  const canvasIds = new Set<string>();
  try {
    const collections = data.collections.map((collection) => {
      if (
        !isRecord(collection) ||
        !isNonEmptyString(collection.id) ||
        collectionIds.has(collection.id) ||
        !isNonEmptyString(collection.name) ||
        !Array.isArray(collection.canvases)
      ) {
        return invalidWorkspace();
      }
      collectionIds.add(collection.id);
      return {
        id: collection.id,
        name: collection.name,
        canvases: collection.canvases.map((canvas) => {
          if (
            !isRecord(canvas) ||
            !isNonEmptyString(canvas.id) ||
            canvasIds.has(canvas.id) ||
            !isNonEmptyString(canvas.name)
          ) {
            return invalidWorkspace();
          }
          canvasIds.add(canvas.id);
          return {
            id: canvas.id,
            name: canvas.name,
            scene: parseScene(canvas.scene),
          };
        }),
      };
    });
    if (
      (canvasIds.size > 0 &&
        (!isNonEmptyString(data.activeCanvasId) ||
          !canvasIds.has(data.activeCanvasId))) ||
      (canvasIds.size === 0 && data.activeCanvasId !== null)
    ) {
      return invalidWorkspace();
    }
    return {
      type: "excalidraw-workspace",
      version: 1,
      collections,
      activeCanvasId: data.activeCanvasId as string | null,
    };
  } catch {
    return invalidWorkspace();
  }
};
