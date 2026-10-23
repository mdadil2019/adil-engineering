import { useEffect, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";

import { newElement, newImageElement } from "@excalidraw/element";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { WorkspaceApp } from "./WorkspaceApp";
import {
  createCanvas,
  createWorkspace,
  parseWorkspace,
  serializeWorkspace,
} from "./workspace";

import type { WorkspaceEditorProps } from "./WorkspaceApp";
import type { Workspace, WorkspaceScene } from "./workspace";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  fileOpen: vi.fn(),
  fileSave: vi.fn(),
}));

vi.mock("idb-keyval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("idb-keyval")>()),
  createStore: vi.fn(() => ({})),
  get: mocks.get,
  set: mocks.set,
}));

vi.mock("browser-fs-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("browser-fs-access")>()),
  fileOpen: mocks.fileOpen,
  fileSave: mocks.fileSave,
}));

vi.mock("../app-jotai", () => ({ useAtomValue: () => false }));
vi.mock("../collab/Collab", () => ({ isCollaboratingAtom: {} }));
vi.mock("../data/LocalData", () => ({
  LocalData: { fileStorage: { getFiles: vi.fn() } },
}));
vi.mock("../data/localStorage", () => ({
  importFromLocalStorage: vi.fn(() => ({ elements: [], appState: {} })),
}));
vi.mock("../useHandleAppTheme", () => ({
  useHandleAppTheme: () => ({
    editorTheme: "light",
    appTheme: "light",
    setAppTheme: vi.fn(),
  }),
}));

type EditorController = {
  readonly scene: WorkspaceScene;
  change: (scene: Partial<WorkspaceScene>) => void;
};

let editor: EditorController | null = null;

// Match the editor's imperative contract and keyed lifetime. Drawing updates
// the API immediately, before the workspace's recovery debounce runs.
const TestEditor = (props: WorkspaceEditorProps) => {
  const sceneRef = useRef<WorkspaceScene>({
    ...props.initialScene,
    appState: { ...getDefaultAppState(), ...props.initialScene.appState },
  });
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const api = {
      getSceneElements: () => sceneRef.current.elements,
      getAppState: () => sceneRef.current.appState,
      getFiles: () => sceneRef.current.files,
      isDestroyed: false,
    } as ExcalidrawImperativeAPI;
    const controller: EditorController = {
      get scene() {
        return sceneRef.current;
      },
      change: (scene) => {
        sceneRef.current = { ...sceneRef.current, ...scene };
        callbacks.current.onWorkspaceChange(
          sceneRef.current.elements as Parameters<
            WorkspaceEditorProps["onWorkspaceChange"]
          >[0],
          sceneRef.current.appState as AppState,
          sceneRef.current.files,
        );
      },
    };
    editor = controller;
    callbacks.current.onWorkspaceReady(api);
    return () => {
      if (editor === controller) {
        editor = null;
      }
    };
  }, []);

  return <div data-testid="workspace-test-editor" />;
};

const makeWorkspace = () => {
  const workspace = createWorkspace();
  workspace.collections[0].name = "HexaVision";
  workspace.collections[0].canvases[0].name = "DB Design";
  workspace.collections[0].canvases.push(createCanvas("API Schema"));
  return workspace;
};

const mountWorkspace = async (workspace: Workspace, dirty = false) => {
  mocks.get.mockResolvedValue({
    document: serializeWorkspace(workspace),
    dirty,
    fileName: "HexaVision.excalidraw-workspace.json",
    fileHandle: null,
  });
  render(
    <WorkspaceApp
      renderEditor={(props, key) => <TestEditor {...props} key={key} />}
    />,
  );
  await screen.findByRole("button", { name: "DB Design" });
  await waitFor(() => expect(editor).not.toBeNull());
};

const readBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

describe("WorkspaceApp persistence integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.set.mockResolvedValue(undefined);
    editor = null;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("captures the current drawing when switching before the recovery debounce", async () => {
    await mountWorkspace(makeWorkspace());
    const rectangle = newElement({
      type: "rectangle",
      x: 5,
      y: 10,
      width: 120,
      height: 80,
    });
    vi.useFakeTimers();
    act(() => editor!.change({ elements: [rectangle] }));
    expect(mocks.set).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "API Schema" }));
    expect(editor!.scene.elements).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "DB Design" }));
    expect(editor!.scene.elements).toEqual([rectangle]);
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");

    await act(async () => {});
    const cached = mocks.set.mock.calls.at(-1)![1];
    const recovered = parseWorkspace(cached.document);
    expect(recovered.collections[0].canvases[0].scene.elements[0].id).toBe(
      rectangle.id,
    );
  });

  it("saves all canvases, embedded images, and the latest active drawing in one file", async () => {
    const workspace = makeWorkspace();
    const fileId = "embedded-image" as FileId;
    const files: BinaryFiles = {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,aW1hZ2U=" as DataURL,
        created: 123,
      },
    };
    workspace.collections[0].canvases[0].scene = {
      elements: [
        newImageElement({
          type: "image",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          fileId,
        }),
      ],
      appState: {},
      files,
    };
    const handle = { name: "Saved workspace.json" } as FileSystemFileHandle;
    mocks.fileSave.mockResolvedValue(handle);
    await mountWorkspace(workspace);
    fireEvent.click(screen.getByRole("button", { name: "API Schema" }));
    const rectangle = newElement({
      type: "rectangle",
      x: 10,
      y: 20,
      width: 100,
      height: 100,
    });
    act(() => editor!.change({ elements: [rectangle] }));
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Saved to disk"),
    );
    expect(mocks.fileSave).toHaveBeenCalledTimes(1);
    const saved = parseWorkspace(
      await readBlob(mocks.fileSave.mock.calls[0][0]),
    );
    expect(saved.collections[0].name).toBe("HexaVision");
    expect(saved.collections[0].canvases.map(({ name }) => name)).toEqual([
      "DB Design",
      "API Schema",
    ]);
    expect(saved.collections[0].canvases[0].scene.files).toEqual(files);
    expect(saved.collections[0].canvases[1].scene.elements[0].id).toBe(
      rectangle.id,
    );
    expect(saved.activeCanvasId).toBe(workspace.collections[0].canvases[1].id);
    expect(screen.getByText("Saved workspace.json")).toBeInTheDocument();
  });

  it("keeps changes dirty when the user cancels the save picker", async () => {
    mocks.fileSave.mockRejectedValue(
      new DOMException("Cancelled", "AbortError"),
    );
    await mountWorkspace(makeWorkspace());
    const rectangle = newElement({
      type: "rectangle",
      x: 1,
      y: 2,
      width: 30,
      height: 40,
    });
    act(() => editor!.change({ elements: [rectangle] }));
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save workspace" }),
      ).toBeEnabled(),
    );
    expect(mocks.fileSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(editor!.scene.elements[0].id).toBe(rectangle.id);
  });

  it("preserves the current workspace and drawing when an imported file is invalid", async () => {
    mocks.fileOpen.mockResolvedValue({
      name: "invalid.json",
      text: async () =>
        '{"type":"excalidraw-workspace","version":1,"collections":"invalid"}',
    });
    const confirm = vi.spyOn(window, "confirm");
    await mountWorkspace(makeWorkspace(), true);
    const rectangle = newElement({
      type: "rectangle",
      x: 1,
      y: 2,
      width: 30,
      height: 40,
    });
    act(() => editor!.change({ elements: [rectangle] }));
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not a valid Excalidraw workspace",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(editor!.scene.elements[0].id).toBe(rectangle.id);
    expect(screen.getByRole("button", { name: "DB Design" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "API Schema" })).toBeEnabled();
    expect(
      screen.getByText("HexaVision.excalidraw-workspace.json"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });
});
